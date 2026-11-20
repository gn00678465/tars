import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { TarsError } from "../../../src/core/exit.ts";
import { insertReserved, recordEnd } from "../../../src/features/agent/ledger.ts";
import {
  appendItems,
  createConversation,
  findConversation,
  finishToolCall,
  getConversation,
  hasToolResult,
  lastFinalUsageSeq,
  readActiveItems,
  readItems,
  recordToolCalls,
  shortId,
} from "../../../src/features/agent/store.ts";
import { ZERO_USAGE, type NewItem } from "../../../src/features/agent/types.ts";
import { agentDb, MODEL, NOW, seedTurn } from "./db-fixture.ts";

const T = NOW.getTime();
const user = (text: string, step = 0): NewItem => ({ kind: "user", step, body: { text } });

function conversationWithId(db: Database, id: string, text = "title") {
  createConversation(db, {
    id,
    text,
    provider: "anthropic",
    model: MODEL.id,
    effort: "medium",
    now: T,
  });
}

describe("appendItems", () => {
  test("seq runs 1, 2, 3 … across calls and turns", async () => {
    const { db } = await agentDb();
    const { convId, turnId } = seedTurn(db);
    expect(appendItems(db, convId, turnId, [user("a"), user("b")], T)).toEqual([1, 2]);
    const second = seedTurn(db, { convId });
    expect(appendItems(db, convId, second.turnId, [user("c")], T)).toEqual([3]);
    expect(readItems(db, convId).map((i) => [i.seq, i.turnId])).toEqual([
      [1, turnId],
      [2, turnId],
      [3, second.turnId],
    ]);
  });

  test("each conversation counts on its own", async () => {
    const { db } = await agentDb();
    const a = seedTurn(db);
    const b = seedTurn(db);
    appendItems(db, a.convId, a.turnId, [user("a")], T);
    expect(appendItems(db, b.convId, b.turnId, [user("b")], T)).toEqual([1]);
  });
});

describe("createConversation", () => {
  test("the title is the first 30 characters of the message", async () => {
    const { db } = await agentDb();
    const text = "一二三四五六七八九十".repeat(4);
    const { convId } = seedTurn(db, { text });
    expect(getConversation(db, convId).title).toBe("一二三四五六七八九十".repeat(3));
  });
});

describe("findConversation", () => {
  test("finds by full id and by a unique tail of 4 or more characters", async () => {
    const { db } = await agentDb();
    const { convId } = seedTurn(db);
    expect(findConversation(db, convId).id).toBe(convId);
    expect(findConversation(db, shortId(convId)).id).toBe(convId);
    expect(findConversation(db, convId.slice(-4)).id).toBe(convId);
  });

  test("an ambiguous tail lists every match", async () => {
    const { db } = await agentDb();
    conversationWithId(db, "0000-aaaa-12345678", "first");
    conversationWithId(db, "0000-bbbb-12345678", "second");
    try {
      findConversation(db, "5678");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(TarsError);
      const message = (err as TarsError).message;
      expect(message).toContain("0000-aaaa-12345678");
      expect(message).toContain("0000-bbbb-12345678");
    }
    expect(findConversation(db, "aaaa-12345678").title).toBe("first");
  });

  test("fewer than 4 characters, or no match, is refused", async () => {
    const { db } = await agentDb();
    conversationWithId(db, "0000-aaaa-12345678");
    expect(() => findConversation(db, "678")).toThrow(TarsError);
    expect(() => findConversation(db, "zzzz")).toThrow(TarsError);
  });
});

describe("finishToolCall", () => {
  async function withCall() {
    const { db } = await agentDb();
    const { convId, turnId } = seedTurn(db);
    const call = { id: "call-1", turnId, convId, step: 1 };
    recordToolCalls(db, [
      { ...call, providerCallId: "tu_1", name: "tars", input: { argv: ["cost"] } },
    ]);
    return { db, call };
  }
  const state = (db: Database) =>
    (db.query("SELECT state FROM tool_calls WHERE id = 'call-1'").get() as { state: string }).state;

  test("writes the result item and the end state together", async () => {
    const { db, call } = await withCall();
    finishToolCall(db, call, { status: "done", text: "exit 0", truncated: false, exit: 0 }, T);
    expect(state(db)).toBe("done");
    expect(readItems(db, call.convId)).toEqual([
      {
        seq: 1,
        turnId: call.turnId,
        step: 1,
        kind: "tool_result",
        body: { callId: "call-1", status: "done", text: "exit 0", truncated: false, exit: 0 },
      },
    ]);
  });

  test("when the state update fails, no result item is left behind", async () => {
    const { db, call } = await withCall();
    db.exec(
      "CREATE TRIGGER refuse BEFORE UPDATE ON tool_calls BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(() =>
      finishToolCall(db, call, { status: "done", text: "x", truncated: false }, T),
    ).toThrow("refused");
    expect(hasToolResult(db, call.convId, call.id)).toBe(false);
    expect(readItems(db, call.convId)).toEqual([]);
    expect(state(db)).toBe("received");
  });

  test("a call that already has its result is left alone", async () => {
    const { db, call } = await withCall();
    finishToolCall(db, call, { status: "done", text: "first", truncated: false }, T);
    finishToolCall(db, call, { status: "failed", text: "second", truncated: false }, T);
    expect(readItems(db, call.convId).map((i) => i.body)).toEqual([
      { callId: "call-1", status: "done", text: "first", truncated: false },
    ]);
    expect(state(db)).toBe("done");
  });
});

describe("readActiveItems", () => {
  test("starts at the latest compaction's first kept item and includes that compaction", async () => {
    const { db } = await agentDb();
    const { convId, turnId } = seedTurn(db);
    appendItems(db, convId, turnId, [user("1"), user("2"), user("3"), user("4")], T);
    const compaction = (firstKeptSeq: number): NewItem => ({
      kind: "compaction",
      step: 1,
      body: {
        firstKeptSeq,
        summary: "s",
        tokensBefore: 1,
        replacedCount: 1,
        trigger: "auto",
        usageId: 1,
      },
    });
    expect(readActiveItems(db, convId).map((i) => i.seq)).toEqual([1, 2, 3, 4]);
    appendItems(db, convId, turnId, [compaction(2)], T); // seq 5
    appendItems(db, convId, turnId, [user("6"), compaction(4), user("8")], T); // 6, 7, 8
    expect(readActiveItems(db, convId).map((i) => [i.seq, i.kind])).toEqual([
      [4, "user"],
      [5, "compaction"],
      [6, "user"],
      [7, "compaction"],
      [8, "user"],
    ]);
  });
});

describe("lastFinalUsageSeq", () => {
  test("is the usage item of the last final chat request, ignoring compaction and unfinished rows", async () => {
    const { db } = await agentDb();
    const chat = seedTurn(db);
    const { convId } = chat;
    expect(lastFinalUsageSeq(db, convId)).toBe(0);
    const reserve = (turnId: string, step: number) =>
      insertReserved(db, {
        turnId,
        convId,
        step,
        attempt: 1,
        model: MODEL,
        cacheTtl: "5m",
        maxTokens: 1024,
        inputUsd: 0.01,
        now: NOW,
      });
    const usageItem = (turnId: string, usageId: number) =>
      appendItems(db, convId, turnId, [{ kind: "usage", step: 1, body: { usageId } }], T)[0];

    const finalId = reserve(chat.turnId, 1);
    recordEnd(db, {
      usageId: finalId,
      usage: ZERO_USAGE,
      turnKind: "chat",
      prefixKey: "k",
    });
    const finalSeq = usageItem(chat.turnId, finalId);

    // A still-reserved chat row and a final compaction row come later but do not count.
    usageItem(chat.turnId, reserve(chat.turnId, 2));
    const compaction = seedTurn(db, { convId, kind: "compaction" });
    const compactId = reserve(compaction.turnId, 1);
    recordEnd(db, {
      usageId: compactId,
      usage: ZERO_USAGE,
      turnKind: "compaction",
      prefixKey: "k",
    });
    usageItem(compaction.turnId, compactId);

    expect(lastFinalUsageSeq(db, convId)).toBe(finalSeq as number);
  });
});
