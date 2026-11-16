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
  close(): void;
}

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
  return {
    write,
    ask: async (prompt) => {
      write(prompt);
      for (;;) {
        const end = buffered.indexOf(10);
        if (end !== -1) {
          const line = new TextDecoder().decode(new Uint8Array(buffered.slice(0, end)));
          buffered = buffered.slice(end + 1);
          return line;
        }
        const n = readSync(fd, chunk);
        if (n === 0) return undefined;
        buffered.push(...chunk.subarray(0, n));
      }
    },
    close: () => closeSync(fd),
  };
}
