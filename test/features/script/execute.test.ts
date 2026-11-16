import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { run } from "../../../src/main.ts";
import { seccompHelper } from "../../../src/features/script/seccomp.ts";
import { fakeSecrets, tempHome, testDeps } from "../../helpers.ts";
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
    const pending = join(data, "scripts", "pending", "bark-push");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "script.py"), sampleScript({ name: "bark-push" }));
    writeFileSync(
      join(pending, "script.py.lock"),
      'version = 1\n\n[options]\nexclude-newer-span = "P7D"\n',
    );
    const deps = testDeps({ env: { HOME: home, TARS_DATA_DIR: data, PATH: tempHome() } });
    expect(await run(["script", "trial", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("uv is not on PATH");
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
