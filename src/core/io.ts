import { TarsError } from "./exit.ts";

/** stdout carries results, stderr carries diagnostics. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const processIo: Io = {
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
};

/** Reads one secret: from a TTY with a prompt on stderr and no echo, otherwise all of stdin. */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Bun.stdin.text();
  process.stderr.write(prompt);
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      settle();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(() => resolve(value));
        if (ch === "\u0003") return finish(() => reject(new TarsError("cancelled")));
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
