import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/core/io.ts";
import type { SecretName, SecretStore } from "../src/core/secrets.ts";
import type { Terminal } from "../src/core/terminal.ts";
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

/** A shell script standing in for the compiled tars binary that install copies. */
export function fakeExecutable(output = "fake tars"): string {
  const path = join(tempHome(), "tars");
  writeFileSync(path, `#!/bin/sh\necho ${output}\n`, { mode: 0o755 });
  return path;
}

export interface FakeSecrets extends SecretStore {
  readonly entries: Map<SecretName, string>;
}

export function fakeSecrets(initial: Partial<Record<SecretName, string>> = {}): FakeSecrets {
  const entries = new Map(Object.entries(initial) as [SecretName, string][]);
  return {
    entries,
    get: async (name) => entries.get(name) ?? null,
    set: async (name, value) => void entries.set(name, value),
    delete: async (name) => (entries.delete(name) ? "deleted" : "absent"),
  };
}

export type TestDeps = Deps & { readonly io: CapturedIo };

/** Deps with no access to the real HOME, keyring, terminal, embedded files, or harness binaries. */
export function testDeps(overrides: Partial<Deps> = {}): TestDeps {
  return {
    env: {},
    executable: fakeExecutable(),
    cwd: "/launch-dir",
    secrets: fakeSecrets(),
    embedded: async () => [],
    readSecret: () => Promise.reject(new Error("test did not provide stdin")),
    openTerminal: () => {
      throw new Error("test did not provide a terminal");
    },
    launch: () => Promise.reject(new Error("test did not provide a launcher")),
    ...overrides,
    io: captureIo(),
  };
}

type Answer = string | undefined | (() => Promise<string | undefined>);

export interface ScriptedTerminal extends Terminal {
  /** Everything written and every prompt, in order. */
  readonly transcript: string[];
  readonly closed: boolean;
}

/**
 * Answers prompts from a list; past its end every prompt gets end of input. A function answer
 * runs when its prompt is asked, so a test can change the disk at that point of the conversation.
 */
export function scriptedTerminal(answers: readonly Answer[]): ScriptedTerminal {
  const transcript: string[] = [];
  let next = 0;
  let closed = false;
  return {
    transcript,
    get closed() {
      return closed;
    },
    write: (text) => void transcript.push(text),
    ask: async (prompt) => {
      transcript.push(prompt);
      const answer = answers[next++];
      return typeof answer === "function" ? answer() : answer;
    },
    close: () => {
      closed = true;
    },
  };
}
