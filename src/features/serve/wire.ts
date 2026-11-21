import type { Database } from "bun:sqlite";
import {
  ITEM_TEXT_BYTES,
  RUNNING_TEXT_BYTES,
  TOOL_TEXT_BYTES,
  type WireApproval,
  type WireConv,
  type WireItem,
  type WireRunning,
} from "@tars/protocol";
import { cutUtf8, tailUtf8, utf8Bytes } from "../agent/bytes.ts";
import type { Conversation } from "../agent/store.ts";
import type { ApprovalRecord, Item } from "../agent/types.ts";

export interface UsageFigures {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly costSource: string;
}

/** A usage item holds only its row's id; the figures sent are in the usage row. */
export const usageFigures =
  (db: Database) =>
  (usageId: number): UsageFigures | undefined =>
    (db
      .query(
        `SELECT uncached_input_tokens + cache_read_tokens + cache_write_tokens AS inputTokens,
           output_tokens AS outputTokens, cost_usd AS costUsd, cost_source AS costSource
         FROM usage WHERE id = ?`,
      )
      .get(usageId) as UsageFigures | null) ?? undefined;

const cut = (text: string, max: number) => {
  const kept = cutUtf8(text, max);
  return { text: kept, truncated: kept.length < text.length };
};

/**
 * An item as it leaves this machine. Kinds and fields are an allow-list: a kind not named here,
 * the wiki index included, is not sent, and neither is anything the switch does not copy (the
 * provider's native blocks, thinking keys, call ids, an error's message and detail).
 */
export function toWire(
  item: Item,
  usageOf: (usageId: number) => UsageFigures | undefined,
): WireItem | undefined {
  const base = { seq: item.seq, turn: item.turnId };
  switch (item.kind) {
    case "user":
      // The carried text can be 40% of a model's window: only where it came from goes out.
      return item.body.carriedFrom === undefined
        ? { ...base, kind: "user", ...cut(item.body.text, ITEM_TEXT_BYTES) }
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
      };
    case "usage": {
      const u = usageOf(item.body.usageId);
      return u === undefined
        ? undefined
        : { ...base, kind: "usage", ...u, costSource: u.costSource.slice(0, 16) };
    }
    case "error":
      return { ...base, kind: "error", code: item.body.code.slice(0, 64) };
    case "compaction":
      return { ...base, kind: "compaction", ...cut(item.body.summary, ITEM_TEXT_BYTES) };
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
});

/** The running text's last RUNNING_TEXT_BYTES, cut on a character boundary. */
export function wireRunning(turn: string, text: string): WireRunning {
  const tail = tailUtf8(text, RUNNING_TEXT_BYTES);
  return { turn, text: tail, truncated: tail.length < text.length };
}

export const wireBytes = (m: unknown) => utf8Bytes(JSON.stringify(m));
