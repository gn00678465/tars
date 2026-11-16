import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { trialNetwork } from "../../../src/features/script/execute.ts";
import { requireScriptMeta } from "../../../src/features/script/metadata.ts";
import { run } from "../../../src/main.ts";
import { seccompHelper } from "../../../src/features/script/seccomp.ts";
import { fakeSecrets, tempHome, testDeps } from "../../helpers.ts";
import { plainScript, submitted } from "./gates.ts";
import { approveSample, installSample, sampleScript } from "./sample.ts";

function setup(secrets = fakeSecrets()) {
  const home = tempHome();
  const data = join(home, "data");
  const scripts = join(data, "scripts");
  const deps = testDeps({ env: { HOME: home, TARS_DATA_DIR: data }, secrets });
  const dir = installSample(scripts, "bark-push");
  const version = join(dir, "versions", "0123456789abcdef");
  approveSample(version, sampleScript({ name: "bark-push" }), "lock");
  return { deps, version };
}

describe("tars script run refuses before the sandbox", () => {
  test("a script changed after approval", async () => {
    const { deps, version } = setup();
    writeFileSync(join(version, "script.py"), `${sampleScript({ name: "bark-push" })}# x\n`);
    expect(await run(["script", "run", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("changed after approval");
  });

  test("a lock file changed after approval", async () => {
    const { deps, version } = setup();
    writeFileSync(join(version, "script.py.lock"), "other");
    expect(await run(["script", "run", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("script.py.lock changed");
  });

  test("a missing secret, with the command the user should run", async () => {
    const { deps } = setup();
    expect(await run(["script", "run", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("tars secret set bark");
  });

  test('a "secret:url" secret without a url', async () => {
    const { deps } = setup(fakeSecrets({ "script:bark": "just-a-token" }));
    expect(await run(["script", "run", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("must be JSON");
    expect(deps.io.stderr.join("\n")).not.toContain("just-a-token");
  });

  test("an approval.json that is not an object", async () => {
    const { deps, version } = setup();
    writeFileSync(join(version, "approval.json"), "null");
    expect(await run(["script", "run", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("approval.json is not an object");
  });

  test("a broken secret type file, with the command that fixes it", async () => {
    const { deps } = setup(fakeSecrets({ "script:bark": "token-value" }));
    const types = join(deps.env.TARS_DATA_DIR ?? "", "scripts/secrets");
    mkdirSync(types, { recursive: true });
    writeFileSync(join(types, "bark.json"), "{");
    expect(await run(["script", "run", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("tars secret set bark");
  });

  test("--timeout outside 1 to 3600 is a usage error", async () => {
    const { deps } = setup();
    expect(await run(["script", "run", "bark-push", "--timeout", "0"], deps)).toBe(2);
  });
});

describe("tars script trial builds a missing venv", () => {
  test("without uv on PATH it exits 1 and says to install uv", async () => {
    const home = tempHome();
    const data = join(home, "data");
    await submitted(join(data, "scripts"), plainScript("bark-push"));
    const deps = testDeps({ env: { HOME: home, TARS_DATA_DIR: data, PATH: tempHome() } });
    expect(await run(["script", "trial", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("uv is not on PATH");
  });
});

describe("tars script trial refuses before the sandbox", () => {
  test("a script.py changed after gate 1, and records no trial", async () => {
    const home = tempHome();
    const data = join(home, "data");
    const made = await submitted(join(data, "scripts"), plainScript("bark-push"));
    writeFileSync(join(made.dir, "script.py"), plainScript("bark-push", "print('swapped')"));
    const deps = testDeps({ env: { HOME: home, TARS_DATA_DIR: data, PATH: tempHome() } });
    expect(await run(["script", "trial", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("script.py changed after gate 1");
    expect(existsSync(join(made.dir, "trials"))).toBe(false);
  });

  test("a name with nothing submitted", async () => {
    const home = tempHome();
    const deps = testDeps({ env: { HOME: home, TARS_DATA_DIR: join(home, "data") } });
    expect(await run(["script", "trial", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("nothing is submitted for bark-push");
  });
});

describe("seccompHelper", () => {
  test("writes the helper once, executable, and replaces a tampered copy", async () => {
    const data = tempHome();
    const embedded = [
      Object.assign(new Blob(["helper-bytes"]), {
        name: "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp",
      }),
    ];
    if (process.arch !== "x64") return;
    const path = await seccompHelper(data, embedded);
    expect(readFileSync(path, "utf8")).toBe("helper-bytes");
    expect(statSync(path).mode & 0o111).not.toBe(0);
    writeFileSync(path, "tampered");
    expect(await seccompHelper(data, embedded)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("helper-bytes");
  });

  test("a right copy without the execute bit, or a dangling symlink, is replaced", async () => {
    const data = tempHome();
    const path = await seccompHelper(data, []);
    chmodSync(path, 0o644);
    expect(await seccompHelper(data, [])).toBe(path);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    rmSync(path);
    symlinkSync(join(data, "nowhere"), path);
    expect(await seccompHelper(data, [])).toBe(path);
    expect(statSync(path).size).toBeGreaterThan(1000);
  });

  test("without an embedded copy it reads the one in node_modules", async () => {
    const path = await seccompHelper(tempHome(), []);
    expect(statSync(path).size).toBeGreaterThan(1000);
  });
});

describe("trialNetwork", () => {
  const meta = (effects: string, domains: string) =>
    requireScriptMeta(
      sampleScript({
        tarsLines: [
          'name = "probe"',
          'summary = "s"',
          `effects = "${effects}"`,
          `domains = ${domains}`,
          'args = "a"',
          'outputs = "o"',
          'exit = { 0 = "ok" }',
        ],
      }),
    );

  test("an external-write script gets no network in a trial, even for hosts it declares", () => {
    expect(trialNetwork(meta("external-write", '["api.example.com"]'))).toEqual({ kind: "none" });
  });

  test("other scripts keep the hosts they declare", () => {
    expect(trialNetwork(meta("read-only", '["api.example.com"]'))).toEqual({
      kind: "allow",
      hosts: ["api.example.com"],
    });
    expect(trialNetwork(meta("local-write", '["*"]'))).toEqual({ kind: "open" });
  });
});
