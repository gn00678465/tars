import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import type { SecretStore } from "../../core/secrets.ts";
import { libraryBase, scriptsLayout, type LibraryBase } from "./library.ts";
import type { PackageName } from "./lock.ts";
import { parseScriptMeta, ScriptMetaError, type ScriptMeta } from "./metadata.ts";
import type { OsvEndpoint } from "./osv.ts";
import { publishSubmission, type Submission } from "./pending.ts";
import { parseGoogleCredential } from "./google.ts";
import { obtainCommand, readSecretType, secretName, secretUrlHost } from "./secret.ts";
import {
  ensureVenv,
  problemText,
  vetDependencies,
  type PythonVersion,
  type SupplyProblem,
  type Toolchain,
} from "./supply.ts";

export type Gate1Problem =
  /** script.py is not UTF-8, so the text tars checks and the bytes Python runs would differ. */
  | { readonly kind: "encoding" }
  | { readonly kind: "metadata"; readonly detail: string }
  | { readonly kind: "python-excluded"; readonly requires: string; readonly system: PythonVersion }
  | { readonly kind: "python-unsupported"; readonly requires: string }
  /** `obtain` is the command the user runs to store it. */
  | { readonly kind: "secret-missing"; readonly secret: string; readonly obtain: string }
  /** `detail` describes the shape and never holds the value. */
  | {
      readonly kind: "secret-shape";
      readonly secret: string;
      readonly detail: string;
      readonly obtain: string;
    }
  /** A google-oauth secret has no url for "secret:url" to take a host from. */
  | { readonly kind: "secret-oauth-url"; readonly secret: string }
  | { readonly kind: "supply"; readonly problem: SupplyProblem };

export type Gate1 =
  | {
      readonly ok: true;
      readonly submission: Submission;
      /** As of now; approve works them out again, because packages/ and library/ move on. */
      readonly newPackages: readonly PackageName[];
      readonly base: LibraryBase;
    }
  | { readonly ok: false; readonly problems: readonly Gate1Problem[] };

export interface Gate1Context {
  readonly scriptsDir: string;
  readonly secrets: SecretStore;
  readonly toolchain: Toolchain;
  readonly osv: OsvEndpoint;
  readonly now: Date;
}

/**
 * Gate 1 on the bytes of <draftDir>/script.py, read once. Once the metadata parses, the secret
 * check runs beside the Python or the dependency check, so the author sees them in one round.
 */
export async function submit(draftDir: string, ctx: Gate1Context): Promise<Gate1> {
  const path = join(draftDir, "script.py");
  const bytes = await readFile(path).catch(() => {
    throw new TarsError(`no script.py in ${draftDir}; pass the directory that holds the draft`);
  });
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes))
    return { ok: false, problems: [{ kind: "encoding" }] };
  let meta: ScriptMeta;
  try {
    meta = parseScriptMeta(source);
  } catch (err) {
    if (!(err instanceof ScriptMetaError)) throw err;
    return { ok: false, problems: err.problems.map((detail) => ({ kind: "metadata", detail })) };
  }
  const python = pythonProblems(meta, ctx.toolchain.python.version);
  const problems: Gate1Problem[] = [...python, ...(await secretProblems(meta, ctx))];
  // uv lock fails for want of an interpreter when the system Python is excluded (measured on
  // uv 0.13.8), which would only repeat the Python problem as a dependency one.
  if (python.length > 0) return { ok: false, problems };
  let newPackages: readonly PackageName[] = [];
  const submission = await publishSubmission(
    ctx.scriptsDir,
    meta.name,
    source,
    ctx.now,
    async (dir) => {
      const vetting = await vetDependencies(dir, ctx);
      if (!vetting.ok)
        problems.push(...vetting.problems.map((problem) => ({ kind: "supply" as const, problem })));
      if (!vetting.ok || problems.length > 0) return undefined;
      newPackages = vetting.newPackages;
      await ensureVenv(dir, ctx.toolchain);
      return vetting.lock;
    },
  );
  if (submission === undefined) return { ok: false, problems };
  const base = await libraryBase(scriptsLayout(ctx.scriptsDir), meta.name);
  return { ok: true, submission, newPackages, base };
}

export function pythonProblems(meta: ScriptMeta, system: PythonVersion): Gate1Problem[] {
  const requires = meta.requiresPython;
  if (requires === undefined) return [];
  const verdict = satisfiesPython(requires, system);
  if (verdict === true) return [];
  return [
    verdict === undefined
      ? { kind: "python-unsupported", requires }
      : { kind: "python-excluded", requires, system },
  ];
}

// The store has no `has`, and the shape checks need the value anyway. The value goes to the two
// parsers and nowhere else. No token is requested: gate 1 needs no network for the secret.
async function secretProblems(
  meta: ScriptMeta,
  ctx: { readonly scriptsDir: string; readonly secrets: SecretStore },
): Promise<Gate1Problem[]> {
  const secret = meta.secret;
  if (secret === undefined) return [];
  const type = await readSecretType(ctx.scriptsDir, secret);
  const obtain = obtainCommand(secret, type);
  const wantsUrl = meta.domains.some((d) => d.kind === "secret-url");
  if (type === "google-oauth" && wantsUrl) return [{ kind: "secret-oauth-url", secret }];
  const value = await ctx.secrets.get(secretName(secret));
  if (value === null) return [{ kind: "secret-missing", secret, obtain }];
  if (type === undefined)
    return [
      {
        kind: "secret-shape",
        secret,
        detail: "its type is unknown",
        obtain: `${obtain} (or tars secret login ${secret} for a Google account)`,
      },
    ];
  const shape =
    type === "google-oauth"
      ? parseGoogleCredential(value)
      : wantsUrl
        ? secretUrlHost(value)
        : undefined;
  return shape instanceof Error
    ? [{ kind: "secret-shape", secret, detail: shape.message, obtain }]
    : [];
}

const CLAUSE = /^(===|==|~=|!=|<=|>=|<|>)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(\.\*)?$/;

/**
 * Whether every Python `system`.x satisfies `requires`. uv cannot answer this: `uv lock --script`
 * accepts any interpreter it can find, while the venv is always built on the system one.
 *
 * tars knows the system Python as major.minor only, so a clause that turns on the micro version
 * (>=3.14.2 on 3.14, ==3.14.1) is false: refuse when unsure. undefined means a clause tars does
 * not read (===, a wildcard with an ordering operator, epochs, pre-releases).
 */
export function satisfiesPython(requires: string, system: PythonVersion): boolean | undefined {
  const [major = 0, minor = 0] = system.split(".").map(Number);
  let all = true;
  for (const raw of requires.split(",")) {
    const clause = CLAUSE.exec(raw.trim());
    if (clause === null) return undefined;
    const [, op, a, b, c, wildcard] = clause;
    const want = [Number(a), Number(b ?? 0)] as const;
    const order = major - want[0] || minor - want[1];
    const microFree = c === undefined || Number(c) === 0;
    let holds: boolean;
    if (wildcard !== undefined) {
      if ((op !== "==" && op !== "!=") || c !== undefined) return undefined;
      const same = major === want[0] && (b === undefined || minor === want[1]);
      holds = op === "==" ? same : !same;
    } else if (op === ">=") holds = order > 0 || (order === 0 && microFree);
    else if (op === ">") holds = order > 0;
    else if (op === "<=" || op === "<") holds = order < 0;
    else if (op === "!=") holds = order !== 0;
    else if (op === "==") holds = false;
    else if (op === "~=") {
      if (b === undefined) return undefined;
      holds =
        c === undefined ? major === want[0] && minor >= want[1] : order === 0 && Number(c) === 0;
    } else return undefined;
    all &&= holds;
  }
  return all;
}

export function gate1ProblemText(problem: Gate1Problem): string {
  switch (problem.kind) {
    case "encoding":
      return "script.py is not valid UTF-8";
    case "metadata":
      return problem.detail;
    case "python-excluded":
      return `requires-python "${problem.requires}" does not admit every Python ${problem.system}.x, which is what scripts run on; compare on major.minor, e.g. ">=3.12"`;
    case "python-unsupported":
      return `requires-python "${problem.requires}" is not a form tars reads; use clauses such as ">=3.12" or ">=3.12,<3.15"`;
    case "secret-missing":
      return `no ${secretName(problem.secret)} in the keyring. Ask the user to run, in their own terminal: ${problem.obtain}`;
    case "secret-shape":
      return `${secretName(problem.secret)}: ${problem.detail}. Ask the user to reset it: ${problem.obtain}`;
    case "secret-oauth-url":
      return `${problem.secret} is a google-oauth secret, which has no url for "secret:url"; list the hosts in domains, e.g. "www.googleapis.com"`;
    case "supply":
      return problemText(problem.problem);
  }
}
