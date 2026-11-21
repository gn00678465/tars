import type { Database } from "bun:sqlite";
import { sha256 } from "../../core/hash.ts";
import type { Frontend } from "./frontend.ts";
import { newId } from "./store.ts";
import type { ScriptFields } from "./tars-tool.ts";
import type { ApprovalFields, ApprovalRecord, ApprovalState } from "./types.ts";

/** JSON with every object's keys sorted; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const approvalHash = (a: {
  approvalId: string;
  convId: string;
  argv: readonly string[];
  script: string;
  version: string;
}) =>
  sha256(
    canonicalJson({
      approvalId: a.approvalId,
      convId: a.convId,
      tool: "tars",
      argv: a.argv,
      script: a.script,
      version: a.version,
    }),
  );

/**
 * Records the pending approval and moves the call to pending_approval in one transaction,
 * before anyone is asked; a failure here throws and the tool never runs.
 */
export function create(
  db: Database,
  a: { toolCallId: string; convId: string; fields: ScriptFields; now: number; timeoutS: number },
): ApprovalRecord {
  const id = newId();
  const expiresAt = a.now + a.timeoutS * 1000;
  const fields: ApprovalFields = { ...a.fields, approvalId: id, expiresAt };
  const hash = approvalHash({ convId: a.convId, ...fields });
  db.transaction(() => {
    db.run(
      `INSERT INTO approvals (id, tool_call_id, conv_id, hash, fields, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, a.toolCallId, a.convId, hash, JSON.stringify(fields), a.now, expiresAt],
    );
    db.run("UPDATE tool_calls SET state = 'pending_approval' WHERE id = ?", [a.toolCallId]);
  })();
  return {
    id,
    toolCallId: a.toolCallId,
    convId: a.convId,
    hash,
    fields,
    state: "pending",
    createdAt: a.now,
    expiresAt,
  };
}

interface ApprovalRow {
  id: string;
  tool_call_id: string;
  conv_id: string;
  hash: string;
  fields: string;
  state: ApprovalState;
  created_at: number;
  expires_at: number;
}

/** Every approval still waiting, oldest first: a browser that connects late gets their cards. */
export const listPending = (db: Database): ApprovalRecord[] =>
  (
    db
      .query("SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at, id")
      .all() as ApprovalRow[]
  ).map((r) => ({
    id: r.id,
    toolCallId: r.tool_call_id,
    convId: r.conv_id,
    hash: r.hash,
    fields: JSON.parse(r.fields) as ApprovalFields,
    state: r.state,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));

export type DecideResult = "ok" | "already_decided" | "expired" | "hash_mismatch";

/** One compare-and-set: only a pending, unexpired approval with the same hash changes. */
export function decide(
  db: Database,
  d: {
    id: string;
    decision: "approved" | "denied";
    hash: string;
    via: Frontend["via"];
    now: number;
  },
): DecideResult {
  const changed = db.run(
    `UPDATE approvals SET state = ?, decided_at = ?, decided_via = ?
     WHERE id = ? AND state = 'pending' AND expires_at > ? AND hash = ?`,
    [d.decision, d.now, d.via, d.id, d.now, d.hash],
  ).changes;
  if (changed === 1) return "ok";
  const row = db.query("SELECT state, expires_at, hash FROM approvals WHERE id = ?").get(d.id) as {
    state: ApprovalState;
    expires_at: number;
    hash: string;
  } | null;
  if (row === null || row.state !== "pending") return "already_decided";
  if (row.expires_at <= d.now) {
    expire(db, d.id);
    return "expired";
  }
  return "hash_mismatch";
}

export const stateOf = (db: Database, id: string) =>
  (db.query("SELECT state FROM approvals WHERE id = ?").get(id) as { state: ApprovalState }).state;

const settlePending = (db: Database, id: string, state: "cancelled" | "expired") =>
  db.run("UPDATE approvals SET state = ? WHERE id = ? AND state = 'pending'", [state, id])
    .changes === 1;

export const cancel = (db: Database, id: string) => settlePending(db, id, "cancelled");
export const expire = (db: Database, id: string) => settlePending(db, id, "expired");
