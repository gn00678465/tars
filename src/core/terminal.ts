import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { TarsError } from "./exit.ts";

/**
 * The user's own terminal. Gate 3 shows its material and reads its answers here and nowhere else,
 * so a pipe cannot answer it and a redirect cannot hide what the person typing is approving.
 */
export interface Terminal {
  write(text: string): void;
  /** One line without its newline; undefined at end of input. */
  ask(prompt: string): Promise<string | undefined>;
  /** Like ask, with the terminal's echo off while the line is typed. */
  askHidden(prompt: string): Promise<string | undefined>;
  close(): void;
}

// Runs with /dev/tty as stdin and the prompt as $1. The read is a child's so that a process with
// a trap is what turns echo back on: Ctrl-C reaches tars and the child together, and tars cannot
// run a handler while it waits in a blocking read. The child prints the prompt, and only once
// echo is off, so nothing typed in answer to it can show.
const HIDDEN_READ = `trap 'stty echo' EXIT
trap 'exit 130' INT TERM HUP
stty -echo || exit 1
printf '%s' "$1" >&0
IFS= read -r line || exit 3
printf '%s' "$line"`;

/**
 * Reads in the terminal's own line mode: the kernel edits the line and hands over one line per
 * read, and with no raw mode there is nothing to restore when tars is killed at a prompt.
 */
export function openTty(): Terminal {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw new TarsError(
      "this command reads only from your terminal (/dev/tty), and this process has none. Run it in your own terminal.",
    );
  }
  const chunk = new Uint8Array(4096);
  let buffered: number[] = [];
  const write = (text: string) => {
    let rest = new TextEncoder().encode(text);
    while (rest.length > 0) rest = rest.subarray(writeSync(fd, rest));
  };
  const bufferedLine = () => {
    const end = buffered.indexOf(10);
    if (end === -1) return undefined;
    const line = new TextDecoder().decode(new Uint8Array(buffered.slice(0, end)));
    buffered = buffered.slice(end + 1);
    return line;
  };
  return {
    write,
    ask: async (prompt) => {
      write(prompt);
      for (;;) {
        const line = bufferedLine();
        if (line !== undefined) return line;
        const n = readSync(fd, chunk);
        if (n === 0) return undefined;
        buffered.push(...chunk.subarray(0, n));
      }
    },
    askHidden: async (prompt) => {
      const typedAhead = bufferedLine();
      if (typedAhead !== undefined) {
        write(prompt);
        return typedAhead;
      }
      // With a listener the signal no longer kills tars, so the child restores echo while tars
      // still holds the terminal's foreground.
      const keepAlive = () => {};
      process.on("SIGINT", keepAlive);
      try {
        const child = Bun.spawnSync(["sh", "-c", HIDDEN_READ, "sh", prompt], {
          stdin: fd,
          stdout: "pipe",
          stderr: "ignore",
        });
        write("\n");
        if (child.exitCode === 0) return child.stdout.toString();
        if (child.exitCode === 3) return undefined;
        throw new TarsError(
          child.exitCode === 130 || child.signalCode === "SIGINT"
            ? "cancelled"
            : "cannot turn off the terminal's echo",
        );
      } finally {
        process.off("SIGINT", keepAlive);
      }
    },
    close: () => closeSync(fd),
  };
}
