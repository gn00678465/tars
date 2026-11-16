import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TarsError } from "../../core/exit.ts";

/** none: no network. allow: only these hosts. open: anywhere except this machine and private ranges. */
export type Network =
  | { readonly kind: "none" }
  | { readonly kind: "allow"; readonly hosts: readonly string[] }
  | { readonly kind: "open" };

export interface SandboxJob {
  readonly python: string;
  readonly script: string;
  readonly venv: string;
  /** Working directory: the script's own version dir, never the caller's (sandbox-runtime scans it). */
  readonly cwd: string;
  readonly args: readonly string[];
  readonly network: Network;
  readonly secret?: string;
  readonly outDir?: string;
  readonly timeoutMs: number;
}

export interface SandboxHost {
  /** From the account database: `tars agy` points HOME elsewhere. */
  readonly realHome: string;
  readonly data: string;
  readonly bins: readonly string[];
  readonly seccomp: string;
}

export interface SandboxResult {
  /** The script's code; 124 on timeout, 128+n when signal n stopped it. */
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly ms: number;
}

export const EXIT_TIMEOUT = 124;
const KILL_GRACE_MS = 2000;
export const OUTPUT_LIMIT = 1024 * 1024;

// The proxy skips its resolved-address check for hosts the ask callback allows, so open
// network needs these lists to keep scripts off this machine and the LAN (prototype round 3).
const OPEN_DENIED_DOMAINS = ["localhost", "*.localhost", "127.0.0.1", "::1"];
const OPEN_DENIED_ADDRESSES = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
  "169.254.0.0/16",
  "fe80::/10",
];

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

export async function runSandboxed(job: SandboxJob, host: SandboxHost): Promise<SandboxResult> {
  const runDir = join(host.data, "run");
  await removeStaleRuns(runDir);
  const denyRead = [host.realHome, host.data, ...host.bins, "/tmp", "/var/tmp", "/run/user"];
  const baseRead = [job.script, job.venv, host.seccomp];
  const filesystem = (extra: string[]) => ({
    denyRead,
    allowRead: [...baseRead, ...extra],
    allowWrite: job.outDir ? [job.outDir] : [],
    denyWrite: [],
  });
  const open = job.network.kind === "open";
  const config = {
    network: {
      allowedDomains: job.network.kind === "allow" ? [...job.network.hosts] : [],
      deniedDomains: open ? OPEN_DENIED_DOMAINS : [],
      ...(open ? { deniedResolvedAddresses: OPEN_DENIED_ADDRESSES } : {}),
    },
    filesystem: filesystem([]),
    seccomp: { applyPath: host.seccomp },
  } as SandboxRuntimeConfig;

  await SandboxManager.initialize(config, open ? async () => true : undefined);
  const record = join(runDir, `${process.pid}.json`);
  try {
    const deps = SandboxManager.checkDependencies();
    const problems = [...deps.errors, ...deps.warnings];
    if (problems.length > 0)
      throw new TarsError(`the sandbox is not usable: ${problems.join("; ")}`);
    if (!(await SandboxManager.waitForNetworkInitialization()))
      throw new TarsError("the sandbox network proxy did not start");
    const socket = SandboxManager.getLinuxHttpSocketPath();
    if (!socket) throw new TarsError("the sandbox network proxy has no socket");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      record,
      JSON.stringify({ pid: process.pid, start: startTime(process.pid), socket }),
    );
    // sandbox-runtime puts NO_PROXY with loopback and private ranges into the command it builds,
    // so clearing it in the spawn env has no effect; it must be cleared in the command itself.
    const command = `NO_PROXY= no_proxy= exec ${[job.python, job.script, ...job.args].map(quote).join(" ")}`;
    // The full filesystem policy goes with every wrap: the bridge socket exists only now.
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      undefined,
      { filesystem: filesystem([socket]) },
      undefined,
      job.cwd,
    );
    return await spawnAndWait(wrapped.argv, sandboxEnv(wrapped.env, job), job.timeoutMs);
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
    await rm(record, { force: true });
  }
}

/** What sandbox-runtime added for its own plumbing, plus tars's allowlist; nothing else of ours. */
function sandboxEnv(wrapped: NodeJS.ProcessEnv, job: SandboxJob): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(wrapped))
    if (value !== undefined && process.env[key] !== value) env[key] = value;
  env.PATH = "/usr/bin:/bin";
  env.LANG = "C.UTF-8";
  env.HOME = "/tmp";
  if (job.secret !== undefined) env.TARS_SECRET = job.secret;
  if (job.outDir !== undefined) env.TARS_OUT = job.outDir;
  return env;
}

async function spawnAndWait(
  argv: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SandboxResult> {
  const started = performance.now();
  const proc = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    proc.kill("SIGTERM");
    forced ??= setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  // Ctrl-C reaches tars too; stop the script the same way instead of dying and leaving it.
  const onSignal = () => stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const [out, err, code] = await Promise.all([
      capture(proc.stdout),
      capture(proc.stderr),
      proc.exited,
    ]);
    const signal = proc.signalCode ? (SIGNALS[proc.signalCode] ?? 15) : undefined;
    return {
      exit: timedOut ? EXIT_TIMEOUT : signal !== undefined ? 128 + signal : code,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(forced);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Keeps the first OUTPUT_LIMIT bytes and drains the rest, so the script never blocks on a full pipe. */
async function capture(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (size >= OUTPUT_LIMIT) {
      truncated = true;
      continue;
    }
    const room = OUTPUT_LIMIT - size;
    if (chunk.length > room) truncated = true;
    chunks.push(chunk.subarray(0, room));
    size += Math.min(chunk.length, room);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Field 22 of /proc/<pid>/stat; with the pid it names one process even after the pid is reused. */
function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/**
 * A tars killed with SIGKILL leaves its socat bridge and sockets behind (prototype round 2).
 * Only records whose process is gone are cleaned, and only a socat whose command line names the
 * recorded socket is killed, so another running tars and a reused pid are left alone.
 */
async function removeStaleRuns(runDir: string): Promise<void> {
  const names = await readdir(runDir).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(runDir, name);
    let rec: { pid?: number; start?: string; socket?: string };
    try {
      rec = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (typeof rec.pid !== "number" || typeof rec.socket !== "string") continue;
    if (startTime(rec.pid) !== undefined && startTime(rec.pid) === rec.start) continue;
    for (const pid of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(pid)) continue;
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      if (basename(cmdline.split("\0")[0] ?? "") === "socat" && cmdline.includes(rec.socket))
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          // Already gone.
        }
    }
    await rm(rec.socket, { force: true });
    for (const f of await readdir(tmpdir()).catch(() => [] as string[]))
      if (f.startsWith(`srt-mux-${rec.pid}-`)) await rm(join(tmpdir(), f), { force: true });
    await rm(path, { force: true });
  }
}
