import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/core/io.ts";
import type { Deps } from "../src/main.ts";

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

export type TestDeps = Deps & { readonly io: CapturedIo };

/** Deps with no access to the real HOME, keyring, or embedded files. */
export function testDeps(overrides: Partial<Deps> = {}): TestDeps {
  return { env: {}, embedded: async () => [], ...overrides, io: captureIo() };
}
