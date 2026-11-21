import { z } from "zod";
import { id } from "./envelope.ts";
import {
  ARGV_CHARS,
  ARGV_ITEMS,
  ITEM_TEXT_BYTES,
  RUNNING_TEXT_BYTES,
  TOOL_TEXT_BYTES,
} from "./limits.ts";

// .max() counts UTF-16 units and the limits are bytes, so these are the second line: the local
// end cuts by bytes before sending, and every parse checks the whole message's bytes first.

const base = { seq: z.number().int(), turn: id };

export const wireItem = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("user"),
    text: z.string().max(ITEM_TEXT_BYTES),
    truncated: z.boolean(),
  }),
  /** The text carried over from an earlier conversation, as a marker: `from` is that one's id. */
  z.strictObject({ ...base, kind: z.literal("carried"), from: id }),
  z.strictObject({
    ...base,
    kind: z.literal("assistant"),
    text: z.string().max(ITEM_TEXT_BYTES),
    truncated: z.boolean(),
    state: z.enum(["complete", "truncated", "aborted", "incomplete"]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("tool_call"),
    callId: id,
    name: z.string().max(64),
    /** The input as JSON text. */
    input: z.string().max(TOOL_TEXT_BYTES),
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("tool_result"),
    callId: id,
    status: z.string().max(32),
    exit: z.number().int().optional(),
    text: z.string().max(TOOL_TEXT_BYTES),
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("usage"),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
    costSource: z.string().max(16),
  }),
  /** Only the code: an error's message and detail may carry the upstream's words. */
  z.strictObject({ ...base, kind: z.literal("error"), code: z.string().max(64) }),
  z.strictObject({
    ...base,
    kind: z.literal("compaction"),
    text: z.string().max(ITEM_TEXT_BYTES),
    truncated: z.boolean(),
  }),
]);

export const wireConv = z.strictObject({
  id,
  title: z.string().max(200),
  provider: z.string().max(32),
  model: z.string().max(128),
  updatedAt: z.number(),
  parentId: id.optional(),
});

export const wireApproval = z.strictObject({
  approvalId: id,
  conv: id,
  hash: z.string().length(64),
  action: z.literal("run_script"),
  script: z.string().max(128),
  version: z.string().max(64),
  summary: z.string().max(500),
  effects: z.string().max(32),
  domains: z.array(z.string().max(256)).max(32),
  secret: z.string().max(128).nullable(),
  argv: z.array(z.string().max(ARGV_CHARS)).max(ARGV_ITEMS),
  expiresAt: z.number(),
});

export const wireRunning = z.strictObject({
  turn: id,
  text: z.string().max(RUNNING_TEXT_BYTES),
  truncated: z.boolean(),
});

export const wireStatus = z.strictObject({
  /** The local end's clock: the page counts time left with it, not the phone's. */
  now: z.number(),
  providers: z
    .array(
      z.strictObject({
        name: z.string().max(32),
        spentUsd: z.number(),
        quotaUsd: z.number(),
        warnUsd: z.number(),
        stopUsd: z.number(),
        stopped: z.boolean(),
      }),
    )
    .max(8),
  pricesWarn: z.boolean(),
  pendingApprovals: z.number().int(),
  turnRunning: z.boolean(),
  notify: z.enum(["ok", "not_configured"]),
});

export type WireItem = z.infer<typeof wireItem>;
export type WireConv = z.infer<typeof wireConv>;
export type WireApproval = z.infer<typeof wireApproval>;
export type WireRunning = z.infer<typeof wireRunning>;
export type WireStatus = z.infer<typeof wireStatus>;
