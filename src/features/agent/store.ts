import type { Database } from "bun:sqlite";
import { TarsError } from "../../core/exit.ts";
import type { Provider } from "../../core/secrets.ts";
import type {
  CompactionBody,
  Effort,
  Item,
  NewItem,
  ReasonCode,
  ToolCallEndState,
  ToolCallState,
  ToolResultBody,
  ToolResultItem,
  TurnKind,
  TurnState,
} from "./types.ts";

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastTotalInputTokens: number;
  readonly lastRequestAt: number | null;
  readonly lastPrefixKey: string | null;
  /** The conversation this one continues; absent for one started fresh. */
  readonly parentId?: string;
}

export interface ToolCallRow {
  readonly id: string;
  readonly turnId: string;
  readonly convId: string;
  readonly step: number;
  readonly providerCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly state: ToolCallState;
  readonly childPid: number | null;
  readonly childStart: string | null;
}

/** The short id people see: the random tail of a UUIDv7, whose head is a timestamp. */
export const shortId = (id: string) => id.slice(-8);

export const newId = () => Bun.randomUUIDv7();

const TITLE_CHARS = 30;

interface ConversationRow {
  id: string;
  title: string;
  provider: Provider;
  model: string;
  effort: Effort;
  created_at: number;
  updated_at: number;
  last_total_input_tokens: number;
  last_request_at: number | null;
  last_prefix_key: string | null;
  parent_id: string | null;
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  title: r.title,
  provider: r.provider,
  model: r.model,
  effort: r.effort,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastTotalInputTokens: r.last_total_input_tokens,
  lastRequestAt: r.last_request_at,
  lastPrefixKey: r.last_prefix_key,
  ...(r.parent_id === null ? {} : { parentId: r.parent_id }),
});

export function getConversation(db: Database, id: string): Conversation {
  const row = db
    .query("SELECT * FROM conversations WHERE id = ?")
    .get(id) as ConversationRow | null;
  if (row === null) throw new TarsError(`沒有對話 ${id}`);
  return toConversation(row);
}

export function listConversations(db: Database): Conversation[] {
  return (
    db.query("SELECT * FROM conversations ORDER BY updated_at DESC").all() as ConversationRow[]
  ).map(toConversation);
}

/** A full id, or a tail of at least 4 characters that names exactly one conversation. */
export function findConversation(db: Database, idOrSuffix: string): Conversation {
  if (idOrSuffix.length < 4) throw new TarsError("對話編號至少要 4 碼");
  const rows = db
    .query("SELECT * FROM conversations WHERE id = ?1 OR substr(id, -length(?1)) = ?1")
    .all(idOrSuffix) as ConversationRow[];
  if (rows.length === 0) throw new TarsError(`沒有對話 ${idOrSuffix}；列出：tars chat --list`);
  if (rows.length > 1)
    throw new TarsError(
      `${idOrSuffix} 對到 ${rows.length} 個對話，請給更長的編號：\n${rows.map((r) => `  ${r.id}  ${r.title}`).join("\n")}`,
    );
  return toConversation(rows[0] as ConversationRow);
}

export interface TurnRow {
  readonly id: string;
  readonly convId: string;
  readonly kind: string;
  readonly state: string;
  readonly startedAt: number;
}

const TURN_COLUMNS = "id, conv_id AS convId, kind, state, started_at AS startedAt";

/** The turn a browser's turn.submit started, by the id the browser gave it. */
export const findTurnByRequest = (db: Database, requestId: string): TurnRow | undefined =>
  (db
    .query(`SELECT ${TURN_COLUMNS} FROM turns WHERE request_id = ?`)
    .get(requestId) as TurnRow | null) ?? undefined;

/** Made once by migration 5: a different value means a different database. */
export const readEpoch = (db: Database): string =>
  (db.query("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string }).value;

/** A full id, or a tail of at least 4 characters that names exactly one turn of `convId`. */
export function findTurn(db: Database, convId: string, idOrSuffix: string): TurnRow {
  if (idOrSuffix.length < 4) throw new TarsError("回合編號至少要 4 碼");
  const rows = db
    .query(
      `SELECT ${TURN_COLUMNS} FROM turns
       WHERE conv_id = ?2 AND (id = ?1 OR substr(id, -length(?1)) = ?1)`,
    )
    .all(idOrSuffix, convId) as TurnRow[];
  if (rows.length === 0) throw new TarsError(`對話 ${shortId(convId)} 沒有回合 ${idOrSuffix}`);
  if (rows.length > 1)
    throw new TarsError(
      `${idOrSuffix} 對到 ${rows.length} 個回合，請給更長的編號：\n${rows.map((r) => `  ${r.id}`).join("\n")}`,
    );
  return rows[0] as TurnRow;
}

export function createConversation(
  db: Database,
  c: {
    id: string;
    text: string;
    provider: Provider;
    model: string;
    effort: Effort;
    now: number;
    parentId?: string;
  },
): void {
  // parent_id is named only for a continuation: test fixtures that build an older schema
  // (versions 1–3) have no such column and still create conversations through here.
  const parent = c.parentId === undefined ? [] : [c.parentId];
  db.run(
    `INSERT INTO conversations (id, title, provider, model, effort, created_at, updated_at${parent.length > 0 ? ", parent_id" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?${parent.length > 0 ? ", ?" : ""})`,
    [
      c.id,
      [...c.text.trim()].slice(0, TITLE_CHARS).join(""),
      c.provider,
      c.model,
      c.effort,
      c.now,
      c.now,
      ...parent,
    ],
  );
}

export function setConversationEffort(db: Database, id: string, effort: Effort): void {
  db.run("UPDATE conversations SET effort = ? WHERE id = ?", [effort, id]);
}

/** What the last finalized chat request saw, for the next estimate and cache check. */
export function setRequestState(
  db: Database,
  id: string,
  s: { totalInput: number; at: number | null; prefixKey: string | null },
): void {
  db.run(
    `UPDATE conversations SET last_total_input_tokens = ?, last_request_at = ?, last_prefix_key = ?
     WHERE id = ?`,
    [s.totalInput, s.at, s.prefixKey, id],
  );
}

export function beginTurn(
  db: Database,
  t: {
    id: string;
    convId: string;
    kind: TurnKind;
    effort: Effort | null;
    now: number;
    requestId?: string;
  },
): void {
  db.run(
    "INSERT INTO turns (id, conv_id, kind, state, effort, started_at) VALUES (?, ?, ?, 'running', ?, ?)",
    [t.id, t.convId, t.kind, t.effort, t.now],
  );
  // In the caller's transaction: a request_id already taken throws and nothing is kept.
  if (t.requestId !== undefined)
    db.run("UPDATE turns SET request_id = ? WHERE id = ?", [t.requestId, t.id]);
}

export function addTurnRequest(db: Database, turnId: string): void {
  db.run("UPDATE turns SET requests = requests + 1 WHERE id = ?", [turnId]);
}

export function turnRequests(db: Database, turnId: string): number {
  return (db.query("SELECT requests FROM turns WHERE id = ?").get(turnId) as { requests: number })
    .requests;
}

export function endTurn(
  db: Database,
  t: {
    id: string;
    convId: string;
    state: Exclude<TurnState, "running">;
    reason?: ReasonCode;
    now: number;
  },
): void {
  db.run("UPDATE turns SET state = ?, reason = ?, ended_at = ? WHERE id = ?", [
    t.state,
    t.reason ?? null,
    t.now,
    t.id,
  ]);
  db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [t.now, t.convId]);
}

/** Appends items with the next seqs. Rows in items are never updated or deleted. */
export function appendItems(
  db: Database,
  convId: string,
  turnId: string,
  items: readonly NewItem[],
  now: number,
): number[] {
  const insert = db.prepare(
    `INSERT INTO items (conv_id, seq, turn_id, step, kind, body, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE conv_id = ?), ?, ?, ?, ?, ?)
     RETURNING seq`,
  );
  return items.map(
    (item) =>
      (
        insert.get(
          convId,
          convId,
          turnId,
          item.step,
          item.kind,
          JSON.stringify(item.body),
          now,
        ) as {
          seq: number;
        }
      ).seq,
  );
}

interface ItemRow {
  seq: number;
  turn_id: string;
  step: number;
  kind: Item["kind"];
  body: string;
}

const toItem = (r: ItemRow) =>
  ({ seq: r.seq, turnId: r.turn_id, step: r.step, kind: r.kind, body: JSON.parse(r.body) }) as Item;

export function readItems(db: Database, convId: string): Item[] {
  return (
    db
      .query("SELECT seq, turn_id, step, kind, body FROM items WHERE conv_id = ? ORDER BY seq")
      .all(convId) as ItemRow[]
  ).map(toItem);
}

/**
 * Up to `limit` items before seq `before` (all of them without it), oldest first; `more` says
 * whether there are earlier ones.
 */
export function readItemsPage(
  db: Database,
  convId: string,
  page: { before?: number; limit: number },
): { items: Item[]; more: boolean } {
  const rows = db
    .query(
      `SELECT seq, turn_id, step, kind, body FROM items WHERE conv_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(convId, page.before ?? Number.MAX_SAFE_INTEGER, page.limit + 1) as ItemRow[];
  return { items: rows.slice(0, page.limit).reverse().map(toItem), more: rows.length > page.limit };
}

/** The items a request can need: from the latest compaction's first kept item on. */
export function readActiveItems(db: Database, convId: string): Item[] {
  return (
    db
      .query(
        `SELECT seq, turn_id, step, kind, body FROM items WHERE conv_id = ?1 AND seq >= COALESCE(
           (SELECT json_extract(body, '$.firstKeptSeq') FROM items
            WHERE conv_id = ?1 AND kind = 'compaction' ORDER BY seq DESC LIMIT 1), 0)
         ORDER BY seq`,
      )
      .all(convId) as ItemRow[]
  ).map(toItem);
}

/**
 * The seq of the usage item of the last chat request that finalized: the items after it (its
 * own answer included) are what the next request adds to that request's measured input.
 */
export function lastFinalUsageSeq(db: Database, convId: string): number {
  const row = db
    .query(
      `SELECT i.seq FROM items i
       JOIN usage u ON u.id = json_extract(i.body, '$.usageId')
       JOIN turns t ON t.id = u.turn_id
       WHERE i.conv_id = ? AND i.kind = 'usage' AND u.state = 'final' AND t.kind = 'chat'
       ORDER BY i.seq DESC LIMIT 1`,
    )
    .get(convId) as { seq: number } | null;
  return row?.seq ?? 0;
}

export function recordToolCalls(
  db: Database,
  calls: readonly {
    id: string;
    turnId: string;
    convId: string;
    step: number;
    providerCallId: string;
    name: string;
    input: unknown;
  }[],
): void {
  const insert = db.prepare(
    `INSERT INTO tool_calls (id, turn_id, conv_id, step, provider_call_id, name, input, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'received')`,
  );
  for (const c of calls)
    insert.run(c.id, c.turnId, c.convId, c.step, c.providerCallId, c.name, JSON.stringify(c.input));
}

export function setToolCallState(
  db: Database,
  id: string,
  state: ToolCallState,
  extra: { childPid?: number; childStart?: string | null; now?: number } = {},
): void {
  db.run(
    `UPDATE tool_calls SET state = ?,
       child_pid = COALESCE(?, child_pid), child_start = COALESCE(?, child_start),
       started_at = COALESCE(?, started_at)
     WHERE id = ?`,
    [state, extra.childPid ?? null, extra.childStart ?? null, extra.now ?? null, id],
  );
}

/**
 * The tool result item and the call's end state in one transaction, so a crash leaves either
 * both or neither; reconcile relies on that. A call that already has its result is left alone.
 */
export function finishToolCall(
  db: Database,
  call: { id: string; turnId: string; convId: string; step: number },
  result: Omit<ToolResultBody, "callId" | "status"> & { status: ToolCallEndState },
  now: number,
): ToolResultItem | undefined {
  return db.transaction(() => {
    if (hasToolResult(db, call.convId, call.id)) return undefined;
    const body: ToolResultBody = { callId: call.id, ...result };
    const [seq] = appendItems(
      db,
      call.convId,
      call.turnId,
      [{ kind: "tool_result", step: call.step, body }],
      now,
    );
    db.run("UPDATE tool_calls SET state = ?, ended_at = ?, child_pid = NULL WHERE id = ?", [
      result.status,
      now,
      call.id,
    ]);
    return {
      seq: seq as number,
      turnId: call.turnId,
      step: call.step,
      kind: "tool_result" as const,
      body,
    };
  })();
}

export function hasToolResult(db: Database, convId: string, callId: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM items WHERE conv_id = ? AND kind = 'tool_result' AND json_extract(body, '$.callId') = ?",
      )
      .get(convId, callId) !== null
  );
}

interface ToolCallDbRow {
  id: string;
  turn_id: string;
  conv_id: string;
  step: number;
  provider_call_id: string;
  name: string;
  input: string;
  state: ToolCallState;
  child_pid: number | null;
  child_start: string | null;
}

export function unfinishedToolCalls(db: Database): ToolCallRow[] {
  return (
    db
      .query(
        "SELECT * FROM tool_calls WHERE state IN ('received', 'pending_approval', 'approved', 'running') ORDER BY rowid",
      )
      .all() as ToolCallDbRow[]
  ).map((r) => ({
    id: r.id,
    turnId: r.turn_id,
    convId: r.conv_id,
    step: r.step,
    providerCallId: r.provider_call_id,
    name: r.name,
    input: JSON.parse(r.input),
    state: r.state,
    childPid: r.child_pid,
    childStart: r.child_start,
  }));
}

/**
 * Step 8 of a compaction, in one transaction: the summary item, the conversation's request
 * state reset (the old cache cannot serve a shorter prompt that starts with a summary), and the
 * turn completed. The caller finalizes the usage row inside the same transaction.
 */
export function finishCompaction(
  db: Database,
  c: { convId: string; turnId: string; body: CompactionBody; now: number },
): number {
  const [seq] = appendItems(
    db,
    c.convId,
    c.turnId,
    [{ kind: "compaction", step: 1, body: c.body }],
    c.now,
  );
  setRequestState(db, c.convId, { totalInput: 0, at: null, prefixKey: null });
  endTurn(db, { id: c.turnId, convId: c.convId, state: "completed", now: c.now });
  return seq as number;
}
