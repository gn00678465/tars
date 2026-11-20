import { TarsError } from "./exit.ts";

/** stdout carries results, stderr carries diagnostics. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Text on stdout as is, without a newline: a reply streamed in pieces. */
  write(text: string): void;
  /** stdout is a terminal, so control characters in what it prints act on the screen. */
  readonly stdoutIsTty?: boolean;
}

export const processIo: Io = {
  out: (line) => void process.stdout.write(`${line}\n`),
  write: (text) => void process.stdout.write(text),
  stdoutIsTty: process.stdout.isTTY === true,
  err: (line) => void process.stderr.write(`${line}\n`),
};

/**
 * Reads one secret: from a TTY with a prompt on stderr and a "*" for each character typed,
 * otherwise all of stdin. Escape sequences are dropped: a terminal with bracketed paste on wraps
 * a pasted token in ESC[200~ and ESC[201~, which would otherwise become part of the secret.
 */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Bun.stdin.text();
  const stdin = process.stdin;
  // Raw mode first: a key typed in answer to a prompt shown earlier would be echoed by the kernel.
  stdin.setRawMode(true);
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    let escape: "" | "esc" | "csi" = "";
    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      settle();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (escape === "esc") {
          escape = ch === "[" ? "csi" : "";
          continue;
        }
        if (escape === "csi") {
          if (ch >= "@" && ch <= "~") escape = "";
          continue;
        }
        if (ch === "\u001b") escape = "esc";
        else if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(() => resolve(value));
        else if (ch === "\u0003") return finish(() => reject(new TarsError("cancelled")));
        else if (ch === "\u007f" || ch === "\b") {
          if (value === "") continue;
          value = [...value].slice(0, -1).join("");
          process.stderr.write("\b \b");
        } else if (ch >= " ") {
          value += ch;
          process.stderr.write("*");
        }
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}
