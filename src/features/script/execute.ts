import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import type { SecretStore } from "../../core/secrets.ts";
import type { LibraryScript, RunRecord } from "./library.ts";
import { parseScriptMeta, ScriptMetaError, type ScriptMeta } from "./metadata.ts";
import { redact, secretNeedles } from "./redact.ts";
import { runSandboxed, type Network, type SandboxHost, type SandboxResult } from "./sandbox.ts";
import { readSecretType, secretName, secretUrlHost } from "./secret.ts";

export const LOCK_FILE = "script.py.lock";

/** What approval.json records; `run` refuses a version whose files no longer match it. */
export interface Approval {
  readonly script: string;
  readonly lock: string;
}

export interface Runnable {
  readonly name: string;
  readonly dir: string;
  readonly meta: ScriptMeta;
  readonly version: string;
}

export interface ExecuteOptions {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly outDir?: string;
  /** Python's major.minor; each version dir keeps one venv per Python it was built for. */
  readonly python: string;
}

export interface Outcome extends SandboxResult {
  readonly stdout: string;
  readonly stderr: string;
}

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Runs an approved library version, with its secret, and logs one line to runs.jsonl. */
export async function runApproved(
  script: LibraryScript,
  opts: ExecuteOptions,
  ctx: { secrets: SecretStore; scriptsDir: string; host: SandboxHost; now: Date },
): Promise<Outcome> {
  await verifyApproval(script.versionDir, script.source);
  let secret: string | undefined;
  const hosts: string[] = [];
  if (script.meta.secret !== undefined) {
    const kind = script.meta.secret;
    if ((await readSecretType(ctx.scriptsDir, kind)) === "google-oauth")
      throw new TarsError(`${kind} is a google-oauth secret; tars cannot trade it for a token yet`);
    secret = (await ctx.secrets.get(secretName(kind))) ?? undefined;
    if (secret === undefined)
      throw new TarsError(
        `no ${secretName(kind)} in the keyring. Ask the user to run, in their own terminal: tars secret set ${kind}`,
      );
    if (script.meta.domains.some((d) => d.kind === "secret-url")) {
      const host = secretUrlHost(secret);
      if (host instanceof Error)
        throw new TarsError(
          `${secretName(kind)}: ${host.message}. Reset it: tars secret set ${kind}`,
        );
      hosts.push(host);
    }
  }
  const outcome = await execute(script.versionDir, script.meta, opts, ctx.host, hosts, secret);
  const record: RunRecord = {
    time: ctx.now.toISOString(),
    version: script.version,
    args: sha256(JSON.stringify(opts.args)),
    exit: outcome.exit,
    ms: outcome.ms,
  };
  await appendFile(join(script.dir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
  return outcome;
}

/** Runs a submitted script without any secret (r52), so a write to an outside service cannot happen. */
export async function runTrial(
  pendingDir: string,
  opts: ExecuteOptions,
  ctx: { host: SandboxHost; now: Date },
): Promise<Outcome> {
  const source = await readFile(join(pendingDir, "script.py"), "utf8").catch(() => {
    throw new TarsError(`nothing submitted at ${pendingDir}; run: tars script submit <draft dir>`);
  });
  let meta: ScriptMeta;
  try {
    meta = parseScriptMeta(source);
  } catch (err) {
    if (err instanceof ScriptMetaError) throw new TarsError(err.message);
    throw err;
  }
  const outcome = await execute(pendingDir, meta, opts, ctx.host, [], undefined);
  const trials = join(pendingDir, "trials");
  await mkdir(trials, { recursive: true });
  const stamp = ctx.now.toISOString().replaceAll(/[-:]/g, "");
  await writeFile(
    join(trials, `${stamp}-${randomBytes(3).toString("hex")}.json`),
    `${JSON.stringify({ time: ctx.now.toISOString(), script: sha256(source), args: opts.args, ...outcome }, null, 2)}\n`,
  );
  return outcome;
}

async function execute(
  dir: string,
  meta: ScriptMeta,
  opts: ExecuteOptions,
  host: SandboxHost,
  secretHosts: readonly string[],
  secret: string | undefined,
): Promise<Outcome> {
  const venv = join(dir, `venv-${opts.python}`);
  const venvs = (await readdir(dir).catch(() => [] as string[])).filter((n) =>
    n.startsWith("venv-"),
  );
  if (!venvs.includes(`venv-${opts.python}`))
    throw new TarsError(
      `${meta.name} has no environment for Python ${opts.python} (found: ${venvs.join(", ") || "none"})`,
    );
  const result = await runSandboxed(
    {
      python: join(venv, "bin", "python"),
      script: join(dir, "script.py"),
      venv,
      cwd: dir,
      args: opts.args,
      network: network(meta, secretHosts),
      ...(secret === undefined ? {} : { secret }),
      ...(opts.outDir === undefined ? {} : { outDir: opts.outDir }),
      timeoutMs: opts.timeoutMs,
    },
    host,
  );
  if (secret === undefined) return result;
  const needles = secretNeedles(secret);
  return {
    ...result,
    stdout: redact(result.stdout, needles),
    stderr: redact(result.stderr, needles),
  };
}

function network(meta: ScriptMeta, secretHosts: readonly string[]): Network {
  if (meta.domains.some((d) => d.kind === "any")) return { kind: "open" };
  const hosts = [
    ...meta.domains.flatMap((d) =>
      d.kind === "host" ? [d.port === undefined ? d.host : `${d.host}:${d.port}`] : [],
    ),
    ...secretHosts,
  ];
  return hosts.length === 0 ? { kind: "none" } : { kind: "allow", hosts };
}

async function verifyApproval(versionDir: string, source: string): Promise<void> {
  const refuse = (why: string) =>
    new TarsError(`${versionDir}: ${why}; refusing to run. Submit the script for review again.`);
  let approval: Partial<Approval> | null;
  try {
    approval = JSON.parse(await readFile(join(versionDir, "approval.json"), "utf8"));
  } catch {
    throw refuse("approval.json is missing or unreadable");
  }
  if (typeof approval !== "object" || approval === null)
    throw refuse("approval.json is not an object");
  const lock = await readFile(join(versionDir, LOCK_FILE)).catch(() => undefined);
  if (lock === undefined) throw refuse(`${LOCK_FILE} is missing`);
  if (approval.script !== sha256(source)) throw refuse("script.py changed after approval");
  if (approval.lock !== sha256(lock)) throw refuse(`${LOCK_FILE} changed after approval`);
}
