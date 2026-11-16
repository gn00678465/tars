import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gate1ProblemText,
  satisfiesPython,
  submit,
  type Gate1,
  type Gate1Context,
} from "../../../src/features/script/gate1.ts";
import { normalizeName } from "../../../src/features/script/lock.ts";
import { readSubmission } from "../../../src/features/script/pending.ts";
import { approvePackages, type PythonVersion } from "../../../src/features/script/supply.ts";
import { fakeSecrets, tempHome } from "../../helpers.ts";
import { fakeOsv, type FakeOsv } from "./fake-osv.ts";
import { fakePypi, type FakePypi } from "./fake-pypi.ts";
import { draftDir, plainScript, PYTHON, testToolchain } from "./gates.ts";
import { installSample, sampleScript } from "./sample.ts";

setDefaultTimeout(60_000);

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

const context = (scriptsDir: string, over: Partial<Gate1Context> = {}): Gate1Context => ({
  scriptsDir,
  secrets: fakeSecrets(),
  toolchain: testToolchain(pypi.index),
  osv: osv.endpoint,
  now: new Date(),
  ...over,
});

const kinds = (result: Gate1) => (result.ok ? [] : result.problems.map((p) => p.kind));
const texts = (result: Gate1) =>
  result.ok ? "" : result.problems.map(gate1ProblemText).join("\n");
const pendingNames = (scripts: string) =>
  existsSync(join(scripts, "pending")) ? readdirSync(join(scripts, "pending")) : [];

const withDeps = (name: string, dependencies: readonly string[], extra: string[] = []) =>
  sampleScript({
    dependencies,
    tarsLines: [
      `name = "${name}"`,
      'summary = "s"',
      'effects = "read-only"',
      'args = ""',
      'outputs = "o"',
      'exit = { 0 = "ok" }',
      ...extra,
    ],
  });

describe("submit", () => {
  test("a draft that passes is published with its venv, and reads back as the bytes of the draft", async () => {
    const scripts = tempHome();
    const source = plainScript("probe");
    const result = await submit(draftDir(source), context(scripts));
    if (!result.ok) throw new Error(texts(result));
    expect(result.base).toEqual({ kind: "none" });
    expect(result.newPackages).toEqual([]);
    const read = await readSubmission(scripts, "probe");
    expect(read).toEqual(result.submission);
    expect(read.source).toBe(source);
    expect(existsSync(join(read.dir, `venv-${PYTHON}`, "pyvenv.cfg"))).toBe(true);
  });

  test("locked packages the user has not approved are listed, until they are approved", async () => {
    const scripts = tempHome();
    const draft = draftDir(withDeps("probe", ["alpha"]));
    const first = await submit(draft, context(scripts));
    if (!first.ok) throw new Error(texts(first));
    expect([...first.newPackages].toSorted()).toEqual(["alpha", "beta"].map(normalizeName));
    await approvePackages(scripts, ["alpha", "beta"].map(normalizeName));
    const second = await submit(draft, context(scripts));
    expect(second.ok && second.newPackages).toEqual([]);
  });

  test("a script already in the library is reported as the base the submission updates", async () => {
    const scripts = tempHome();
    installSample(scripts, "probe", plainScript("probe", "print('old')"));
    const result = await submit(draftDir(plainScript("probe")), context(scripts));
    expect(result.ok && result.base.kind === "current" && result.base.script.version).toBe(
      "0123456789abcdef",
    );
  });

  test("secret and dependency problems are reported in one round, and nothing is published", async () => {
    const scripts = tempHome();
    osv.stop();
    osv = fakeOsv({ beta: ["GHSA-test-0001"] });
    const source = sampleScript({ name: "probe", dependencies: ["alpha"] });
    const result = await submit(draftDir(source), context(scripts));
    expect(kinds(result).toSorted()).toEqual(["secret-missing", "supply"]);
    expect(texts(result)).toContain("GHSA-test-0001");
    expect(texts(result)).toContain("tars secret set bark");
    expect(existsSync(join(scripts, "pending", "probe", "current"))).toBe(false);
    expect(readdirSync(join(scripts, "pending", "probe"))).toEqual([]);
  });

  test("a requires-python the system Python does not meet is reported with the secret problem, without asking uv", async () => {
    const scripts = tempHome();
    const source = sampleScript({
      name: "probe",
      requiresPython: ">=9.0",
      dependencies: ["alpha"],
    });
    const result = await submit(draftDir(source), context(scripts));
    expect(kinds(result)).toEqual(["python-excluded", "secret-missing"]);
    expect(pendingNames(scripts)).toEqual([]);
    const odd = sampleScript({ name: "probe", requiresPython: "===3.14", dependencies: [] });
    expect(kinds(await submit(draftDir(odd), context(scripts)))).toContain("python-unsupported");
  });

  test("a resubmit that fails gate 1 leaves the earlier submission under review", async () => {
    const scripts = tempHome();
    const first = await submit(draftDir(plainScript("probe")), context(scripts));
    if (!first.ok) throw new Error(texts(first));
    const bad = sampleScript({ name: "probe", dependencies: [] });
    expect(kinds(await submit(draftDir(bad), context(scripts)))).toEqual(["secret-missing"]);
    expect(await readSubmission(scripts, "probe")).toEqual(first.submission);
  });

  test("two submits of one name at once both finish, and exactly one complete submission is under review", async () => {
    const scripts = tempHome();
    const sources = [plainScript("probe", "print('a')"), plainScript("probe", "print('b')")];
    const results = await Promise.all(sources.map((s) => submit(draftDir(s), context(scripts))));
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    const read = await readSubmission(scripts, "probe");
    expect(sources).toContain(read.source);
    expect(existsSync(join(read.dir, `venv-${PYTHON}`, "pyvenv.cfg"))).toBe(true);
    await submit(draftDir(sources[0] ?? ""), context(scripts));
    expect(readdirSync(join(scripts, "pending", "probe")).toSorted()).toHaveLength(2);
  });

  test("metadata problems stop before anything is written", async () => {
    const scripts = tempHome();
    const result = await submit(
      draftDir(sampleScript({ name: "probe", extraTop: "[tool.uv]" })),
      context(scripts),
    );
    expect(kinds(result)).toContain("metadata");
    expect(pendingNames(scripts)).toEqual([]);
  });

  test("a script.py that is not UTF-8 is refused", async () => {
    const scripts = tempHome();
    const bytes = Buffer.concat([Buffer.from(plainScript("probe")), Buffer.from([0xff, 0xfe])]);
    expect(kinds(await submit(draftDir(bytes), context(scripts)))).toEqual(["encoding"]);
    expect(pendingNames(scripts)).toEqual([]);
  });

  test('a "secret:url" secret of the wrong shape is refused without printing it', async () => {
    const scripts = tempHome();
    const source = sampleScript({ name: "probe", dependencies: [] });
    const secrets = fakeSecrets({ "script:bark": "just-a-TOKEN-value" });
    const result = await submit(draftDir(source), context(scripts, { secrets }));
    expect(kinds(result)).toEqual(["secret-shape"]);
    expect(texts(result)).not.toContain("just-a-TOKEN-value");
    const ok = await submit(
      draftDir(source),
      context(scripts, {
        secrets: fakeSecrets({ "script:bark": '{"url": "https://push.example", "key": "k"}' }),
      }),
    );
    expect(ok.ok).toBe(true);
  });

  test("a google-oauth secret is refused, because run cannot use one yet", async () => {
    const scripts = tempHome();
    mkdirSync(join(scripts, "secrets"), { recursive: true });
    writeFileSync(join(scripts, "secrets", "bark.json"), '{"type":"google-oauth"}');
    const source = sampleScript({ name: "probe", dependencies: [] });
    const secrets = fakeSecrets({ "script:bark": '{"url": "https://push.example", "key": "k"}' });
    expect(kinds(await submit(draftDir(source), context(scripts, { secrets })))).toEqual([
      "secret-oauth",
    ]);
  });

  test("a directory without script.py is an error, not a gate 1 result", async () => {
    await expect(submit(tempHome(), context(tempHome()))).rejects.toThrow("no script.py");
  });
});

describe("satisfiesPython", () => {
  const on = (system: string) => (requires: string) =>
    satisfiesPython(requires, system as PythonVersion);

  test("clauses decided by major.minor", () => {
    const py = on("3.14");
    for (const yes of [">=3.12", ">=3.14", ">=3", ">3.13", "<3.15", "<=3.15", "<4", "==3.14.*"])
      expect([yes, py(yes)]).toEqual([yes, true]);
    for (const yes of ["==3.*", "!=3.13.*", "!=3.13", "~=3.12", "~=3.14.0", ">=3.12, <3.15"])
      expect([yes, py(yes)]).toEqual([yes, true]);
    for (const no of [">=3.15", ">3.14", "<3.14", "<=3.13", "==3.13.*", "!=3.14.*", "~=3.15"])
      expect([no, py(no)]).toEqual([no, false]);
    expect(py(">=3.12,<3.14")).toBe(false);
    expect(py(">=9.0")).toBe(false);
  });

  test("a clause that turns on the micro version of the system's own minor is refused", () => {
    const py = on("3.14");
    for (const unsure of [">=3.14.2", "<=3.14", "<3.14.9", "==3.14", "==3.14.8", "!=3.14.1"])
      expect([unsure, py(unsure)]).toEqual([unsure, false]);
    expect(py(">=3.13.5")).toBe(true);
    expect(py("<3.15.2")).toBe(true);
  });

  test("forms tars does not read are unsupported, not guessed", () => {
    const py = on("3.14");
    for (const odd of ["===3.14", ">=3.14.*", "3.14", ">=3.14rc1", "", "~=3", ">=3.12 ; x"])
      expect([odd, py(odd)]).toEqual([odd, undefined]);
  });
});
