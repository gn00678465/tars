import type { Database } from "bun:sqlite";
import { processStartTime } from "../../core/spawn.ts";
import { reconcileLedger } from "./ledger.ts";
import { finishToolCall, unfinishedToolCalls } from "./store.ts";
import type { ToolCallEndState, ToolCallState } from "./types.ts";

export interface ReconcileReport {
  readonly killed: number;
  readonly approvals: number;
  readonly toolCalls: number;
  readonly usage: number;
  readonly turns: number;
}

const INTERRUPTED = "中斷，結果不明。這個動作可能已經執行，沒有自動重跑";

/** What a call left unfinished by a dead process becomes, and the result the model will read. */
const SETTLE: Record<Exclude<ToolCallState, ToolCallEndState>, [ToolCallEndState, string]> = {
  received: ["skipped", "程式中斷，這個動作沒有執行"],
  pending_approval: ["expired", "等待核准時程式中斷，沒有執行"],
  approved: ["interrupted", INTERRUPTED],
  running: ["interrupted", INTERRUPTED],
};

/**
 * Runs after the lock is taken and migrations applied, before anything else touches agent.db.
 * Nothing is re-run: an action that may have happened is reported as unknown.
 */
export function reconcile(
  db: Database,
  now: Date,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): ReconcileReport {
  const calls = unfinishedToolCalls(db);
  let killed = 0;
  // A child group left running by a killed tars; only when /proc still shows the same process.
  for (const c of calls) {
    if (c.state !== "running" || c.childPid === null) continue;
    const start = processStartTime(c.childPid);
    if (start === undefined || start !== c.childStart) continue;
    try {
      kill(-c.childPid, "SIGKILL");
      killed++;
    } catch {}
  }
  return db.transaction(() => {
    const at = now.getTime();
    const approvals = db.run(
      "UPDATE approvals SET state = 'expired' WHERE state = 'pending'",
    ).changes;
    for (const c of calls) {
      const [status, text] = SETTLE[c.state as keyof typeof SETTLE];
      finishToolCall(db, c, { status, text, truncated: false }, at);
      db.run(
        "UPDATE tool_calls SET state = ?, ended_at = COALESCE(ended_at, ?), child_pid = NULL WHERE id = ?",
        [status, at, c.id],
      );
    }
    const { usage, turns } = reconcileLedger(db, now);
    return { killed, approvals, toolCalls: calls.length, usage, turns };
  })();
}

export function reconcileSummary(r: ReconcileReport): string | undefined {
  if (r.killed + r.approvals + r.toolCalls + r.usage + r.turns === 0) return undefined;
  return `上次執行沒有正常結束，已整理：${r.turns} 個回合標為中斷、${r.toolCalls} 個工具呼叫補上結果、${r.approvals} 個核准過期、${r.usage} 個回合的預留轉為估計${r.killed > 0 ? `、清掉 ${r.killed} 個留下的子行程` : ""}`;
}
