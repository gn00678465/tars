import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLock } from "../../../src/features/script/lock.ts";
import { parseScriptMeta } from "../../../src/features/script/metadata.ts";
import { publishSubmission, type Submission } from "../../../src/features/script/pending.ts";
import {
  parsePythonVersion,
  SYSTEM_PYTHON,
  type PythonVersion,
  type Toolchain,
} from "../../../src/features/script/supply.ts";
import { tempHome } from "../../helpers.ts";
import { sampleScript } from "./sample.ts";

export const PYTHON = parsePythonVersion(
  Bun.spawnSync([SYSTEM_PYTHON, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"])
    .stdout.toString()
    .trim(),
) as PythonVersion;

/** The lock uv writes for a script without dependencies. */
export const ZERO_DEP_LOCK = `version = 1
revision = 5
requires-python = ">=3.12"

[options]
exclude-newer-span = "P7D"
`;

/** The index a lock without packages never contacts. */
export const NO_INDEX = "http://127.0.0.1:9/simple";

/** A fresh HOME and uv cache, so uv never reads the real ones. */
export function testToolchain(index = NO_INDEX): Toolchain {
  const home = tempHome();
  return {
    index,
    python: { path: SYSTEM_PYTHON, version: PYTHON },
    path: process.env.PATH ?? "",
    realHome: home,
    cacheDir: join(home, "uv-cache"),
  };
}

/** A script that locks without the network and needs no secret. */
export function plainScript(name: string, body = "print('v1')"): string {
  return sampleScript({
    dependencies: [],
    body,
    tarsLines: [
      `name = "${name}"`,
      'summary = "prints one line"',
      'effects = "read-only"',
      'args = "<text>"',
      'outputs = "one line"',
      'exit = { 0 = "ok" }',
    ],
  });
}

export function draftDir(source: string | Uint8Array): string {
  const dir = join(tempHome(), "draft");
  mkdirSync(dir);
  writeFileSync(join(dir, "script.py"), source);
  return dir;
}

/** A submission that passed a stand-in gate 1: the hand-written lock, no uv, no venv. */
export async function submitted(
  scriptsDir: string,
  source: string,
  now = new Date(),
): Promise<Submission> {
  const made = await publishSubmission(
    scriptsDir,
    parseScriptMeta(source).name,
    source,
    now,
    async (dir) => {
      writeFileSync(join(dir, "script.py.lock"), ZERO_DEP_LOCK);
      const parsed = parseLock(ZERO_DEP_LOCK, NO_INDEX);
      if (!parsed.ok) throw new Error("the fixture lock does not parse");
      return parsed.lock;
    },
  );
  if (made === undefined) throw new Error("the fixture submission was refused");
  return made;
}
