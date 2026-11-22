import { z } from "zod";
import { utf8Bytes } from "./bytes.ts";
import { id } from "./envelope.ts";
import {
  ARGV_CHARS,
  ARGV_ITEMS,
  ID_CHARS,
  ITEM_TEXT_BYTES,
  MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RUNNING_TEXT_BYTES,
  SKILL_TEXT,
  SKILLS,
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
  /**
   * The tool_call item this approval is for, so the page draws the card under it. Optional: a
   * local end older than the field sends none. A page older than the field refuses a card that
   * has it (strictObject), so the page is deployed before the local end is updated.
   */
  callId: id.optional(),
});

/**
 * Why an approval card with these fields could not reach a browser whole, or undefined when it
 * can. Checked before the approval exists: a card cut to fit would let the owner approve
 * something other than what runs, and one over the limits never shows at all.
 */
export function approvalProblem(
  fields: Omit<z.infer<typeof wireApproval>, "approvalId" | "conv" | "hash" | "expiresAt">,
): string | undefined {
  // The fields tars fills in later, at their largest.
  const big = "0".repeat(ID_CHARS);
  const card = {
    approvalId: big,
    conv: big,
    hash: "0".repeat(64),
    ...fields,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const parsed = wireApproval.safeParse(card);
  if (!parsed.success) return parsed.error.issues[0]?.path.join(".") || "approval";
  const m = { v: PROTOCOL_VERSION, id: big, kind: "approval.request", p: { approval: card } };
  return utf8Bytes(JSON.stringify(m)) > MESSAGE_BYTES ? "message" : undefined;
}

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
  /**
   * The skills the local end has, for the page's / menu; a local-only one is shown, not sent.
   * Optional, as certExpiresAt: a local end older than them sends neither. A page older than
   * them refuses a status that has them (strictObject): the page is deployed first.
   */
  skills: z
    .array(
      z.strictObject({
        name: z.string().max(ID_CHARS),
        description: z.string().max(SKILL_TEXT),
        localOnly: z.boolean(),
      }),
    )
    .max(SKILLS)
    .optional(),
  /** When the local end's link certificate expires (epoch ms). */
  certExpiresAt: z.number().optional(),
});

export type WireItem = z.infer<typeof wireItem>;
export type WireConv = z.infer<typeof wireConv>;
export type WireApproval = z.infer<typeof wireApproval>;
export type WireRunning = z.infer<typeof wireRunning>;
export type WireStatus = z.infer<typeof wireStatus>;
