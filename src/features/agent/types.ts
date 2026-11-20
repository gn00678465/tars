// The neutral format the loop speaks. S3 moves these to packages/protocol.

import type { Provider } from "../../core/secrets.ts";
import type { Price } from "./catalog.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const TOOL_NAMES = ["skill_load", "file_read", "tars"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface SystemBlock {
  readonly text: string;
  readonly cache: boolean;
}

export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: object;
}

export type CacheTtl = "5m" | "1h";

export interface ModelRequest {
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly system: readonly SystemBlock[];
  readonly tools: readonly ToolSpec[];
  /** buildActiveHistory's result, in order. */
  readonly history: readonly Item[];
  readonly cacheTtl: CacheTtl;
  /** false: no cache breakpoint on the last message (a summary request is sent once). */
  readonly cacheHistory: boolean;
  /** Absent: no reasoning parameters at all. "off": thinking turned off (a summary request). */
  readonly effort?: Effort | "off";
  /** A tool result longer than this is cut before it is sent. */
  readonly toolResultBytes: number;
  /** thinkingKey of this request; assistant items made under another key lose their thinking. */
  readonly thinkingKey: string;
  readonly capabilities: {
    readonly thinkingTypes: readonly string[];
    /** The model's effort levels in the catalog; empty when it has none. */
    readonly effortLevels: readonly Effort[];
  };
}

export interface Usage {
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
}

export type InputUsage = Pick<
  Usage,
  "uncachedInputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

export const ZERO_USAGE: Usage = {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
};

export const totalInputTokens = (u: InputUsage) =>
  u.uncachedInputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export type StopReason = "end" | "tool_use" | "max_tokens" | "other";

export type ProviderEvent =
  /** usage absent: the endpoint does not report input tokens when the stream starts. */
  | { readonly type: "start"; readonly usage?: InputUsage }
  | { readonly type: "thinking" }
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool_call";
      readonly providerCallId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "end";
      readonly stop: StopReason;
      /** Absent: the response ended without reporting usage; the cost is estimated. */
      readonly usage?: Usage;
      readonly costUsd?: number;
      /** The blocks to replay as the assistant message; empty when there is nothing to replay. */
      readonly native: readonly unknown[];
    };

export interface ListedModel {
  readonly id: string;
  readonly label: string;
  readonly lifecycle?: "active" | "deprecated" | "retired";
  readonly retiresAt?: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly effortLevels?: readonly Effort[];
  readonly thinkingTypes?: readonly string[];
  /** US dollars per million tokens, from upstream. */
  readonly price?: Partial<Price>;
  readonly priceSource?: "openrouter";
  /** Capability fields guessed from other upstream fields; a value already listed is kept. */
  readonly inferred?: readonly "effortLevels"[];
}

// --- Stored items. items rows are written once and never changed.

export type AssistantState = "complete" | "truncated" | "aborted" | "incomplete";

export const TOOL_CALL_STATES = [
  "received",
  "pending_approval",
  "approved",
  "running",
  "done",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "skipped",
  "refused",
  "interrupted",
] as const;
export type ToolCallState = (typeof TOOL_CALL_STATES)[number];
export type ToolCallEndState = Exclude<
  ToolCallState,
  "received" | "pending_approval" | "approved" | "running"
>;

export interface UserBody {
  readonly text: string;
  /** Set: this item is the text carried over from that earlier conversation (its id). */
  readonly carriedFrom?: string;
}
export interface AssistantBody {
  readonly text: string;
  readonly state: AssistantState;
  /** The provider's content blocks, replayed as is; null when the response never reached its end. */
  readonly native: readonly unknown[] | null;
  /** The request's thinkingKey; absent on items written before it existed. */
  readonly thinkingKey?: string;
}
export interface ToolCallBody {
  readonly callId: string;
  readonly providerCallId: string;
  readonly name: string;
  readonly input: unknown;
}
export interface ToolResultBody {
  readonly callId: string;
  readonly status: ToolCallEndState;
  readonly text: string;
  readonly truncated: boolean;
  readonly exit?: number;
}
export interface UsageBody {
  readonly usageId: number;
}
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}
export interface CompactionBody {
  /** seq of the first item kept verbatim; always a user item, the start of a turn. */
  readonly firstKeptSeq: number;
  readonly summary: string;
  readonly tokensBefore: number;
  readonly replacedCount: number;
  readonly trigger: "manual" | "auto";
  readonly usageId: number;
}

/** The wiki's page list as one context generation read it; replayed byte for byte after. */
export interface WikiIndexBody {
  /** The whole text sent to the model, its tags included. Never empty. */
  readonly text: string;
  /** sha256 of the index.md it was read from. */
  readonly indexSha256: string;
  /** Pages index.md listed, and pages this text lists. */
  readonly pages: number;
  readonly listed: number;
}

interface ItemOf<K extends string, B> {
  readonly seq: number;
  readonly turnId: string;
  /** The turn's model request it belongs to; the user message is 0. */
  readonly step: number;
  readonly kind: K;
  readonly body: B;
}

export type UserItem = ItemOf<"user", UserBody>;
export type AssistantItem = ItemOf<"assistant", AssistantBody>;
export type ToolCallItem = ItemOf<"tool_call", ToolCallBody>;
export type ToolResultItem = ItemOf<"tool_result", ToolResultBody>;
export type UsageItem = ItemOf<"usage", UsageBody>;
export type ErrorItem = ItemOf<"error", ErrorBody>;
export type CompactionItem = ItemOf<"compaction", CompactionBody>;
export type WikiIndexItem = ItemOf<"wiki_index", WikiIndexBody>;

export type Item =
  | UserItem
  | AssistantItem
  | ToolCallItem
  | ToolResultItem
  | UsageItem
  | ErrorItem
  | CompactionItem
  | WikiIndexItem;
export type ItemKind = Item["kind"];

/** An item before the store gives it a seq. */
export type NewItem = Item extends infer I
  ? I extends Item
    ? Omit<I, "seq" | "turnId">
    : never
  : never;

/** The kinds a model request sees; usage, error and compaction stay out of it. */
export type ContextItem = UserItem | AssistantItem | ToolCallItem | ToolResultItem;

export const isContextItem = (item: Item): item is ContextItem =>
  item.kind === "user" ||
  item.kind === "assistant" ||
  item.kind === "tool_call" ||
  item.kind === "tool_result";

// --- Turns, notices, approvals.

export type TurnKind = "chat" | "compaction";

export type BudgetReason = "budget_stopped" | "daily_cap" | "turn_cap";
export type ModelReason = "unknown_model" | "price_incomplete" | "prices_stale";
export type CompactReason = "compact_too_large" | "compact_truncated" | "compact_bad_summary";

/** Why a message was refused before its turn existed. */
export type RejectReason =
  | "aborted"
  | "config_invalid"
  | "catalog_invalid"
  | "boot_failed"
  | "provider_disabled"
  | "no_key"
  | ModelReason
  | "conv_too_long"
  | BudgetReason
  | "budget_unreadable";

/** Why a turn ended as failed. */
export type FailReason =
  | "conv_too_long"
  | BudgetReason
  | "budget_unreadable"
  | "request_limit"
  | "provider_spend_limit"
  | "auth"
  | "bad_request"
  | "provider_error"
  | "stream_interrupted"
  | CompactReason;

export type ReasonCode = RejectReason | FailReason;
export type TurnState = "running" | "completed" | "failed" | "aborted" | "interrupted";

export const NOTICE_CODES = [
  "compact_start",
  "compact_skipped",
  "compact_failed",
  "blocked",
  "budget_warn",
  "prices_warn",
  "context_warn",
  "retrying",
  "output_capped",
  "effort_unsupported",
  "effort_clamped",
  "effort_truncated",
  "approval_no_tty",
  "usage_missing",
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

export interface ApprovalFields {
  readonly action: "run_script";
  readonly script: string;
  readonly version: string;
  readonly summary: string;
  readonly effects: string;
  readonly domains: readonly string[];
  readonly secret: string | null;
  readonly argv: readonly string[];
  readonly expiresAt: number;
  readonly approvalId: string;
}

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalRecord {
  readonly id: string;
  readonly toolCallId: string;
  readonly convId: string;
  readonly hash: string;
  readonly fields: ApprovalFields;
  readonly state: ApprovalState;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ChatConfig {
  readonly effort: Effort;
  /** The provider tars chat uses without --model. */
  readonly provider: Provider;
}
