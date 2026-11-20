import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../../../src/core/paths.ts";
import { CONFIG_TEMPLATE } from "../../../src/features/agent/config.ts";
import { openDb } from "../../../src/features/agent/db.ts";
import { insertReserved, recordFailure } from "../../../src/features/agent/ledger.ts";
import { run } from "../../../src/main.ts";
import { scriptedTerminal, tempHome, testDeps } from "../../helpers.ts";
import { MODEL, NOW, seedTurn } from "./db-fixture.ts";

function setup({
  config = true,
  extraEnv = {},
}: { config?: boolean; extraEnv?: Record<string, string> } = {}) {
  const home = tempHome();
  const env = {
    HOME: home,
    TARS_DATA_DIR: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    ...extraEnv,
  };
  const paths = resolvePaths(env);
  if (config) {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(paths.configFile, CONFIG_TEMPLATE);
  }
  return { env, paths };
}

const json = (stdout: string[]) => JSON.parse(stdout.join("\n"));

describe("tars cost", () => {
  test("without a database everything is 0 and no database is created", async () => {
    const { env, paths } = setup();
    const deps = testDeps({ env });
    expect(await run(["cost", "--json"], deps)).toBe(0);
    expect(json(deps.io.stdout)).toEqual({
      providers: [
        {
          provider: "anthropic",
          period: "utc-month",
          spentUsd: 0,
          quotaUsd: 100,
          warnUsd: 80,
          stopUsd: 95,
          todayUsd: 0,
          dailyCapUsd: 10,
          state: "ok",
        },
      ],
      recent: [],
    });
    expect(existsSync(paths.agentDb)).toBe(false);
  });

  test("--json lists the providers' totals and the recent requests", async () => {
    const { env, paths } = setup();
    const db = await openDb(paths);
    const turn = seedTurn(db);
    insertReserved(db, {
      ...turn,
      step: 1,
      attempt: 1,
      model: MODEL,
      cacheTtl: "5m",
      maxTokens: 0,
      inputUsd: 0.25,
      now: NOW,
    });
    db.close();
    const deps = testDeps({ env });
    expect(await run(["cost", "--json"], deps)).toBe(0);
    const out = json(deps.io.stdout);
    expect(out.providers[0]).toMatchObject({ spentUsd: 0.25, todayUsd: 0.25, state: "ok" });
    expect(out.recent).toEqual([
      {
        at: NOW.getTime(),
        model: MODEL.id,
        state: "reserved",
        costUsd: 0.25,
        costSource: "reserved",
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
      },
    ]);
  });

  test("the text form has one line per provider", async () => {
    const { env } = setup();
    const deps = testDeps({ env });
    expect(await run(["cost"], deps)).toBe(0);
    expect(deps.io.stdout).toHaveLength(1);
    expect(deps.io.stdout[0]).toStartWith("anthropic: ");
  });

  test("without config.toml it fails with exit 1", async () => {
    const { env } = setup({ config: false });
    const deps = testDeps({ env });
    expect(await run(["cost"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("tars config init");
  });
});

describe("tars cost adjust", () => {
  test("is refused inside a tars session", async () => {
    const { env, paths } = setup({ extraEnv: { TARS_IN_SESSION: "1" } });
    const deps = testDeps({ env, openTerminal: () => scriptedTerminal(["yes"]) });
    expect(await run(["cost", "adjust", "anthropic", "--spent", "12"], deps)).toBe(1);
    expect(existsSync(paths.agentDb)).toBe(false);
  });

  test("yes records the figure and tars cost reports it", async () => {
    const { env } = setup();
    const terminal = scriptedTerminal(["yes"]);
    const deps = testDeps({ env, openTerminal: () => terminal });
    expect(
      await run(["cost", "adjust", "anthropic", "--spent", "12.40", "--note", "console"], deps),
    ).toBe(0);
    expect(terminal.transcript.join("")).toContain("12.40");
    const after = testDeps({ env });
    expect(await run(["cost", "--json"], after)).toBe(0);
    expect(json(after.io.stdout).providers[0].spentUsd).toBe(12.4);
  });

  test("requests made while the question is open: finished ones are covered, in-flight ones count on top", async () => {
    const { env, paths } = setup();
    const db = await openDb(paths);
    const turn = seedTurn(db);
    let step = 0;
    const request = (usd: number) =>
      insertReserved(db, {
        ...turn,
        step: ++step,
        attempt: 1,
        model: MODEL,
        cacheTtl: "5m",
        maxTokens: 0,
        inputUsd: usd,
        now: NOW,
      });
    const settled = (usd: number) =>
      recordFailure(db, { usageId: request(usd), receivedStart: false, textBytes: 0 });
    settled(5);
    const terminal = scriptedTerminal([
      async () => {
        settled(3);
        request(2); // still reserved when the owner says yes
        return "yes";
      },
    ]);
    const deps = testDeps({ env, openTerminal: () => terminal });
    expect(await run(["cost", "adjust", "anthropic", "--spent", "12"], deps)).toBe(0);
    db.close();
    const after = testDeps({ env });
    expect(await run(["cost", "--json"], after)).toBe(0);
    expect(json(after.io.stdout).providers[0].spentUsd).toBe(14);
  });

  test("no leaves nothing on disk and exits 1", async () => {
    const { env, paths } = setup();
    const deps = testDeps({ env, openTerminal: () => scriptedTerminal(["no"]) });
    expect(await run(["cost", "adjust", "anthropic", "--spent", "3"], deps)).toBe(1);
    expect(existsSync(paths.agentDb)).toBe(false);
  });

  test("a bad amount or provider is a usage error", async () => {
    const { env } = setup();
    expect(await run(["cost", "adjust", "anthropic", "--spent", "-1"], testDeps({ env }))).toBe(2);
    expect(await run(["cost", "adjust", "nobody", "--spent", "1"], testDeps({ env }))).toBe(2);
  });
});
