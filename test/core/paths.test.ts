import { expect, test } from "bun:test";
import { TarsError } from "../../src/core/exit.ts";
import { inSession, resolvePaths } from "../../src/core/paths.ts";

test("data dir defaults to ~/.local/share/tars", () => {
  const p = resolvePaths({ HOME: "/h" });
  expect(p.data).toBe("/h/.local/share/tars");
  expect(p.soul).toBe("/h/.local/share/tars/SOUL.md");
  expect(p.memory).toBe("/h/.local/share/tars/MEMORY.md");
  expect(p.skills).toBe("/h/.local/share/tars/skills");
  expect(p.workspace).toBe("/h/.local/share/tars/workspace");
});

test("an absolute XDG_DATA_HOME moves the data dir", () => {
  expect(resolvePaths({ HOME: "/h", XDG_DATA_HOME: "/x" }).data).toBe("/x/tars");
});

test("an absolute TARS_DATA_DIR wins over HOME and XDG_DATA_HOME; a relative one is ignored", () => {
  expect(resolvePaths({ HOME: "/h", XDG_DATA_HOME: "/x", TARS_DATA_DIR: "/d" }).memory).toBe(
    "/d/MEMORY.md",
  );
  expect(resolvePaths({ HOME: "/h", TARS_DATA_DIR: "rel" }).data).toBe("/h/.local/share/tars");
});

test("a relative XDG_DATA_HOME is ignored", () => {
  expect(resolvePaths({ HOME: "/h", XDG_DATA_HOME: "rel" }).data).toBe("/h/.local/share/tars");
});

test("a missing or relative HOME is an error with exit 1", () => {
  for (const env of [{}, { HOME: "" }, { HOME: "rel" }]) {
    try {
      resolvePaths(env);
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(TarsError);
      expect((err as TarsError).exitCode).toBe(1);
    }
  }
});

test("config dir defaults to ~/.config/tars and holds config.toml and models.json", () => {
  const p = resolvePaths({ HOME: "/h" });
  expect(p.config).toBe("/h/.config/tars");
  expect(p.configFile).toBe("/h/.config/tars/config.toml");
  expect(p.modelsFile).toBe("/h/.config/tars/models.json");
});

test("an absolute XDG_CONFIG_HOME moves the config dir; a relative one is ignored", () => {
  expect(resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "/c" }).config).toBe("/c/tars");
  expect(resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "rel" }).config).toBe("/h/.config/tars");
});

test("bin defaults to ~/.local/bin; an absolute XDG_BIN_HOME wins, a relative one is ignored", () => {
  expect(resolvePaths({ HOME: "/h" }).bin).toBe("/h/.local/bin");
  expect(resolvePaths({ HOME: "/h", XDG_BIN_HOME: "/b" }).bin).toBe("/b");
  expect(resolvePaths({ HOME: "/h", XDG_BIN_HOME: "rel" }).bin).toBe("/h/.local/bin");
});

test("the agent's files live under <data>/agent and outputs under <data>/workspace/out", () => {
  const p = resolvePaths({ HOME: "/h", TARS_DATA_DIR: "/d" });
  expect(p.agent).toBe("/d/agent");
  expect(p.agentDb).toBe("/d/agent/agent.db");
  expect(p.agentLock).toBe("/d/agent/lock.db");
  expect(p.agentLockInfo).toBe("/d/agent/lock.json");
  expect(p.agentLog).toBe("/d/agent/log.jsonl");
  expect(p.wiki).toBe("/d/wiki");
  expect(p.wikiIndex).toBe("/d/wiki/index.md");
  expect(p.wikiDb).toBe("/d/agent/wiki.db");
  expect(p.wikiLock).toBe("/d/agent/wiki-lock.db");
  expect(p.wikiLockInfo).toBe("/d/agent/wiki-lock.json");
  expect(p.outRoot).toBe("/d/workspace/out");
});

test("inSession is true only for a non-empty TARS_IN_SESSION", () => {
  expect(inSession({})).toBe(false);
  expect(inSession({ TARS_IN_SESSION: "" })).toBe(false);
  expect(inSession({ TARS_IN_SESSION: "1" })).toBe(true);
});
