import { expect, test } from "bun:test";
import { run } from "../../src/main.ts";
import { fakeSecrets, testDeps } from "../helpers.ts";

const TOKEN = "sk-ant-oat01-SECRET-VALUE";

test("tars auth claude stores the token from stdin and never prints it", async () => {
  const secrets = fakeSecrets();
  const deps = testDeps({ secrets, readSecret: async () => `${TOKEN}\n` });
  expect(await run(["auth", "claude"], deps)).toBe(0);
  expect(secrets.entries.get("claude-oauth-token")).toBe(TOKEN);
  expect(deps.io.stdout.join("\n")).toContain("stored claude-oauth-token");
  expect([...deps.io.stdout, ...deps.io.stderr].join("\n")).not.toContain("SECRET-VALUE");
});

test("empty input exits 1 and stores nothing", async () => {
  const secrets = fakeSecrets();
  expect(await run(["auth", "claude"], testDeps({ secrets, readSecret: async () => " \n" }))).toBe(
    1,
  );
  expect(secrets.entries.size).toBe(0);
});

test("input with more than one token exits 1, stores nothing, and does not echo it", async () => {
  const secrets = fakeSecrets();
  const deps = testDeps({ secrets, readSecret: async () => `${TOKEN}\nsecond-SECRET-VALUE\n` });
  expect(await run(["auth", "claude"], deps)).toBe(1);
  expect(secrets.entries.size).toBe(0);
  expect(deps.io.stderr.join("\n")).not.toContain("SECRET-VALUE");
});

test("an unknown harness or a missing harness name is a usage error with exit 2", async () => {
  expect(await run(["auth", "agy"], testDeps())).toBe(2);
  expect(await run(["auth"], testDeps())).toBe(2);
});
