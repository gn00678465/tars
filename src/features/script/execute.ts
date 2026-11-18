import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { sha256 } from "../../core/hash.ts";
import type { SecretStore } from "../../core/secrets.ts";
import {
  isTokenFailure,
  parseGoogleCredential,
  refreshAccessToken,
  tokenFailureText,
  type GoogleEndpoints,
} from "./google.ts";
import { checkApproval, type LibraryScript, type RunRecord } from "./library.ts";
import { hostText, type ScriptMeta } from "./metadata.ts";
import { recordTrial, type Submission } from "./pending.ts";
import { redact, secretNeedles } from "./redact.ts";
import { runSandboxed, type Network, type SandboxHost, type SandboxResult } from "./sandbox.ts";
import { obtainCommand, readSecretType, secretName, secretUrlHost } from "./secret.ts";
import { ensureVenv, type Toolchain } from "./supply.ts";

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
    google: GoogleEndpoints;
    host: SandboxHost;
    toolchain: Toolchain;
    now: Date;
  },
): Promise<SandboxResult> {
  const approval = await checkApproval(script.versionDir, script.source);
  if (typeof approval === "string")
    throw new TarsError(
      `${script.versionDir}: ${approval}; refusing to run. Submit the script for review again.`,
    );
  const outcome = await runWithSecret(script.versionDir, script.meta, opts, ctx);
  const record: RunRecord = {
    time: ctx.now.toISOString(),
    version: script.version,
    argsSha256: sha256(JSON.stringify(opts.args)),
    exit: outcome.exit,
    ms: outcome.ms,
  };
  // abandon may have moved the script to retired/ while it ran; the run itself still stands.
  await appendFile(join(script.dir, "runs.jsonl"), `${JSON.stringify(record)}\n`).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    },
  );
  return outcome;
}

/** What a run gets from the keyring: the value for TARS_SECRET, what to mask, what to let through. */
export interface Handover {
  readonly value: string;
  readonly needles: readonly string[];
  /** Hosts from a "secret:url" value. */
  readonly hosts: readonly string[];
}

export interface HandoverContext {
  readonly secrets: SecretStore;
  readonly scriptsDir: string;
  readonly google: GoogleEndpoints;
}

/**
 * Reads the secret `meta` declares and turns it into what the script may see. A static value is
 * handed over whole. A google-oauth credential stays here: tars trades it for an access token
 * and hands over only that. Every failure names a field, a status or an error code, never a value.
 */
export async function handOver(
  meta: ScriptMeta,
  timeoutMs: number,
  ctx: HandoverContext,
): Promise<Handover | undefined> {
  const kind = meta.secret;
  if (kind === undefined) return undefined;
  const type = await readSecretType(ctx.scriptsDir, kind);
  const obtain = obtainCommand(kind, type);
  const wantsUrl = meta.domains.some((d) => d.kind === "secret-url");
  // Checked again here because the type can change after gate 1 let the script in.
  if (type === "google-oauth" && wantsUrl)
    throw new TarsError(`${kind} is a google-oauth secret, which has no url for "secret:url"`);
  const stored = (await ctx.secrets.get(secretName(kind))) ?? undefined;
  if (stored === undefined)
    throw new TarsError(
      `no ${secretName(kind)} in the keyring. Ask the user to run, in their own terminal: ${obtain}`,
    );
  // Without its type file a google-oauth credential would pass as static: refresh token and all.
  if (type === undefined)
    throw new TarsError(
      `the type of ${secretName(kind)} is unknown. Ask the user to store it again, in their own terminal: tars secret set ${kind}, or tars secret login ${kind} for a Google account`,
    );
  if (type !== "google-oauth") {
    const host = wantsUrl ? secretUrlHost(stored) : undefined;
    if (host instanceof Error)
      throw new TarsError(`${secretName(kind)}: ${host.message}. Reset it: ${obtain}`);
    return {
      value: stored,
      needles: secretNeedles(stored),
      hosts: host === undefined ? [] : [host],
    };
  }
  const again = `Ask the user to run, in their own terminal: ${obtain}`;
  const credential = parseGoogleCredential(stored);
  if (credential instanceof Error)
    throw new TarsError(`${secretName(kind)}: ${credential.message}. ${again}`);
  const token = await refreshAccessToken(credential, ctx.google);
  if (isTokenFailure(token)) {
    const hint =
      token.kind !== "refused"
        ? ""
        : token.error === "invalid_grant"
          ? ` The sign-in expired or was revoked. ${again}`
          : token.error === "invalid_client" || token.error === "deleted_client"
            ? ` The OAuth client is wrong or was deleted (Google restores a deleted one for 30 days). After fixing it: ${obtain}`
            : "";
    throw new TarsError(`${secretName(kind)}: ${tokenFailureText(token)}.${hint}`);
  }
  if (timeoutMs > token.expiresIn * 1000)
    throw new TarsError(
      `the access token for ${kind} lasts ${token.expiresIn} s, less than the ${timeoutMs / 1000} s time limit; use a --timeout of ${token.expiresIn} or less`,
    );
  return {
    value: token.accessToken,
    // The stored values never reach the script, but a message that echoes them must not either.
    needles: [token.accessToken, credential.refreshToken, credential.clientSecret].flatMap(
      secretNeedles,
    ),
    hosts: [],
  };
}

/**
 * Runs <dir>/script.py with the secret `meta` declares and masks it in the output. Shared by
 * `run` and gate 3's live run, so both hand the secret over and redact it the same way.
 */
export async function runWithSecret(
  dir: string,
  meta: ScriptMeta,
  opts: ExecuteOptions,
  ctx: HandoverContext & { host: SandboxHost; toolchain: Toolchain },
): Promise<SandboxResult> {
  const handover = await handOver(meta, opts.timeoutMs, ctx);
  return execute(dir, meta, opts, ctx, network(meta, handover?.hosts ?? []), handover);
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
  const outcome = await execute(
    submission.dir,
    submission.meta,
    opts,
    ctx,
    trialNetwork(submission.meta),
    undefined,
  );
  await recordTrial(submission, opts.args, outcome, ctx.now);
  return outcome;
}

async function execute(
  dir: string,
  meta: ScriptMeta,
  opts: ExecuteOptions,
  { host, toolchain }: { host: SandboxHost; toolchain: Toolchain },
  net: Network,
  handover: Handover | undefined,
): Promise<SandboxResult> {
  const venv = await ensureVenv(dir, toolchain);
  const result = await runSandboxed(
    {
      python: venv.python,
      script: join(dir, "script.py"),
      venv: venv.dir,
      cwd: dir,
      args: opts.args,
      network: net,
      ...(handover === undefined ? {} : { secret: handover.value }),
      ...(opts.outDir === undefined ? {} : { outDir: opts.outDir }),
      timeoutMs: opts.timeoutMs,
    },
    host,
  );
  if (handover === undefined) return result;
  return {
    ...result,
    stdout: redact(result.stdout, handover.needles),
    stderr: redact(result.stderr, handover.needles),
  };
}

/**
 * Gate 2 must not write to the outside world (r52). Withholding the secret is not enough for an
 * external-write script that needs none, so such a script gets no network at all.
 */
export function trialNetwork(meta: ScriptMeta): Network {
  return meta.effects === "external-write" ? { kind: "none" } : network(meta, []);
}

function network(meta: ScriptMeta, secretHosts: readonly string[]): Network {
  if (meta.domains.some((d) => d.kind === "any")) return { kind: "open" };
  const hosts = [
    ...meta.domains.flatMap((d) => (d.kind === "host" ? [hostText(d)] : [])),
    ...secretHosts,
  ];
  return hosts.length === 0 ? { kind: "none" } : { kind: "allow", hosts };
}
