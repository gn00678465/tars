import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { constants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { EXIT_TIMEOUT, OUTPUT_LIMIT } from "./metadata.ts";

export type Network =
  | { readonly kind: "none" }
  | { readonly kind: "allow"; readonly hosts: readonly string[] }
  | { readonly kind: "open" };

export interface SandboxJob {
  readonly python: string;
  readonly script: string;
  readonly venv: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly network: Network;
  readonly secret?: string;
  readonly outDir?: string;
  readonly timeoutMs: number;
}

export interface SandboxHost {
  readonly realHome: string;
  readonly data: string;
  readonly bins: readonly string[];
  readonly seccomp: string;
}

export interface SandboxResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly ms: number;
}

const KILL_GRACE_MS = 2000;

// The proxy checks the addresses a name resolves to against these, but lets "localhost" reach
// loopback and never checks an IP literal at all; openAsk refuses the literals.
const OPEN_DENIED_DOMAINS = ["localhost", "*.localhost"];
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

export async function openAsk({ host }: { host: string }) {
  return isIpLiteral(host)
    ? { allow: false as const, reason: 'domains "*" allows host names, not IP addresses' }
    : true;
}

function isIpLiteral(host: string): boolean {
  try {
    const name = new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}/`).hostname;
    return isIP(name.replace(/^\[|\]$/g, "")) !== 0;
  } catch {
    return true;
  }
}

// sandbox-runtime binds a host /tmp/claude into every sandbox read-write, whatever denyRead says,
// and /tmp is shared with every local process.
const SHARED_TMP = "/tmp/claude";

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

  const record = join(runDir, `${process.pid}.json`);
  const callerDir = process.cwd();
  // On Linux sandbox-runtime ignores its cwd argument and scans process.cwd(); the script inherits it.
  process.chdir(job.cwd);
  try {
    await SandboxManager.initialize(config, open ? openAsk : undefined);
    // sandbox-runtime only warns when the seccomp helper is missing, then runs with Unix sockets
    // unfiltered.
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
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, undefined, {
      filesystem: filesystem([socket]),
    });
    if (existsSync(SHARED_TMP))
      throw new TarsError(
        `${SHARED_TMP} exists, and the sandbox would let the script read and write it; remove it first`,
      );
    return await spawnAndWait(wrapped.argv, sandboxEnv(wrapped.env, job), job.timeoutMs);
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
    await rm(record, { force: true });
    process.chdir(callerDir);
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
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const [out, err, code] = await Promise.all([
      keepHeadDrainRest(proc.stdout),
      keepHeadDrainRest(proc.stderr),
      proc.exited,
    ]);
    const sig = proc.signalCode;
    const signal = sig == null ? undefined : typeof sig === "number" ? sig : constants.signals[sig];
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
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function keepHeadDrainRest(stream: ReadableStream<Uint8Array>) {
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

/** A tars killed with SIGKILL leaves sandbox-runtime's socat bridge and sockets behind. */
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
    if (
      typeof rec.pid !== "number" ||
      typeof rec.socket !== "string" ||
      !rec.socket.startsWith("/")
    )
      continue;
    const start = startTime(rec.pid);
    if (start !== undefined && start === rec.start) continue;
    for (const pid of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(pid)) continue;
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      if (basename(cmdline.split("\0")[0] ?? "") === "socat" && cmdline.includes(rec.socket))
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
    }
    await rm(rec.socket, { force: true });
    for (const f of await readdir(tmpdir()).catch(() => [] as string[]))
      if (f.startsWith(`srt-mux-${rec.pid}-`)) await rm(join(tmpdir(), f), { force: true });
    await rm(path, { force: true });
  }
}
