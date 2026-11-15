import { expect, test } from "bun:test";
import { TarsError } from "../../src/core/exit.ts";
import { resolvePaths } from "../../src/core/paths.ts";

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
