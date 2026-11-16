import { lstat, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { uniqueTemp } from "../../core/fs.ts";
import { parseLock, QUARANTINE, type LockProblem } from "./lock.ts";

export const LOCK_FILE = "script.py.lock";

/** The venv's base interpreter must sit outside the real home, which the sandbox hides. */
export const SYSTEM_PYTHON = "/usr/bin/python3";

declare const brand: unique symbol;

/** "3.14": names venv-<version>/ and must match the major.minor in its pyvenv.cfg. */
export type PythonVersion = string & { readonly [brand]: "PythonVersion" };

/** Host facts for uv. Production builds it in runtime.ts; tests point `index` at a fake PyPI. */
export interface Toolchain {
  /** The only index uv resolves and installs from, and the only registry a lock may name. */
  readonly index: string;
  readonly python: { readonly path: string; readonly version: PythonVersion };
  /** Where uv is looked up; also uv's own PATH. */
  readonly path: string;
  /** From the account database, not $HOME. */
  readonly realHome: string;
  readonly cacheDir: string;
}

export interface Venv {
  readonly dir: string;
  readonly python: string;
}

export function parsePythonVersion(text: string): PythonVersion | undefined {
  return /^\d+\.\d+$/.test(text) ? (text as PythonVersion) : undefined;
}

/**
 * Returns <dir>/venv-<version>, building it from <dir>/script.py.lock when absent. A build happens
 * under a temporary name and is renamed into place; a caller that loses the rename to a
 * concurrent build removes its own copy and uses the winner's.
 */
export async function ensureVenv(dir: string, toolchain: Toolchain): Promise<Venv> {
  const version = toolchain.python.version;
  const target = join(dir, `venv-${version}`);
  const ready = await existingVenv(target, version);
  if (ready) return ready;
  const lockPath = join(dir, LOCK_FILE);
  const text = await readFile(lockPath, "utf8").catch(() => {
    throw new TarsError(`${lockPath} is missing; submit the script again`);
  });
  const parsed = parseLock(text, toolchain.index);
  if (!parsed.ok)
    throw new TarsError(
      `${lockPath} breaks the lock policy:\n${parsed.problems.map(lockProblemText).join("\n")}`,
    );
  const exported = await uv(
    [
      "export",
      "--script",
      join(dir, "script.py"),
      "--locked",
      "--exclude-newer",
      QUARANTINE,
      "--format",
      "requirements.txt",
      "--no-header",
      "--quiet",
      "--default-index",
      toolchain.index,
    ],
    toolchain,
  );
  if (exported.exit !== 0)
    throw new TarsError(
      `uv cannot export ${lockPath}; if script.py changed, submit it again:\n${exported.stderr.trim()}`,
    );
  const temp = uniqueTemp(target);
  try {
    await uvOrThrow(
      ["venv", "--quiet", "--relocatable", "--python", toolchain.python.path, temp],
      toolchain,
    );
    await uvOrThrow(
      [
        "pip",
        "install",
        "--quiet",
        "--python",
        join(temp, "bin", "python"),
        "--require-hashes",
        "--no-deps",
        "--only-binary",
        ":all:",
        "--default-index",
        toolchain.index,
        "-r",
        "-",
      ],
      toolchain,
      exported.stdout,
    );
    const built = await venvVersion(temp);
    if (built !== version)
      throw new TarsError(
        `${toolchain.python.path} built a venv for Python ${built ?? "unknown"}, not ${version}`,
      );
    await rename(temp, target).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOTEMPTY" && err.code !== "EEXIST") throw err;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const venv = await existingVenv(target, version);
  if (!venv) throw new TarsError(`${target} vanished after it was built`);
  return venv;
}

function lockProblemText(problem: LockProblem): string {
  switch (problem.kind) {
    case "malformed":
      return `the lock is malformed: ${problem.detail}`;
    case "foreign-source":
      return `${problem.name} comes from ${problem.source}, not the package index`;
    case "no-wheel":
      return `${problem.name} has no wheel`;
    case "no-hash":
      return `${problem.name}: ${problem.file} has no sha256`;
    case "no-age-rule":
      return `the lock was not made with --exclude-newer ${QUARANTINE}`;
  }
}

/** undefined when nothing is at `target`; a TarsError when something is but records another Python. */
async function existingVenv(target: string, version: PythonVersion): Promise<Venv | undefined> {
  if ((await lstat(target).catch(() => undefined)) === undefined) return undefined;
  const found = await venvVersion(target);
  if (found !== version)
    throw new TarsError(
      `${target} holds a venv for Python ${found ?? "unknown"}, not ${version}; remove it and try again`,
    );
  return { dir: target, python: join(target, "bin", "python") };
}

/** uv writes version_info, `python -m venv` writes version. */
async function venvVersion(venv: string): Promise<PythonVersion | undefined> {
  const cfg = await readFile(join(venv, "pyvenv.cfg"), "utf8").catch(() => "");
  const full = /^(?:version|version_info)\s*=\s*(\d+\.\d+)/m.exec(cfg)?.[1];
  return full === undefined ? undefined : parsePythonVersion(full);
}

interface UvResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

const UV_TIMEOUT_MS = 300_000;

/** The only place uv runs. Its environment is the whitelist alone, so the user's UV_* never reach it. */
async function uv(args: readonly string[], toolchain: Toolchain, stdin = ""): Promise<UvResult> {
  const bin = Bun.which("uv", { PATH: toolchain.path });
  if (!bin)
    throw new TarsError(
      "uv is not on PATH; scripts need it to build their environment. Install it: https://docs.astral.sh/uv/",
    );
  const proc = Bun.spawn([bin, ...args], {
    env: {
      PATH: toolchain.path,
      HOME: toolchain.realHome,
      UV_CACHE_DIR: toolchain.cacheDir,
      UV_NO_CONFIG: "1",
      UV_PYTHON_DOWNLOADS: "never",
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: UV_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (proc.signalCode !== null)
    throw new TarsError(
      `uv ${args[0]} was stopped by ${proc.signalCode} (limit ${UV_TIMEOUT_MS / 1000} s)`,
    );
  return { exit, stdout, stderr };
}

async function uvOrThrow(
  args: readonly string[],
  toolchain: Toolchain,
  stdin?: string,
): Promise<void> {
  const result = await uv(args, toolchain, stdin);
  if (result.exit !== 0) throw new TarsError(`uv ${args[0]} failed:\n${result.stderr.trim()}`);
}
