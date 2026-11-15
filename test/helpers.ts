import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/core/io.ts";

export interface CapturedIo extends Io {
  readonly stdout: string[];
  readonly stderr: string[];
}

export function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l) };
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "tars-test-"));
}
