import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import { resolvePaths } from "../../../src/core/paths.ts";
import { CONFIG_TEMPLATE } from "../../../src/features/agent/config.ts";
import { run } from "../../../src/main.ts";
import { fakeSecrets, scriptedTerminal, tempHome, testDeps } from "../../helpers.ts";

function setup(answers: (string | undefined)[] = [], extraEnv: Record<string, string> = {}) {
  const home = tempHome();
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "cfg"),
    TARS_DATA_DIR: join(home, "data"),
    ...extraEnv,
  };
  const secrets = fakeSecrets();
  const terminal = scriptedTerminal(answers);
  const deps = testDeps({ env, secrets, openTerminal: () => terminal });
  return { deps, secrets, terminal, paths: resolvePaths(env) };
}

describe("tars config init", () => {
  test("writes the template, creating the directory; a second run is exit 1 and keeps the file", async () => {
    const { deps, paths } = setup();
    expect(await run(["config", "init"], deps)).toBe(0);
    expect(readFileSync(paths.configFile, "utf8")).toBe(CONFIG_TEMPLATE);
    writeFileSync(paths.configFile, "# mine\n");
    expect(await run(["config", "init"], deps)).toBe(1);
    expect(readFileSync(paths.configFile, "utf8")).toBe("# mine\n");
  });

  test("is refused inside a tars session", async () => {
    const { deps } = setup([], { TARS_IN_SESSION: "1" });
    expect(await run(["config", "init"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("只能在你自己的終端執行");
  });
});

describe("tars llm key", () => {
  test("set reads the key on the terminal and stores it under llm:<provider>", async () => {
    const { deps, secrets, terminal } = setup(["  sk-test-123  "]);
    expect(await run(["llm", "key", "set", "anthropic"], deps)).toBe(0);
    expect(secrets.entries.get("llm:anthropic")).toBe("sk-test-123");
    expect(terminal.closed).toBe(true);
    expect([...deps.io.stdout, ...deps.io.stderr].join("\n")).not.toContain("sk-test-123");
  });

  test("set refuses an empty key and end of input", async () => {
    for (const answer of ["   ", undefined]) {
      const { deps, secrets } = setup([answer]);
      expect(await run(["llm", "key", "set", "anthropic"], deps)).toBe(1);
      expect(secrets.entries.size).toBe(0);
    }
  });

  test("set without a terminal fails without reading stdin", async () => {
    const { deps, secrets } = setup();
    const noTty = {
      ...deps,
      openTerminal: () => {
        throw new TarsError("no terminal");
      },
    };
    expect(await run(["llm", "key", "set", "anthropic"], noTty)).toBe(1);
    expect(secrets.entries.size).toBe(0);
  });

  test("an unknown provider is a usage error", async () => {
    const { deps } = setup(["k"]);
    expect(await run(["llm", "key", "set", "openai"], deps)).toBe(2);
    expect(await run(["llm", "key", "delete", "openai"], deps)).toBe(2);
  });

  test("set and delete are refused inside a tars session", async () => {
    const { deps, secrets } = setup(["k", "yes"], { TARS_IN_SESSION: "1" });
    await secrets.set("llm:anthropic", "existing");
    expect(await run(["llm", "key", "set", "anthropic"], deps)).toBe(1);
    expect(await run(["llm", "key", "delete", "anthropic"], deps)).toBe(1);
    expect(secrets.entries.get("llm:anthropic")).toBe("existing");
  });

  test("delete needs yes on the terminal", async () => {
    const no = setup(["no"]);
    await no.secrets.set("llm:anthropic", "k");
    expect(await run(["llm", "key", "delete", "anthropic"], no.deps)).toBe(1);
    expect(no.secrets.entries.has("llm:anthropic")).toBe(true);

    const yes = setup(["yes"]);
    await yes.secrets.set("llm:anthropic", "k");
    expect(await run(["llm", "key", "delete", "anthropic"], yes.deps)).toBe(0);
    expect(yes.secrets.entries.has("llm:anthropic")).toBe(false);
  });

  test("status says which providers have a key and never prints it; it works in a session", async () => {
    const { deps, secrets } = setup([], { TARS_IN_SESSION: "1" });
    await secrets.set("llm:anthropic", "sk-secret-value");
    expect(await run(["llm", "key", "status"], deps)).toBe(0);
    expect(deps.io.stdout).toEqual(["anthropic\t已設定", "gemini\t未設定", "openrouter\t未設定"]);
    expect(deps.io.stdout.join("\n")).not.toContain("sk-secret-value");
  });
});
