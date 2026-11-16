import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { sha256 } from "../../core/hash.ts";
import type { SecretStore } from "../../core/secrets.ts";
import type { LibraryScript, RunRecord } from "./library.ts";
import { hostText, type ScriptMeta } from "./metadata.ts";
import { recordTrial, type Submission } from "./pending.ts";
import { redact, secretNeedles } from "./redact.ts";
import { runSandboxed, type Network, type SandboxHost, type SandboxResult } from "./sandbox.ts";
import { readSecretType, secretName, secretUrlHost } from "./secret.ts";
import { ensureVenv, LOCK_FILE, type Toolchain } from "./supply.ts";

interface Approval {
  readonly script: string;
  readonly lock: string;
}

export interface ExecuteOptions {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly outDir?: string;
}

export async function runApproved(
  script: LibraryScript,
  opts: ExecuteOptions,
  ctx: {
    secrets: SecretStore;
    scriptsDir: string;
    host: SandboxHost;
    toolchain: Toolchain;
    now: Date;
  },
): Promise<SandboxResult> {
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
  const outcome = await execute(script.versionDir, script.meta, opts, ctx, hosts, secret);
  const record: RunRecord = {
    time: ctx.now.toISOString(),
    version: script.version,
    argsSha256: sha256(JSON.stringify(opts.args)),
    exit: outcome.exit,
    ms: outcome.ms,
  };
  await appendFile(join(script.dir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
  return outcome;
}

/**
 * Takes a Submission, which cannot exist without the gate1.json comparison. The sandbox still
 * runs the file on disk; one swapped after the check runs without a secret, and its record
 * carries the hash of the bytes that were checked.
 */
export async function runTrial(
  submission: Submission,
  opts: ExecuteOptions,
  ctx: { host: SandboxHost; toolchain: Toolchain; now: Date },
): Promise<SandboxResult> {
  const outcome = await execute(submission.dir, submission.meta, opts, ctx, [], undefined);
  await recordTrial(submission, opts.args, outcome, ctx.now);
  return outcome;
}

async function execute(
  dir: string,
  meta: ScriptMeta,
  opts: ExecuteOptions,
  { host, toolchain }: { host: SandboxHost; toolchain: Toolchain },
  secretHosts: readonly string[],
  secret: string | undefined,
): Promise<SandboxResult> {
  const venv = await ensureVenv(dir, toolchain);
  const result = await runSandboxed(
    {
      python: venv.python,
      script: join(dir, "script.py"),
      venv: venv.dir,
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
    ...meta.domains.flatMap((d) => (d.kind === "host" ? [hostText(d)] : [])),
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
