import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import {
  ensureVenv,
  parsePythonVersion,
  SYSTEM_PYTHON,
  type PythonVersion,
  type Toolchain,
  type Venv,
} from "../../../src/features/script/supply.ts";
import { tempHome } from "../../helpers.ts";
import { fakePypi, type FakePypi } from "./fake-pypi.ts";

setDefaultTimeout(30_000);

const PYTHON = parsePythonVersion(
  Bun.spawnSync([SYSTEM_PYTHON, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"])
    .stdout.toString()
    .trim(),
) as PythonVersion;
const ALPHA_WHEEL = "alpha-1.0-py3-none-any.whl";

let pypi: FakePypi;
beforeEach(() => {
  pypi = fakePypi();
  pypi.wheel("alpha", "1.0", { requires: ["beta"] });
  pypi.wheel("beta", "1.0");
});
afterEach(() => pypi.stop());

/** A fresh HOME and uv cache for every toolchain, so no test reuses another's downloads. */
function toolchain(overrides: Partial<Toolchain> = {}): Toolchain {
  const home = tempHome();
  return {
    index: pypi.index,
    python: { path: SYSTEM_PYTHON, version: PYTHON },
    path: process.env.PATH ?? "",
    realHome: home,
    cacheDir: join(home, "uv-cache"),
    ...overrides,
  };
}

function scriptText(deps: readonly string[]): string {
  return `# /// script\n# requires-python = ">=3.12"\n# dependencies = ${JSON.stringify(deps)}\n# ///\nimport sys\n`;
}

/** A script directory whose lock uv made with gate 1's flags. Async: the fake index shares this event loop. */
async function lockedScript(deps: readonly string[] = ["alpha"]): Promise<string> {
  const dir = tempHome();
  writeFileSync(join(dir, "script.py"), scriptText(deps));
  const t = toolchain();
  const proc = Bun.spawn(
    [
      "uv",
      "lock",
      "--script",
      join(dir, "script.py"),
      "--exclude-newer",
      "P7D",
      "--no-build",
    ].concat(["--default-index", t.index]),
    {
      env: { PATH: t.path, HOME: t.realHome, UV_CACHE_DIR: t.cacheDir, UV_NO_CONFIG: "1" },
      stderr: "pipe",
    },
  );
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return dir;
}

const ZERO_DEP_LOCK = `version = 1
revision = 5
requires-python = ">=3.12"

[options]
exclude-newer-span = "P7D"
`;

/** A script directory with a hand-written lock, for checks that end before uv resolves anything. */
function handLocked(lock = ZERO_DEP_LOCK): string {
  const dir = tempHome();
  writeFileSync(join(dir, "script.py"), scriptText([]));
  writeFileSync(join(dir, "script.py.lock"), lock);
  return dir;
}

const hidden = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("."));
const imports = (venv: Venv, module: string) =>
  Bun.spawnSync([venv.python, "-c", `import ${module}`]).exitCode === 0;

async function refusal(promise: Promise<unknown>): Promise<TarsError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TarsError);
  return err as TarsError;
}

describe("ensureVenv", () => {
  test("builds venv-<version> from the lock, indirect dependencies included", async () => {
    const dir = await lockedScript();
    const venv = await ensureVenv(dir, toolchain());
    expect(venv.dir).toBe(join(dir, `venv-${PYTHON}`));
    expect(imports(venv, "alpha, beta")).toBe(true);
    expect(hidden(dir)).toEqual([]);
  });

  test("a wheel whose bytes no longer match the lock leaves no venv and no temp directory", async () => {
    const dir = await lockedScript();
    pypi.tamper(ALPHA_WHEEL);
    const err = await refusal(ensureVenv(dir, toolchain()));
    expect(err.message).toContain("uv pip failed");
    expect(existsSync(join(dir, `venv-${PYTHON}`))).toBe(false);
    expect(hidden(dir)).toEqual([]);
  });

  test("a venv for another Python is kept and one for this Python is built beside it", async () => {
    const dir = await lockedScript();
    mkdirSync(join(dir, "venv-3.99"));
    writeFileSync(join(dir, "venv-3.99", "pyvenv.cfg"), "version_info = 3.99.1\n");
    const venv = await ensureVenv(dir, toolchain());
    expect(readFileSync(join(venv.dir, "pyvenv.cfg"), "utf8")).toContain(
      `version_info = ${PYTHON}`,
    );
    expect(imports(venv, "alpha")).toBe(true);
    expect(readFileSync(join(dir, "venv-3.99", "pyvenv.cfg"), "utf8")).toBe(
      "version_info = 3.99.1\n",
    );
  });

  test("venv-<version> whose pyvenv.cfg names another Python is refused, not replaced", async () => {
    const dir = await lockedScript();
    const target = join(dir, `venv-${PYTHON}`);
    mkdirSync(target);
    writeFileSync(join(target, "pyvenv.cfg"), "version_info = 3.99.1\n");
    const err = await refusal(ensureVenv(dir, toolchain()));
    expect(err.message).toContain(target);
    expect(readFileSync(join(target, "pyvenv.cfg"), "utf8")).toBe("version_info = 3.99.1\n");
  });

  test("an interpreter that is not the version it claims leaves no venv", async () => {
    const dir = await lockedScript();
    const err = await refusal(
      ensureVenv(
        dir,
        toolchain({ python: { path: SYSTEM_PYTHON, version: "3.99" as PythonVersion } }),
      ),
    );
    expect(err.message).toContain("not 3.99");
    expect(readdirSync(dir).filter((n) => n.includes("venv"))).toEqual([]);
  });

  test("two concurrent builds in one process converge on one venv", async () => {
    const dir = await lockedScript();
    pypi.hold(ALPHA_WHEEL, 2);
    const [a, b] = await Promise.all([ensureVenv(dir, toolchain()), ensureVenv(dir, toolchain())]);
    expect(pypi.downloads.filter((f) => f === ALPHA_WHEEL).length).toBeGreaterThanOrEqual(3);
    expect(a).toEqual(b as Venv);
    expect(readdirSync(dir).filter((n) => n.includes("venv"))).toEqual([`venv-${PYTHON}`]);
    expect(imports(a, "alpha")).toBe(true);
  });

  test("two concurrent builds in separate processes converge on one venv", async () => {
    const dir = await lockedScript();
    pypi.hold(ALPHA_WHEEL, 2);
    const build = () =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "build-venv.ts"),
          dir,
          JSON.stringify(toolchain()),
        ],
        { env: { PATH: process.env.PATH ?? "", HOME: tempHome() }, stdout: "pipe", stderr: "pipe" },
      );
    const procs = [build(), build()];
    const results = await Promise.all(
      procs.map(async (p) => ({
        exit: await p.exited,
        out: (await new Response(p.stdout).text()).trim(),
        err: await new Response(p.stderr).text(),
      })),
    );
    expect(results.map((r) => [r.exit, r.out, r.err])).toEqual([
      [0, join(dir, `venv-${PYTHON}`), ""],
      [0, join(dir, `venv-${PYTHON}`), ""],
    ]);
    expect(readdirSync(dir).filter((n) => n.includes("venv"))).toEqual([`venv-${PYTHON}`]);
  });

  test("a lock that no longer matches script.py is refused", async () => {
    const dir = await lockedScript();
    writeFileSync(join(dir, "script.py"), scriptText(["alpha", "beta"]));
    const err = await refusal(ensureVenv(dir, toolchain()));
    expect(err.message).toContain("submit it again");
    expect(existsSync(join(dir, `venv-${PYTHON}`))).toBe(false);
  });

  test("a lock that breaks the policy is refused before uv runs, with every problem", async () => {
    const lock = `${ZERO_DEP_LOCK}
[[package]]
name = "alpha"
version = "1.0"
source = { git = "https://example.com/alpha.git" }
wheels = [{ url = "https://example.com/alpha.whl" }]
`;
    const err = await refusal(ensureVenv(handLocked(lock), toolchain({ path: tempHome() })));
    expect(err.message).toContain("alpha comes from");
    expect(err.message).toContain("has no sha256");
    expect(err.message).not.toContain("uv is not on PATH");
  });

  test("without uv on PATH it fails with exit code 1 and says to install uv", async () => {
    const err = await refusal(ensureVenv(handLocked(), toolchain({ path: tempHome() })));
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain("uv is not on PATH");
  });

  test("uv gets only the whitelisted environment", async () => {
    const bin = tempHome();
    const dump = join(tempHome(), "env");
    writeFileSync(
      join(bin, "uv"),
      `#!/bin/sh\ntr '\\0' '\\n' < /proc/$$/environ > '${dump}'\nexit 1\n`,
      { mode: 0o755 },
    );
    process.env.UV_INDEX_URL = "https://mirror.example/simple";
    try {
      const t = toolchain({ path: `${bin}:/usr/bin:/bin` });
      await refusal(ensureVenv(handLocked(), t));
      expect(readFileSync(dump, "utf8").trim().split("\n").sort()).toEqual([
        `HOME=${t.realHome}`,
        `PATH=${t.path}`,
        `UV_CACHE_DIR=${t.cacheDir}`,
        "UV_NO_CONFIG=1",
        "UV_PYTHON_DOWNLOADS=never",
      ]);
    } finally {
      delete process.env.UV_INDEX_URL;
    }
  });

  test("a venv made by python -m venv is used as it is, without uv or a lock", async () => {
    const dir = tempHome();
    const target = join(dir, `venv-${PYTHON}`);
    expect(Bun.spawnSync([SYSTEM_PYTHON, "-m", "venv", "--without-pip", target]).exitCode).toBe(0);
    expect(await ensureVenv(dir, toolchain({ path: tempHome() }))).toEqual({
      dir: target,
      python: join(target, "bin", "python"),
    });
  });

  test("without a venv or a lock it says the lock is missing", async () => {
    const err = await refusal(ensureVenv(tempHome(), toolchain()));
    expect(err.message).toContain("script.py.lock is missing");
  });
});
