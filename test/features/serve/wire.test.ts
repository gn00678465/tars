import { describe, expect, test } from "bun:test";
import { ITEM_TEXT_BYTES, TOOL_TEXT_BYTES, RUNNING_TEXT_BYTES, wireItem } from "@tars/protocol";
import type { Item } from "../../../src/features/agent/types.ts";
import { toWire, wireRunning, type WireLookup } from "../../../src/features/serve/wire.ts";

const T = "01a1fd71-be41-71e7-809a-4bb1e568ad68";
const it = (kind: string, body: unknown): Item =>
  ({ seq: 3, turnId: T, step: 1, kind, body }) as Item;
const figures = {
  inputTokens: 120,
  outputTokens: 30,
  costUsd: 0.02,
  costSource: "table",
  cacheReadTokens: 0,
  thinkingTokens: 0,
};
const lookup: WireLookup = {
  usage: () => figures,
  duration: () => undefined,
  decided: () => undefined,
};
const wire = (item: Item, l: WireLookup = lookup) => toWire(item, l);

/** Every key of the wire item, and it passes the protocol's schema. */
function checked(item: Item) {
  const w = wire(item);
  expect(w).toBeDefined();
  expect(wireItem.safeParse(w).success).toBe(true);
  return w as Record<string, unknown>;
}

describe("toWire: the allow-list", () => {
  test("user: the text", () => {
    expect(checked(it("user", { text: "hi" }))).toEqual({
      seq: 3,
      turn: T,
      kind: "user",
      text: "hi",
      truncated: false,
    });
  });

  test("carried user text: only the earlier conversation's id, not the text", () => {
    const w = checked(it("user", { text: "x".repeat(50_000), carriedFrom: "conv-earlier" }));
    expect(w).toEqual({ seq: 3, turn: T, kind: "carried", from: "conv-earlier" });
  });

  test.each(["complete", "truncated", "aborted", "incomplete"])(
    "assistant %s: text and state, no native or thinkingKey",
    (state) => {
      const w = checked(
        it("assistant", {
          text: "答",
          state,
          native: [{ type: "thinking", signature: "sig" }],
          thinkingKey: "k",
        }),
      );
      expect(w).toEqual({
        seq: 3,
        turn: T,
        kind: "assistant",
        text: "答",
        truncated: false,
        state,
      });
    },
  );

  test("tool_call: name and input as JSON, not the provider's call id", () => {
    const w = checked(
      it("tool_call", {
        callId: "c1",
        providerCallId: "toolu_secret",
        name: "tars",
        input: { argv: ["cost"] },
      }),
    );
    expect(w).toEqual({
      seq: 3,
      turn: T,
      kind: "tool_call",
      callId: "c1",
      name: "tars",
      input: '{"argv":["cost"]}',
      truncated: false,
    });
  });

  test("tool_result: status, exit and text", () => {
    const w = checked(
      it("tool_result", { callId: "c1", status: "done", text: "ok", truncated: false, exit: 0 }),
    );
    expect(w).toEqual({
      seq: 3,
      turn: T,
      kind: "tool_result",
      callId: "c1",
      status: "done",
      exit: 0,
      text: "ok",
      truncated: false,
    });
  });

  test("usage: tokens, cost and its source, from the usage row", () => {
    expect(checked(it("usage", { usageId: 7 }))).toEqual({
      seq: 3,
      turn: T,
      kind: "usage",
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.02,
      costSource: "table",
      cacheReadTokens: 0,
      thinkingTokens: 0,
    });
  });

  test("usage: cache read, thinking and the turn's effort when the row has them", () => {
    const l = {
      ...lookup,
      usage: () => ({ ...figures, cacheReadTokens: 100, thinkingTokens: 12, effort: "medium" }),
    };
    expect(wire(it("usage", { usageId: 7 }), l)).toMatchObject({
      cacheReadTokens: 100,
      thinkingTokens: 12,
      effort: "medium",
    });
  });

  test("tool_result: how long it ran, and why it was refused", () => {
    const l = { ...lookup, duration: (id: string) => (id === "c1" ? 840 : undefined) };
    const body = { callId: "c1", status: "refused", text: "x", truncated: false };
    expect(wire(it("tool_result", { ...body, refusal: "changed" }), l)).toMatchObject({
      durationMs: 840,
      refusal: "changed",
    });
    const never = wire(it("tool_result", { ...body, callId: "c2" }), l) as Record<string, unknown>;
    expect(["durationMs" in never, "refusal" in never]).toEqual([false, false]);
  });

  test("error: the code and this machine's figures, never message or detail", () => {
    const w = checked(
      it("error", { code: "provider_error", message: "upstream said sk-…", detail: "raw body" }),
    );
    expect(w).toEqual({ seq: 3, turn: T, kind: "error", code: "provider_error" });
    expect(JSON.stringify(w)).not.toContain("upstream");
    const data = { provider: "anthropic", stopUsd: 95, spentUsd: 95.12 };
    expect(checked(it("error", { code: "budget_stopped", message: "m", data }))).toEqual({
      seq: 3,
      turn: T,
      kind: "error",
      code: "budget_stopped",
      data,
    });
  });

  test("compaction: the summary", () => {
    const w = checked(
      it("compaction", {
        summary: "摘要",
        firstKeptSeq: 1,
        tokensBefore: 9,
        replacedCount: 2,
        trigger: "auto",
        usageId: 1,
      }),
    );
    expect(w).toEqual({ seq: 3, turn: T, kind: "compaction", text: "摘要", truncated: false });
  });

  test("wiki_index and a kind nobody knows are not sent", () => {
    expect(
      wire(it("wiki_index", { text: "<wiki-index>", indexSha256: "x", pages: 1, listed: 1 })),
    ).toBeUndefined();
    expect(wire(it("future_kind", { secret: "x" }))).toBeUndefined();
  });

  test("a usage row that cannot be read is not sent", () => {
    expect(
      wire(it("usage", { usageId: 9 }), { ...lookup, usage: () => undefined }),
    ).toBeUndefined();
  });
});

describe("toWire: cutting by bytes", () => {
  test("item text over ITEM_TEXT_BYTES, in three-byte characters, is cut and marked", () => {
    const w = checked(
      it("assistant", { text: "中".repeat(ITEM_TEXT_BYTES), state: "complete", native: null }),
    );
    expect(Buffer.byteLength(w.text as string)).toBeLessThanOrEqual(ITEM_TEXT_BYTES);
    expect(w.truncated).toBe(true);
  });

  test("tool output over TOOL_TEXT_BYTES is cut; one the loop already cut stays marked", () => {
    const long = checked(
      it("tool_result", {
        callId: "c",
        status: "done",
        text: "x".repeat(TOOL_TEXT_BYTES + 5),
        truncated: false,
      }),
    );
    expect((long.text as string).length).toBe(TOOL_TEXT_BYTES);
    expect(long.truncated).toBe(true);
    const short = checked(
      it("tool_result", { callId: "c", status: "done", text: "x", truncated: true }),
    );
    expect(short.truncated).toBe(true);
    const input = checked(
      it("tool_call", {
        callId: "c",
        providerCallId: "p",
        name: "tars",
        input: { a: "y".repeat(TOOL_TEXT_BYTES) },
      }),
    );
    expect(Buffer.byteLength(input.input as string)).toBeLessThanOrEqual(TOOL_TEXT_BYTES);
    expect(input.truncated).toBe(true);
  });

  // JSON writes each of these as six bytes: a text within the byte limit can be six times it.
  const encoded = (s: string) => Buffer.byteLength(JSON.stringify(s)) - 2;
  const CTRL = "\u0001";

  test("the limits count the text as JSON writes it, so escapes cannot blow it up", () => {
    const item = checked(
      it("assistant", { text: CTRL.repeat(60_000), state: "complete", native: null }),
    );
    expect(encoded(item.text as string)).toBeLessThanOrEqual(ITEM_TEXT_BYTES);
    expect(item.truncated).toBe(true);
    const out = checked(
      it("tool_result", {
        callId: "c",
        status: "done",
        text: CTRL.repeat(10_000),
        truncated: false,
      }),
    );
    expect(encoded(out.text as string)).toBeLessThanOrEqual(TOOL_TEXT_BYTES);
    const input = checked(
      it("tool_call", {
        callId: "c",
        providerCallId: "p",
        name: "tars",
        input: { a: CTRL.repeat(10_000) },
      }),
    );
    expect(encoded(input.input as string)).toBeLessThanOrEqual(TOOL_TEXT_BYTES);
    const run = wireRunning(T, `head${CTRL.repeat(60_000)}tail`);
    expect(encoded(run.text)).toBeLessThanOrEqual(RUNNING_TEXT_BYTES);
    expect(run.text.endsWith("tail")).toBe(true);
    // Quotes, backslashes and newlines are two bytes each; a character is never split.
    const mixed = checked(it("user", { text: `"\\\n${"中".repeat(30_000)}😀`.repeat(2) }));
    expect(encoded(mixed.text as string)).toBeLessThanOrEqual(ITEM_TEXT_BYTES);
    expect((mixed.text as string).isWellFormed()).toBe(true);
  });

  test("the running text keeps only its tail", () => {
    const r = wireRunning(T, `${"a".repeat(10)}${"中".repeat(RUNNING_TEXT_BYTES)}`);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(RUNNING_TEXT_BYTES);
    expect(r.text.endsWith("中")).toBe(true);
    expect(r.truncated).toBe(true);
    expect(wireRunning(T, "short")).toEqual({ turn: T, text: "short", truncated: false });
  });
});
