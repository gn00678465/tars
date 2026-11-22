import { z } from "zod";
import { utf8Bytes } from "./bytes.ts";
import { id } from "./envelope.ts";
import {
  ARGV_CHARS,
  ARGV_ITEMS,
  DATA_KEYS,
  EFFORT_LEVELS,
  EFFORT_NAME,
  ID_CHARS,
  ITEM_TEXT_BYTES,
  MESSAGE_BYTES,
  PRICE_WARNS,
  PROTOCOL_VERSION,
  RUNNING_TEXT_BYTES,
  SKILL_TEXT,
  SKILLS,
  TOOL_TEXT_BYTES,
} from "./limits.ts";

// .max() counts UTF-16 units and the limits are bytes, so these are the second line: the local
// end cuts by bytes before sending, and every parse checks the whole message's bytes first.

const base = { seq: z.number().int(), turn: id };
const count = z.number().int().nonnegative();

/**
 * Figures the local end adds to a failure: a provider's name, amounts, limits, a model id. Never
 * the upstream's words, which stay on this machine as an error's message and detail do.
 */
export const wireData = z
  .record(z.string().max(64), z.union([z.string().max(256), z.number()]))
  .refine((d) => Object.keys(d).length <= DATA_KEYS, "too many keys");

/** What a running turn is doing, for the page's status line. */
export const PHASES = ["thinking", "replying", "running_script", "waiting_approval"] as const;
export const wirePhase = z.enum(PHASES);

/** Why a tool call was refused without running: the page names each. */
export const REFUSALS = ["not_offered", "changed", "budget"] as const;

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
    /** From the call's start to its end; absent when it never started. */
    durationMs: count.optional(),
    /** With status refused: why. Absent from a local end older than it, and from older rows. */
    refusal: z.enum(REFUSALS).optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("usage"),
    /** Uncached, cache read and cache write together. */
    inputTokens: z.number(),
    /** Output, thinking included. */
    outputTokens: z.number(),
    costUsd: z.number(),
    costSource: z.string().max(16),
    /** Of inputTokens, read from the provider's cache. */
    cacheReadTokens: count.optional(),
    /** Of outputTokens, spent thinking. */
    thinkingTokens: count.optional(),
    /** The level the turn was sent with; absent when it was sent with none. */
    effort: z.string().min(1).max(EFFORT_NAME).optional(),
  }),
  /** The code and the local end's own figures: message and detail may carry the upstream's words. */
  z.strictObject({
    ...base,
    kind: z.literal("error"),
    code: z.string().max(64),
    data: wireData.optional(),
  }),
  /** The fields after text are absent from rows written before them. */
  z.strictObject({
    ...base,
    kind: z.literal("compaction"),
    text: z.string().max(ITEM_TEXT_BYTES),
    truncated: z.boolean(),
    at: z.number().optional(),
    trigger: z.enum(["manual", "auto"]).optional(),
    /** The context's tokens before it. */
    beforeTokens: count.optional(),
    /** About how many tokens the turns kept verbatim hold: an estimate. */
    keptTokens: count.optional(),
    /** Items it replaced with the summary. */
    count: count.optional(),
    costUsd: z.number().optional(),
    /** The first item kept verbatim: those before it are in the summary. */
    firstKeptSeq: z.number().int().optional(),
  }),
]);

/**
 * A reasoning effort level by name (low … max). A string, not the local end's list: a level a
 * newer local end adds must not make an older page refuse the whole message.
 */
export const wireEffort = z.string().min(1).max(EFFORT_NAME);

export const wireModelRef = z.strictObject({
  provider: z.string().max(32),
  id: z.string().max(128),
});

/** A model in models.result. */
export const wireModel = z.strictObject({
  ...wireModelRef.shape,
  label: z.string().max(128),
  /**
   * The effective window in tokens, for a usable one: what a continuation's carried text is at
   * most 40% of.
   */
  window: z.number().int().positive().optional(),
  /** The model a new conversation gets when none is named. */
  isDefault: z.boolean(),
  /** Why it cannot be used now, as a turn's rejection code; absent when it can. */
  unusable: z.string().max(64).optional(),
  /**
   * The effort levels it takes, lowest first; empty when it takes none. Absent from a local end
   * older than the effort control: the page then does not offer one.
   */
  effortLevels: z.array(wireEffort).max(EFFORT_LEVELS).optional(),
  /** The level a new conversation on it gets: [chat]'s, or the nearest one it takes. */
  defaultEffort: wireEffort.optional(),
});

export const wireConv = z.strictObject({
  id,
  title: z.string().max(200),
  provider: z.string().max(32),
  model: z.string().max(128),
  updatedAt: z.number(),
  parentId: id.optional(),
  /** Its effort level, which its next turn is sent with unless the model takes another. */
  effort: wireEffort.optional(),
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
  phase: wirePhase.optional(),
});

/** A model in the read-only price table: every status, prices as the local list has them. */
export const wireCatalogEntry = z.strictObject({
  ...wireModelRef.shape,
  label: z.string().max(128),
  status: z.enum(["candidate", "active", "disabled", "retired"]),
  window: z.number().int().positive().optional(),
  /** US dollars per million tokens; a field the list lacks is absent. */
  price: z
    .strictObject({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  priceSource: z.enum(["manual", "openrouter"]).optional(),
  /** The UTC date the price was confirmed, YYYY-MM-DD. */
  pricedAt: z.string().max(10).optional(),
});

/** A conversation's context against its model's window, and the thresholds that act on it. */
export const wireContext = z.strictObject({
  /** The last request's input tokens. */
  contextUsed: count,
  /** The model's effective window. */
  contextLimit: z.number().int().positive(),
  /** Of the last request's input, the share read from the cache, 0 to 100. */
  cacheHitPct: z.number().min(0).max(100).optional(),
  lastCompactedAt: z.number().optional(),
  /**
   * contextUsed is tars's estimate, not a request's count: after a compaction, before the next
   * request measures it.
   */
  estimated: z.literal(true).optional(),
  warnRatio: z.number(),
  compactRatio: z.number(),
  stopRatio: z.number(),
  autoCompact: z.boolean(),
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
        /** month: spending is counted per UTC month; cumulative: since the start. */
        period: z.enum(["month", "cumulative"]).optional(),
        /** false only when the whole figure is from the provider's bill (tars cost adjust). */
        estimated: z.boolean().optional(),
      }),
    )
    .max(8),
  pricesWarn: z.boolean(),
  /** The models pricesWarn is about: a price old or missing. */
  prices: z
    .array(
      z.strictObject({
        provider: z.string().max(32),
        model: z.string().max(128),
        /** Days since it was confirmed; absent when it never was. */
        ageDays: z.number().int().optional(),
        state: z.enum(["stale", "refused", "missing"]),
      }),
    )
    .max(PRICE_WARNS)
    .optional(),
  /** Models the list has seen but the owner has not taken on, and models taken off. */
  candidates: count.optional(),
  retired: count.optional(),
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
  /** The local end takes conv.archive: a page offers archiving only when this is here. */
  archive: z.literal(true).optional(),
});

export type WireItem = z.infer<typeof wireItem>;
export type WireConv = z.infer<typeof wireConv>;
export type WireApproval = z.infer<typeof wireApproval>;
export type WireRunning = z.infer<typeof wireRunning>;
export type WireStatus = z.infer<typeof wireStatus>;
export type WireModel = z.infer<typeof wireModel>;
export type WireCatalogEntry = z.infer<typeof wireCatalogEntry>;
export type WireContext = z.infer<typeof wireContext>;
export type WireData = z.infer<typeof wireData>;
export type Phase = (typeof PHASES)[number];
export type Refusal = (typeof REFUSALS)[number];
