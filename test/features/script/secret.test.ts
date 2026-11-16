import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secretUrlHost } from "../../../src/features/script/secret.ts";
import { run } from "../../../src/main.ts";
import { fakeSecrets, tempHome, testDeps } from "../../helpers.ts";

function setup(stdin: string) {
  const home = tempHome();
  const data = join(home, "data");
  const secrets = fakeSecrets();
  const deps = testDeps({
    env: { HOME: home, TARS_DATA_DIR: data },
    secrets,
    readSecret: async () => stdin,
  });
  return { deps, secrets, typeFile: join(data, "scripts/secrets/bark.json") };
}

describe("tars secret set", () => {
  test("stores the trimmed value under script:<kind> and records its type, printing no value", async () => {
    const { deps, secrets, typeFile } = setup('  {"url":"https://x.example","key":"k-123456"}\n');
    expect(await run(["secret", "set", "bark"], deps)).toBe(0);
    expect(secrets.entries.get("script:bark")).toBe('{"url":"https://x.example","key":"k-123456"}');
    expect(JSON.parse(readFileSync(typeFile, "utf8"))).toEqual({ type: "static" });
    expect(deps.io.stdout.join("\n")).not.toContain("k-123456");
  });

  test("broken JSON is refused and nothing is stored", async () => {
    const { deps, secrets, typeFile } = setup('{"url": ');
    expect(await run(["secret", "set", "bark"], deps)).toBe(1);
    expect(secrets.entries.size).toBe(0);
    expect(existsSync(typeFile)).toBe(false);
  });

  test("an empty value is refused", async () => {
    const { deps } = setup("  \n");
    expect(await run(["secret", "set", "bark"], deps)).toBe(1);
  });

  test("a kind that is not a slug is a usage error", async () => {
    const { deps } = setup("x");
    expect(await run(["secret", "set", "../claude-oauth-token"], deps)).toBe(2);
  });

  test("delete removes the value and the type and is fine to repeat", async () => {
    const { deps, secrets, typeFile } = setup("token-value");
    await run(["secret", "set", "bark"], deps);
    expect(await run(["secret", "delete", "bark"], deps)).toBe(0);
    expect(await run(["secret", "delete", "bark"], deps)).toBe(0);
    expect(secrets.entries.size).toBe(0);
    expect(existsSync(typeFile)).toBe(false);
  });
});

describe("secretUrlHost", () => {
  test("gives host and port", () => {
    expect(secretUrlHost('{"url":"http://127.0.0.1:5000/x","key":"k"}')).toBe("127.0.0.1:5000");
  });

  test.each([
    ["not json", "must be JSON"],
    ['{"url":"https://x.example"}', '"url" and "key"'],
    ['{"url":"file:///etc/passwd","key":"k"}', "http or https"],
  ])("%p is refused", (value, message) => {
    const result = secretUrlHost(value);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain(message);
  });
});
