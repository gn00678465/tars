import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secretUrlHost } from "../../../src/features/script/secret.ts";
import { run } from "../../../src/main.ts";
import { fakeSecrets, tempHome, testDeps } from "../../helpers.ts";
import { CREDENTIAL } from "./fake-google.ts";

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

  test.each(["123", "null", "[1]"])(
    "a google-oauth secret that is JSON but not an object (%s) is refused",
    async (value) => {
      const { deps, secrets } = setup(value);
      expect(await run(["secret", "set", "gcal", "--type", "google-oauth"], deps)).toBe(1);
      expect(secrets.entries.size).toBe(0);
    },
  );

  test.each([
    ['{"client_id":"a","client_secret":"b","refresh_token":"c"}', '"scope"'],
    ['{"url":"https://x.example","key":"k-123456"}', '"client_id"'],
  ])("a google-oauth secret without its four fields (%s) is refused", async (value, field) => {
    const { deps, secrets } = setup(value);
    expect(await run(["secret", "set", "gcal", "--type", "google-oauth"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain(field);
    expect(secrets.entries.size).toBe(0);
  });

  test("a google-oauth credential is typed on disk before it reaches the keyring", async () => {
    const { deps, secrets, typeFile } = setup(CREDENTIAL);
    const gcalType = typeFile.replace("bark.json", "gcal.json");
    let typeAtWrite: string | undefined;
    const set = secrets.set;
    secrets.set = async (name, value) => {
      typeAtWrite = existsSync(gcalType) ? readFileSync(gcalType, "utf8") : undefined;
      await set(name, value);
    };
    expect(await run(["secret", "set", "gcal", "--type", "google-oauth"], deps)).toBe(0);
    expect(JSON.parse(typeAtWrite ?? "null")).toEqual({ type: "google-oauth" });
    expect(secrets.entries.get("script:gcal")).toBe(CREDENTIAL);
    expect(deps.io.stdout.join("\n")).toBe("saved script:gcal (google-oauth)");
  });

  test("a static value replacing a google-oauth one keeps that type until the value is in", async () => {
    const { deps, secrets, typeFile } = setup(CREDENTIAL);
    const gcalType = typeFile.replace("bark.json", "gcal.json");
    await run(["secret", "set", "gcal", "--type", "google-oauth"], deps);
    let typeAtWrite = "";
    const set = secrets.set;
    secrets.set = async (name, value) => {
      typeAtWrite = readFileSync(gcalType, "utf8");
      await set(name, value);
    };
    expect(await run(["secret", "set", "gcal"], deps)).toBe(0);
    expect(JSON.parse(typeAtWrite)).toEqual({ type: "google-oauth" });
    expect(JSON.parse(readFileSync(gcalType, "utf8"))).toEqual({ type: "static" });
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

describe("tars secret list", () => {
  test("lists each stored kind with its type and keyring state, and no value", async () => {
    const { deps, secrets } = setup("token-value");
    await run(["secret", "set", "bark"], deps);
    await run(["secret", "set", "fava"], deps);
    secrets.entries.delete("script:fava");
    deps.io.stdout.length = 0;
    expect(await run(["secret", "list"], deps)).toBe(0);
    expect(deps.io.stdout).toEqual(["bark\tstatic\tstored", "fava\tstatic\tmissing"]);

    deps.io.stdout.length = 0;
    expect(await run(["secret", "list", "--json"], deps)).toBe(0);
    expect(JSON.parse(deps.io.stdout.join(""))).toEqual([
      { kind: "bark", type: "static", state: "stored" },
      { kind: "fava", type: "static", state: "missing" },
    ]);
    expect(deps.io.stdout.join("\n")).not.toContain("token-value");
  });

  test("nothing stored prints nothing on stdout and exits 0", async () => {
    const { deps } = setup("");
    expect(await run(["secret", "list"], deps)).toBe(0);
    expect(deps.io.stdout).toEqual([]);
    expect(await run(["secret", "list", "--json"], deps)).toBe(0);
    expect(deps.io.stdout).toEqual(["[]"]);
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
