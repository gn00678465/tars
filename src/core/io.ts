/** stdout carries results, stderr carries diagnostics. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const processIo: Io = {
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
};
