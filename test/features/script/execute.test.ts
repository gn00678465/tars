import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../../src/main.ts";
import { seccompHelper } from "../../../src/features/script/seccomp.ts";
import { sha256 } from "../../../src/features/script/execute.ts";
import { fakeSecrets, tempHome, testDeps } from "../../helpers.ts";
import { installSample, sampleScript } from "./sample.ts";

// Every case here is refused before the sandbox starts, so no test spawns bwrap.
function setup(secrets = fakeSecrets()) {
  const home = tempHome();
  const data = join(home, "data");
  const scripts = join(data, "scripts");
  const deps = testDeps({ env: { HOME: home, TARS_DATA_DIR: data }, secrets });
  const dir = installSample(scripts, "bark-push");
  const version = join(dir, "versions", "0123456789abcdef");
  const source = sampleScript({ name: "bark-push" });
  writeFileSync(join(version, "script.py.lock"), "lock");
  writeFileSync(
    join(version, "approval.json"),
    JSON.stringify({ script: sha256(source), lock: sha256("lock") }),
  );
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

  test("--timeout outside 1 to 3600 is a usage error", async () => {
    const { deps } = setup();
    expect(await run(["script", "run", "bark-push", "--timeout", "0"], deps)).toBe(2);
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

  test("without an embedded copy it reads the one in node_modules", async () => {
    const path = await seccompHelper(tempHome(), []);
    expect(statSync(path).size).toBeGreaterThan(1000);
  });
});
