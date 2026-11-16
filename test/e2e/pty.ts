import { runStep, type Host, type StepResult } from "./sandbox.ts";

export interface Turn {
  /** Text that must show up on the terminal, after the previous turn's, before `send` is typed. */
  readonly expect: string;
  /** Typed as is; end a line with \n, or send \x04 for end of input. */
  readonly send: string;
}

export interface Dialog {
  readonly name: string;
  /** Run by sh -c in a session of its own. */
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  /** false leaves that session without a controlling terminal. */
  readonly tty: boolean;
  readonly turns: readonly Turn[];
  /** Limit for each expect and for the exit after the last turn. */
  readonly waitMs?: number;
}

export interface DialogResult extends StepResult {
  /** What the terminal showed, typed input included (the pty echoes it). */
  readonly transcript: string;
  /** The first expect that never showed up; the command was killed then. */
  readonly missed?: string;
  readonly timedOut: boolean;
}

// stdin is /dev/null and stdout, stderr are pipes, so the pty is reachable only as /dev/tty:
// a command that answered from stdin or showed its questions on stdout would fail the dialog.
const DRIVER = `
import fcntl, json, os, select, signal, sys, termios, time
cfg = json.loads(sys.argv[1])
master, slave = os.openpty() if cfg["tty"] else (None, None)
out_r, out_w = os.pipe()
err_r, err_w = os.pipe()
pid = os.fork()
if pid == 0:
    os.setsid()
    if slave is not None:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    os.dup2(out_w, 1)
    os.dup2(err_w, 2)
    os.closerange(3, 256)
    os.execv("/bin/sh", ["sh", "-c", cfg["command"]])
os.close(out_w)
os.close(err_w)
streams = {fd: b"" for fd in (master, out_r, err_r) if fd is not None}
live = set(streams)
def pump(timeout):
    ready, _, _ = select.select(list(live), [], [], timeout)
    for fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if data:
            streams[fd] += data
        else:
            live.discard(fd)
    return bool(ready)
wait = cfg["waitMs"] / 1000
missed, seen = None, 0
for turn in cfg["turns"]:
    want = turn["expect"].encode()
    deadline = time.monotonic() + wait
    while want not in streams[master][seen:]:
        if time.monotonic() > deadline:
            missed = turn["expect"]
            break
        pump(0.05)
    if missed is not None:
        break
    seen = streams[master].index(want, seen) + len(want)
    os.write(master, turn["send"].encode())
status, timed_out = None, False
deadline = time.monotonic() + (0 if missed is not None else wait)
while status is None:
    done, code = os.waitpid(pid, os.WNOHANG)
    if done:
        status = code
    elif time.monotonic() > deadline:
        timed_out = missed is None
        os.killpg(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    else:
        pump(0.05)
live.discard(master)
drain = time.monotonic() + 5
while live and time.monotonic() < drain:
    pump(0.1)
if master is not None:
    live = {master}
    while pump(0.1):
        pass
text = lambda fd: streams[fd].decode("utf-8", "replace") if fd is not None else ""
print(json.dumps({
    "exit": os.waitstatus_to_exitcode(status),
    "transcript": text(master).replace("\\r\\n", "\\n"),
    "stdout": text(out_r),
    "stderr": text(err_r),
    "missed": missed,
    "timedOut": timed_out,
}))
`;

/**
 * Runs a command inside the e2e sandbox with a pty as its controlling terminal and types each
 * answer only after its prompt showed up, so the order of the questions is part of what passes.
 */
export async function runDialog(host: Host, dialog: Dialog): Promise<DialogResult> {
  const waitMs = dialog.waitMs ?? 60_000;
  const config = { command: dialog.command, tty: dialog.tty, turns: dialog.turns, waitMs };
  const step = await runStep(host, {
    name: dialog.name,
    argv: ["python3", "-c", DRIVER, JSON.stringify(config)],
    cwd: host.home,
    ...(dialog.env === undefined ? {} : { env: dialog.env }),
    timeoutMs: waitMs * (dialog.turns.length + 1) + 30_000,
  });
  let report: {
    exit: number;
    transcript: string;
    stdout: string;
    stderr: string;
    missed: string | null;
    timedOut: boolean;
  };
  try {
    report = JSON.parse(step.stdout);
  } catch {
    throw new Error(
      `pty driver for ${dialog.name} failed (exit ${step.exitCode}): ${step.stdout}${step.stderr}`,
    );
  }
  return {
    name: dialog.name,
    exitCode: report.exit,
    stdout: report.stdout,
    stderr: report.stderr,
    ms: step.ms,
    transcript: report.transcript,
    ...(report.missed === null ? {} : { missed: report.missed }),
    timedOut: report.timedOut,
  };
}
