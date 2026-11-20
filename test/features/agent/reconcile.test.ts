import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { processStartTime } from "../../../src/core/spawn.ts";
import { insertReserved, recordStart } from "../../../src/features/agent/ledger.ts";
import { reconcile, reconcileSummary } from "../../../src/features/agent/reconcile.ts";
import {
  finishToolCall,
  readItems,
  recordToolCalls,
  setToolCallState,
} from "../../../src/features/agent/store.ts";
import type { ToolCallState } from "../../../src/features/agent/types.ts";
import { agentDb, MODEL, NOW, seedTurn } from "./db-fixture.ts";

const LATER = new Date(NOW.getTime() + 60_000);
const INTERRUPTED = "中斷，結果不明。這個動作可能已經執行，沒有自動重跑";

function addCall(
  db: Database,
  turn: { convId: string; turnId: string },
  id: string,
  state: ToolCallState,
  child: { childPid?: number; childStart?: string } = {},
) {
  recordToolCalls(db, [
    { id, ...turn, step: 1, providerCallId: `tu_${id}`, name: "tars", input: { argv: [] } },
  ]);
  if (state !== "received") setToolCallState(db, id, state, child);
}

const callState = (db: Database, id: string) =>
  db.query("SELECT state, child_pid, ended_at FROM tool_calls WHERE id = ?").get(id) as {
    state: string;
    child_pid: number | null;
    ended_at: number | null;
  };

const noKill = () => {
  throw new Error("kill must not be called");
};

describe("reconcile", () => {
  test.each([
    ["received", "skipped", "程式中斷，這個動作沒有執行"],
    ["pending_approval", "expired", "等待核准時程式中斷，沒有執行"],
    ["approved", "interrupted", INTERRUPTED],
    ["running", "interrupted", INTERRUPTED],
  ] as const)("a %s call becomes %s with its result", async (from, to, text) => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    addCall(db, turn, "c1", from);
    const report = reconcile(db, LATER, noKill);
    expect(report.toolCalls).toBe(1);
    expect(callState(db, "c1")).toEqual({ state: to, child_pid: null, ended_at: LATER.getTime() });
    expect(readItems(db, turn.convId).map((i) => ({ kind: i.kind, body: i.body }))).toEqual([
      { kind: "tool_result", body: { callId: "c1", status: to, text, truncated: false } },
    ]);
  });

  test("finished calls are not touched", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    addCall(db, turn, "c1", "received");
    finishToolCall(
      db,
      { id: "c1", ...turn, step: 1 },
      { status: "done", text: "ok", truncated: false },
      NOW.getTime(),
    );
    expect(reconcile(db, LATER, noKill).toolCalls).toBe(0);
    expect(callState(db, "c1").state).toBe("done");
  });

  test("a call that already has its result only changes state", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    addCall(db, turn, "c1", "running");
    // A crash between the result item and the state change cannot happen (one transaction),
    // but a result written by an earlier run must still never be written twice.
    db.run(
      "INSERT INTO items (conv_id, seq, turn_id, step, kind, body, created_at) VALUES (?, 1, ?, 1, 'tool_result', ?, 0)",
      [
        turn.convId,
        turn.turnId,
        JSON.stringify({ callId: "c1", status: "done", text: "ok", truncated: false }),
      ],
    );
    reconcile(db, LATER, noKill);
    expect(readItems(db, turn.convId)).toHaveLength(1);
    expect(callState(db, "c1").state).toBe("interrupted");
  });

  test("pending approvals expire; decided ones stay", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    addCall(db, turn, "c1", "pending_approval");
    addCall(db, turn, "c2", "received");
    const approval = (id: string, callId: string, state: string) =>
      db.run(
        `INSERT INTO approvals (id, tool_call_id, conv_id, hash, fields, state, created_at, expires_at)
         VALUES (?, ?, ?, 'h', '{}', ?, 0, 1)`,
        [id, callId, turn.convId, state],
      );
    approval("a1", "c1", "pending");
    approval("a2", "c2", "denied");
    expect(reconcile(db, LATER, noKill).approvals).toBe(1);
    const states = db.query("SELECT id, state FROM approvals ORDER BY id").all();
    expect(states).toEqual([
      { id: "a1", state: "expired" },
      { id: "a2", state: "denied" },
    ]);
  });

  test("reserved usage becomes an estimate at its amount and the turn's cost is recomputed", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    const usageId = insertReserved(db, {
      ...turn,
      step: 1,
      attempt: 1,
      model: MODEL,
      cacheTtl: "5m",
      maxTokens: 2000,
      inputUsd: 0.05,
      now: NOW,
    });
    recordStart(db, usageId, {
      uncachedInputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cost = (
      db.query("SELECT cost_usd FROM usage WHERE id = ?").get(usageId) as { cost_usd: number }
    ).cost_usd;
    db.run("UPDATE turns SET cost_usd = 0 WHERE id = ?", [turn.turnId]);
    expect(reconcile(db, LATER, noKill).usage).toBe(1);
    expect(
      db.query("SELECT state, cost_source, cost_usd FROM usage WHERE id = ?").get(usageId),
    ).toEqual({
      state: "estimated",
      cost_source: "estimate",
      cost_usd: cost,
    });
    expect(db.query("SELECT cost_usd FROM turns WHERE id = ?").get(turn.turnId)).toEqual({
      cost_usd: cost,
    });
  });

  test("an interrupted turn whose total disagrees with its settled rows is recomputed", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    const usageId = insertReserved(db, {
      ...turn,
      step: 1,
      attempt: 1,
      model: MODEL,
      cacheTtl: "5m",
      maxTokens: 0,
      inputUsd: 0.05,
      now: NOW,
    });
    db.run("UPDATE usage SET state = 'voided', cost_usd = 0 WHERE id = ?", [usageId]);
    db.run("UPDATE turns SET cost_usd = 4 WHERE id = ?", [turn.turnId]);
    expect(reconcile(db, LATER, noKill)).toMatchObject({ usage: 0, turns: 1 });
    expect(db.query("SELECT state, cost_usd FROM turns WHERE id = ?").get(turn.turnId)).toEqual({
      state: "interrupted",
      cost_usd: 0,
    });
  });

  test("running chat and compaction turns become interrupted", async () => {
    const { db } = await agentDb();
    const chat = seedTurn(db);
    const compaction = seedTurn(db, { convId: chat.convId, kind: "compaction" });
    const done = seedTurn(db, { convId: chat.convId });
    db.run("UPDATE turns SET state = 'completed', ended_at = 5 WHERE id = ?", [done.turnId]);
    expect(reconcile(db, LATER, noKill).turns).toBe(2);
    const turns = db.query("SELECT id, state, ended_at FROM turns").all() as {
      id: string;
      state: string;
      ended_at: number;
    }[];
    const byId = Object.fromEntries(turns.map((t) => [t.id, [t.state, t.ended_at]]));
    expect(byId[chat.turnId]).toEqual(["interrupted", LATER.getTime()]);
    expect(byId[compaction.turnId]).toEqual(["interrupted", LATER.getTime()]);
    expect(byId[done.turnId]).toEqual(["completed", 5]);
  });

  test("a left child group is killed only when /proc shows the same process", async () => {
    const start = processStartTime(process.pid);
    expect(start).toBeDefined();
    const { db } = await agentDb();
    const turn = seedTurn(db);
    addCall(db, turn, "same", "running", { childPid: process.pid, childStart: start as string });
    addCall(db, turn, "reused", "running", { childPid: process.pid, childStart: "1" });
    const kills: [number, string][] = [];
    const report = reconcile(db, LATER, (pid, signal) => void kills.push([pid, signal]));
    expect(kills).toEqual([[-process.pid, "SIGKILL"]]);
    expect(report.killed).toBe(1);
  });

  test("the summary is undefined when nothing was left over, a line otherwise", async () => {
    const { db } = await agentDb();
    const empty = reconcile(db, LATER, noKill);
    expect(empty).toEqual({ killed: 0, approvals: 0, toolCalls: 0, usage: 0, turns: 0 });
    expect(reconcileSummary(empty)).toBeUndefined();
    seedTurn(db);
    expect(reconcileSummary(reconcile(db, LATER, noKill))).toContain("1 個回合標為中斷");
  });
});
