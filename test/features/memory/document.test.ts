import { describe, expect, test } from "bun:test";
import {
  MemoryParseError,
  parseMemory,
  renderMemory,
} from "../../../src/features/memory/document.ts";
import { SAMPLE } from "./sample.ts";

describe("parse then render", () => {
  test.each([
    ["the sample file", SAMPLE],
    ["an empty file", ""],
    [
      "no trailing newline",
      "## 偏好\n\n<!-- id: a | observed: 2026-01-01 | status: active -->\n- 一則",
    ],
    [
      "CRLF line endings and plain comments",
      "# 標題\r\n\r\n##   不是 h2 的內文\r\n<!-- 普通註解 -->\r\n\t\r\n",
    ],
    [
      "entries back to back",
      "<!-- id: a | observed: 2026-01-01 | status: active -->\n- 一\n<!-- id: b | observed: 2026-01-01 | status: active -->\n- 二\n",
    ],
  ])("returns identical bytes for %s", (_name, source) => {
    expect(renderMemory(parseMemory(source))).toBe(source);
  });

  test("reads id, section, status, date, source and text of each entry", () => {
    const entries = parseMemory(SAMPLE).blocks.flatMap((b) =>
      b.kind === "entry" ? [b.entry] : [],
    );
    expect(entries.map((e) => [e.id, e.section, e.status, e.date, e.source])).toEqual([
      ["pref-tabs", "偏好", "superseded", "2026-01-02", null],
      ["pref-tabs", "偏好", "active", "2026-01-05", null],
      ["pref-short", "偏好", "active", "2026-01-03", "user"],
      ["dec-editor", "決定", "active", "2026-01-04", null],
      ["ref-notes", "去哪裡找", "active", "2026-01-06", null],
    ]);
    expect(entries[3]?.body).toBe("- 編輯器用 Helix。\n- 設定檔放 dotfiles。\n");
  });
});

describe("parse refuses a file the commands could corrupt", () => {
  test.each([
    ["a malformed id comment", "## 偏好\n\n<!-- id: a | status: active -->\n- 一\n", 3],
    ["an entry without text", "<!-- id: a | observed: 2026-01-01 | status: active -->\n\n", 1],
    [
      "two active entries with one id",
      "<!-- id: a | observed: 2026-01-01 | status: active -->\n- 一\n\n<!-- id: a | observed: 2026-01-02 | status: active -->\n- 二\n",
      4,
    ],
  ])("%s", (_name, source, line) => {
    expect(() => parseMemory(source)).toThrow(MemoryParseError);
    try {
      parseMemory(source);
    } catch (err) {
      expect((err as MemoryParseError).line).toBe(line);
    }
  });
});
