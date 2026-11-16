import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import {
  approvePackages,
  ensureVenv,
  parsePythonVersion,
  readApproved,
  SYSTEM_PYTHON,
  vetDependencies,
  type PythonVersion,
  type Toolchain,
  type Venv,
  type Vetting,
} from "../../../src/features/script/supply.ts";
import { normalizeName } from "../../../src/features/script/lock.ts";
import { tempHome } from "../../helpers.ts";
import { fakeOsv, type FakeOsv } from "./fake-osv.ts";
import { fakePypi, type FakePypi } from "./fake-pypi.ts";

setDefaultTimeout(30_000);

const PYTHON = parsePythonVersion(
  Bun.spawnSync([SYSTEM_PYTHON, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"])
    .stdout.toString()
    .trim(),
) as PythonVersion;
const ALPHA_WHEEL = "alpha-1.0-py3-none-any.whl";

let pypi: FakePypi;
let osv: FakeOsv;
beforeEach(() => {
  pypi = fakePypi();
  pypi.wheel("alpha", "1.0", { requires: ["beta"] });
  pypi.wheel("beta", "1.0");
  osv = fakeOsv();
});
afterEach(() => {
  pypi.stop();
  osv.stop();
});

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

function scriptText(deps: readonly string[], extra = ""): string {
  return `# /// script\n# requires-python = ">=3.12"\n# dependencies = ${JSON.stringify(deps)}\n${extra}# ///\nimport sys\n`;
}

function scriptDir(deps: readonly string[], extra = ""): string {
  const dir = tempHome();
  writeFileSync(join(dir, "script.py"), scriptText(deps, extra));
  return dir;
}

const vet = (dir: string, scriptsDir = tempHome()) =>
  vetDependencies(dir, { toolchain: toolchain(), osv: osv.endpoint, scriptsDir });

/** A script directory that passed vetDependencies. */
async function lockedScript(deps: readonly string[] = ["alpha"]): Promise<string> {
  const dir = scriptDir(deps);
  const vetting = await vet(dir);
  if (!vetting.ok) throw new Error(JSON.stringify(vetting.problems));
  return dir;
}

const problems = (v: Vetting) => (v.ok ? [] : v.problems);
const pinsOf = (v: Vetting) => (v.ok ? v.lock.pins.map((p) => `${p.name} ${p.version}`) : []);

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

describe("vetDependencies", () => {
  test("a package with only an sdist is refused without asking OSV", async () => {
    pypi.sdist("gamma", "1.0");
    const vetting = await vet(scriptDir(["gamma"]));
    expect(problems(vetting)).toEqual([
      { kind: "unresolvable", detail: expect.stringContaining("gamma==1.0 has no usable wheels") },
    ] as never);
    expect(osv.requests).toHaveLength(0);
  });

  test("a version uploaded within 7 days is not picked", async () => {
    pypi.wheel("alpha", "2.0", { requires: ["beta"], ageDays: 1 });
    expect(pinsOf(await vet(scriptDir(["alpha"])))).toEqual(["alpha 1.0", "beta 1.0"]);
    expect(problems(await vet(scriptDir(["alpha==2.0"])))[0]?.kind).toBe("unresolvable");
  });

  test("an advisory on an indirect dependency is refused", async () => {
    osv.stop();
    osv = fakeOsv({ beta: ["MAL-2026-1"] });
    expect(problems(await vet(scriptDir(["alpha"])))).toEqual([
      { kind: "advisory", pin: { name: "beta", version: "1.0" }, ids: ["MAL-2026-1"] },
    ] as never);
  });

  test("OSV answering 500 is refused", async () => {
    osv.stop();
    osv = fakeOsv({}, { status: 500 });
    expect(problems(await vet(scriptDir(["alpha"])))).toEqual([
      { kind: "osv-unavailable", detail: "OSV answered 500" },
    ]);
  });

  test("a script without dependencies is clean, asks OSV nothing, and gets a venv", async () => {
    const dir = scriptDir([]);
    const vetting = await vet(dir);
    expect(vetting.ok && vetting.newPackages).toEqual([]);
    expect(osv.requests).toHaveLength(0);
    expect(existsSync(join((await ensureVenv(dir, toolchain())).dir, "pyvenv.cfg"))).toBe(true);
  });

  test("lists the pinned names the user has not approved", async () => {
    const scripts = tempHome();
    const dir = scriptDir(["alpha"]);
    const fresh = await vet(dir, scripts);
    expect(fresh.ok && fresh.newPackages).toEqual(["alpha", "beta"] as never);
    await approvePackages(scripts, [normalizeName("alpha")]);
    await approvePackages(scripts, [normalizeName("alpha")]);
    expect([...(await readApproved(scripts))]).toEqual(["alpha"] as never);
    const later = await vet(dir, scripts);
    expect(later.ok && later.newPackages).toEqual(["beta"] as never);
  });

  test("reports every lock policy problem and sends none of the names to OSV", async () => {
    pypi.wheel("nohash", "1.0", { hashed: false });
    const url = pypi.index.replace(/simple$/, "files/alpha-1.0-py3-none-any.whl");
    const dir = scriptDir(
      ["alpha", "nohash"],
      `#\n# [tool.uv.sources]\n# alpha = { url = "${url}" }\n`,
    );
    osv.stop();
    osv = fakeOsv({ beta: ["GHSA-0000-0000-0000"] });
    expect(
      problems(await vet(dir))
        .map((p) => p.kind)
        .sort(),
    ).toEqual(["foreign-source", "no-hash"]);
    expect(osv.requests).toEqual([]);
  });

  test("locks from scratch, not from a lock already in the directory", async () => {
    pypi.wheel("alpha", "1.1", { requires: ["beta"] });
    const dir = scriptDir(["alpha<1.1"]);
    expect(pinsOf(await vet(dir))).toEqual(["alpha 1.0", "beta 1.0"]);
    writeFileSync(join(dir, "script.py"), scriptText(["alpha"]));
    expect(pinsOf(await vet(dir))).toEqual(["alpha 1.1", "beta 1.0"]);
  });
});
