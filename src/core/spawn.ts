import { readFileSync } from "node:fs";
import { constants } from "node:os";

export interface SandboxResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly ms: number;
}

export interface SpawnOptions {
  /** Aborting stops the child as a timeout does. */
  readonly signal?: AbortSignal;
  /** How long the child gets after SIGTERM before SIGKILL. */
  readonly graceMs?: number;
  /** Run the child in a process group of its own; SIGKILL then goes to the whole group. */
  readonly group?: boolean;
  readonly onSpawn?: (pid: number) => void;
  /** Stop the child on this process's SIGINT and SIGTERM. A caller with its own handlers passes false. */
  readonly handleSignals?: boolean;
}

/** The exit code of a child stopped for running too long, as timeout(1) reports it. */
export const EXIT_TIMEOUT = 124;
/** Bytes kept from each of a child's stdout and stderr. */
export const OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_GRACE_MS = 2000;

export async function spawnAndWait(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  opts: SpawnOptions = {},
): Promise<SandboxResult> {
  // Reported as a child stopped at once, so callers see an already aborted run as an aborted one.
  if (opts.signal?.aborted)
    return {
      exit: 128 + constants.signals.SIGTERM,
      stdout: "",
      stderr: "",
      truncated: false,
      ms: 0,
    };
  const started = performance.now();
  const group = opts.group === true;
  const proc = Bun.spawn([...argv], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: group,
  });
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  };
  let timedOut = false;
  let stopped = false;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    proc.kill("SIGTERM");
    forced ??= setTimeout(
      () => (group ? killGroup() : proc.kill("SIGKILL")),
      opts.graceMs ?? DEFAULT_GRACE_MS,
    );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handleSignals = opts.handleSignals ?? true;
  try {
    try {
      opts.onSpawn?.(proc.pid);
    } catch (err) {
      // The caller could not record the child, so nothing would ever stop it later.
      if (group) killGroup();
      else proc.kill("SIGKILL");
      await proc.exited;
      throw err;
    }
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (handleSignals) {
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }
    opts.signal?.addEventListener("abort", stop);
    if (opts.signal?.aborted) stop();
    // A child that leaves on SIGTERM may leave its own children behind, holding the pipes open.
    const exited = proc.exited.then((code) => {
      if (stopped && group) killGroup();
      return code;
    });
    const [out, err, code] = await Promise.all([
      keepHeadDrainRest(proc.stdout),
      keepHeadDrainRest(proc.stderr),
      exited,
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
    opts.signal?.removeEventListener("abort", stop);
    if (handleSignals) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

export async function keepHeadDrainRest(stream: ReadableStream<Uint8Array>) {
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

/** Field 22 of /proc/<pid>/stat; with the pid it names one process even after the pid is reused. */
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}
