import { describe, expect, test } from "bun:test";
import { sumUsage } from "../../scripts/session-usage.ts";

const line = (value: unknown) => JSON.stringify(value);
const assistant = (id: string, timestamp: string, usage: Record<string, number>) =>
  line({ type: "assistant", timestamp, message: { id, usage } });

describe("sumUsage", () => {
  test("counts a message written as several lines once, and spans first to last entry", () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 };
    const text = [
      line({ type: "user", timestamp: "2026-11-16T10:00:00Z", message: { role: "user" } }),
      assistant("m1", "2026-11-16T10:00:05Z", usage),
      assistant("m1", "2026-11-16T10:00:06Z", usage),
      assistant("m2", "2026-11-16T10:01:40Z", { input_tokens: 1, output_tokens: 2 }),
      "not json",
      "",
    ].join("\n");
    expect(sumUsage([text])).toEqual({
      files: 1,
      messages: 2,
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
      first: "2026-11-16T10:00:00.000Z",
      last: "2026-11-16T10:01:40.000Z",
      seconds: 100,
    });
  });

  test("adds up several files, such as a subagent's, and keeps only the window asked for", () => {
    const main = assistant("a", "2026-11-16T10:00:00Z", { output_tokens: 1 });
    const sub = assistant("b", "2026-11-16T10:05:00Z", { output_tokens: 2 });
    const late = assistant("c", "2026-11-16T12:00:00Z", { output_tokens: 4 });
    const result = sumUsage(
      [main, `${sub}\n${late}`],
      new Date("2026-11-16T09:00:00Z"),
      new Date("2026-11-16T11:00:00Z"),
    );
    expect(result).toMatchObject({ files: 2, messages: 2, output_tokens: 3, seconds: 300 });
  });
});
