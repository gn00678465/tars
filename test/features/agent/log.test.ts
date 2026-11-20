import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLog } from "../../../src/features/agent/log.ts";
import { tempHome } from "../../helpers.ts";

const lines = (path: string) => readFileSync(path, "utf8").trimEnd().split("\n");

test("creates the parent directory and appends one JSON object per line", () => {
  const path = join(tempHome(), "agent", "nested", "log.jsonl");
  const log = createLog(path, () => new Date(1_000));
  log.log("turn_start", { turn: "t1", conv: "c1" });
  log.log("request_end", { turn: "t1", status: 200, costUsd: 0.01, state: "final" });
  const parsed = lines(path).map((l) => JSON.parse(l));
  expect(parsed).toEqual([
    { at: 1_000, event: "turn_start", turn: "t1", conv: "c1" },
    { at: 1_000, event: "request_end", turn: "t1", status: 200, costUsd: 0.01, state: "final" },
  ]);
});

test("past 5 MiB the file moves to log.jsonl.1, replacing an older one, and a new file starts", () => {
  const path = join(tempHome(), "log.jsonl");
  writeFileSync(`${path}.1`, "old rotation\n");
  writeFileSync(path, "x".repeat(5 * 1024 * 1024 + 1));
  const log = createLog(path);
  log.log("warning", { count: 1 });
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(readFileSync(`${path}.1`, "utf8").startsWith("xxx")).toBe(true);
  expect(lines(path)).toHaveLength(1);
  expect(JSON.parse(lines(path)[0] as string)).toMatchObject({ event: "warning", count: 1 });
});

test("a file at exactly 5 MiB is not rotated yet", () => {
  const path = join(tempHome(), "log.jsonl");
  writeFileSync(path, "x".repeat(5 * 1024 * 1024));
  createLog(path).log("warning", {});
  expect(existsSync(`${path}.1`)).toBe(false);
});
