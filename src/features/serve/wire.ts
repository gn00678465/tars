import type { Database } from "bun:sqlite";
import {
  DATA_KEYS,
  EFFORT_NAME,
  ITEM_TEXT_BYTES,
  RUNNING_TEXT_BYTES,
  TOOL_TEXT_BYTES,
  type WireApproval,
  type WireConv,
  type WireData,
  type WireItem,
  type WireRunning,
} from "@tars/protocol";
import { utf8Bytes } from "../agent/bytes.ts";
import type { Conversation } from "../agent/store.ts";
import type { ApprovalRecord, ApprovalState, Item } from "../agent/types.ts";

export interface UsageFigures {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly costSource: string;
  readonly cacheReadTokens: number;
  readonly thinkingTokens: number;
  readonly effort?: string;
}

/** What an item refers to by id and the page shows as figures: rows read when it is sent. */
export interface WireLookup {
  usage(usageId: number): UsageFigures | undefined;
  /** From a tool call's start to its end; undefined when it never started or has not ended. */
  duration(callId: string): number | undefined;
  /** A compaction's request: what it cost and when it was sent. */
  compaction(usageId: number): { costUsd: number; at: number } | undefined;
  /** An approval's settled state; undefined while pending or when there is no such approval. */
  decided(approvalId: string): Exclude<ApprovalState, "pending"> | undefined;
}

export function wireLookup(db: Database): WireLookup {
  const usage = db.query(
    `SELECT u.uncached_input_tokens + u.cache_read_tokens + u.cache_write_tokens AS inputTokens,
       u.output_tokens AS outputTokens, u.cost_usd AS costUsd, u.cost_source AS costSource,
       u.cache_read_tokens AS cacheReadTokens, u.thinking_tokens AS thinkingTokens,
       t.effort AS effort
     FROM usage u LEFT JOIN turns t ON t.id = u.turn_id WHERE u.id = ?`,
  );
  const times = db.query("SELECT started_at AS s, ended_at AS e FROM tool_calls WHERE id = ?");
  const approval = db.query("SELECT state FROM approvals WHERE id = ?");
  const request = db.query("SELECT cost_usd AS costUsd, at FROM usage WHERE id = ?");
  return {
    usage: (usageId) => {
      const row = usage.get(usageId) as (UsageFigures & { effort: string | null }) | null;
      if (row === null) return undefined;
      const { effort, ...rest } = row;
      return effort === null ? rest : { ...rest, effort };
    },
    duration: (callId) => {
      const row = times.get(callId) as { s: number | null; e: number | null } | null;
      return row?.s == null || row.e == null ? undefined : Math.max(0, row.e - row.s);
    },
    compaction: (usageId) =>
      (request.get(usageId) as { costUsd: number; at: number } | null) ?? undefined,
    decided: (approvalId) => {
      const state = (approval.get(approvalId) as { state: ApprovalState } | null)?.state;
      return state === undefined || state === "pending" ? undefined : state;
    },
  };
}

/** Within the protocol's limits for data; the loop's values are short already. */
export const wireData = (data: Readonly<Record<string, string | number>>): WireData =>
  Object.fromEntries(
    Object.entries(data)
      .slice(0, DATA_KEYS)
      .map(([k, v]) => [k.slice(0, 64), typeof v === "string" ? v.slice(0, 256) : v]),
  );

/** A character's bytes once JSON.stringify writes it inside a string. */
function jsonCost(c: string): number {
  const n = c.codePointAt(0) as number;
  if (
    n === 0x22 ||
    n === 0x5c ||
    n === 0x08 ||
    n === 0x09 ||
    n === 0x0a ||
    n === 0x0c ||
    n === 0x0d
  )
    return 2;
  // Other control characters and a lone surrogate come out as \uXXXX.
  if (n < 0x20 || (n >= 0xd800 && n <= 0xdfff)) return 6;
  return n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4;
}

/**
 * The limits count bytes as the message carries them, escapes included: counted on the raw
 * text, a run of control characters grows sixfold, and the newest item alone could outgrow a
 * snapshot, which then has no seq to page back from. Cut on a character boundary.
 */
function jsonHead(text: string, max: number): string {
  let used = 0;
  let end = 0;
  for (const c of text) {
    used += jsonCost(c);
    if (used > max) break;
    end += c.length;
  }
  return text.slice(0, end);
}

function jsonTail(text: string, max: number): string {
  const chars = Array.from(text);
  let used = 0;
  let start = chars.length;
  while (start > 0) {
    used += jsonCost(chars[start - 1] as string);
    if (used > max) break;
    start--;
  }
  return chars.slice(start).join("");
}

const cut = (text: string, max: number) => {
  const kept = jsonHead(text, max);
  return { text: kept, truncated: kept.length < text.length };
};

/**
 * An item as it leaves this machine. Kinds and fields are an allow-list: a kind not named here,
 * the wiki index included, is not sent, and neither is anything the switch does not copy (the
 * provider's native blocks, thinking keys, call ids, an error's message and detail).
 */
export function toWire(item: Item, lookup: WireLookup): WireItem | undefined {
  const base = { seq: item.seq, turn: item.turnId };
  switch (item.kind) {
    case "user":
      // The carried text can be 40% of a model's window: only where it came from goes out.
      return item.body.carriedFrom === undefined
        ? {
            ...base,
            kind: "user",
            ...cut(item.body.text, ITEM_TEXT_BYTES),
            ...(item.body.uiCall === undefined ? {} : { uiCall: item.body.uiCall }),
          }
        : { ...base, kind: "carried", from: item.body.carriedFrom };
    case "assistant":
      return {
        ...base,
        kind: "assistant",
        ...cut(item.body.text, ITEM_TEXT_BYTES),
        state: item.body.state,
      };
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        callId: item.body.callId,
        name: item.body.name.slice(0, 64),
        ...(({ text, truncated }) => ({ input: text, truncated }))(
          cut(JSON.stringify(item.body.input) ?? "null", TOOL_TEXT_BYTES),
        ),
      };
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        callId: item.body.callId,
        status: item.body.status,
        ...(item.body.exit === undefined ? {} : { exit: item.body.exit }),
        ...(({ text, truncated }) => ({ text, truncated: truncated || item.body.truncated }))(
          cut(item.body.text, TOOL_TEXT_BYTES),
        ),
        ...((ms) => (ms === undefined ? {} : { durationMs: ms }))(
          lookup.duration(item.body.callId),
        ),
        ...(item.body.refusal === undefined ? {} : { refusal: item.body.refusal }),
      };
    case "usage": {
      const u = lookup.usage(item.body.usageId);
      if (u === undefined) return undefined;
      const { effort, ...figures } = u;
      return {
        ...base,
        kind: "usage",
        ...figures,
        costSource: u.costSource.slice(0, 16),
        ...(effort === undefined || effort === "" ? {} : { effort: effort.slice(0, EFFORT_NAME) }),
      };
    }
    case "error":
      return {
        ...base,
        kind: "error",
        code: item.body.code.slice(0, 64),
        ...(item.body.data === undefined ? {} : { data: wireData(item.body.data) }),
      };
    case "compaction": {
      const b = item.body;
      const req = lookup.compaction(b.usageId);
      return {
        ...base,
        kind: "compaction",
        ...cut(b.summary, ITEM_TEXT_BYTES),
        ...(req === undefined ? {} : { at: req.at, costUsd: req.costUsd }),
        trigger: b.trigger,
        beforeTokens: b.tokensBefore,
        ...(b.keptTokens === undefined ? {} : { keptTokens: b.keptTokens }),
        count: b.replacedCount,
        firstKeptSeq: b.firstKeptSeq,
      };
    }
    default:
      return undefined;
  }
}

export const wireConv = (c: Conversation): WireConv => ({
  id: c.id,
  title: c.title.slice(0, 200),
  provider: c.provider,
  model: c.model.slice(0, 128),
  updatedAt: c.updatedAt,
  ...(c.parentId === undefined ? {} : { parentId: c.parentId }),
  effort: c.effort,
});

export const wireApproval = (a: ApprovalRecord): WireApproval => ({
  approvalId: a.id,
  conv: a.convId,
  hash: a.hash,
  action: a.fields.action,
  script: a.fields.script,
  version: a.fields.version,
  summary: a.fields.summary,
  effects: a.fields.effects,
  domains: [...a.fields.domains],
  secret: a.fields.secret,
  argv: [...a.fields.argv],
  expiresAt: a.expiresAt,
  callId: a.toolCallId,
});

/** The running text's last RUNNING_TEXT_BYTES as JSON writes them. */
export function wireRunning(turn: string, text: string): WireRunning {
  const tail = jsonTail(text, RUNNING_TEXT_BYTES);
  return { turn, text: tail, truncated: tail.length < text.length };
}

export const wireBytes = (m: unknown) => utf8Bytes(JSON.stringify(m));
