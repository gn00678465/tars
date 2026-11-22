import { z } from "zod";
import { envelope, id } from "./envelope.ts";
import { DELTA_BYTES, MODELS, SNAPSHOT_ITEMS } from "./limits.ts";
import {
  wireApproval,
  wireCatalogEntry,
  wireContext,
  wireConv,
  wireData,
  wireItem,
  wireModel,
  wirePhase,
  wireRunning,
  wireStatus,
} from "./wire.ts";
import { wikiList, wikiPage, wikiSearch, wikiSource, wikiStatus } from "./wiki.ts";

const decided = z.enum(["approved", "denied", "expired", "cancelled"]);
/** Which connection decided: the one this goes to, or another browser. */
const source = z.enum(["this", "other_device"]);

export const NACK = [
  "offline",
  "busy",
  "auth_expired",
  "too_large",
  "version",
  "already_decided",
  "hash_mismatch",
  "not_allowed",
  "bad_message",
  "not_found",
] as const;
export type NackReason = (typeof NACK)[number];

/** What the local end, or the DO, sends to a browser. */
export const serverMessage = z.discriminatedUnion("kind", [
  envelope("hello", z.strictObject({ epoch: id, tars: z.string().max(32) })),
  envelope("ack", z.strictObject({ turn: id.optional() })),
  envelope(
    "nack",
    z.strictObject({
      reason: z.enum(NACK),
      need: z.enum(["client", "local"]).optional(),
      /** With already_decided: what was decided, and that it was not this connection. */
      state: decided.optional(),
      source: source.optional(),
    }),
  ),
  envelope("conv.list.result", z.strictObject({ convs: z.array(wireConv).max(500) })),
  /** The answer to models.get, only to the page that asked: a page older than it never asks. */
  envelope(
    "models.result",
    z.strictObject({
      models: z.array(wireModel).max(MODELS),
      /** The UTC date the local list last saw a model from a provider, YYYY-MM-DD. */
      updatedAt: z.string().max(10).optional(),
      /** The read-only price table: active models first, then the others, up to MODELS. */
      catalog: z.array(wireCatalogEntry).max(MODELS).optional(),
      /** How many the list has; more than catalog holds when it was cut. */
      catalogTotal: z.number().int().nonnegative().optional(),
    }),
  ),
  envelope(
    "conv.snapshot",
    z.strictObject({
      epoch: id,
      items: z.array(wireItem).max(SNAPSHOT_ITEMS),
      more: z.boolean(),
      running: wireRunning.optional(),
      /**
       * A compaction of this conversation is under way: one the owner asked for, or the one a
       * turn runs before it starts. It has no turn the page knows, so it is not a phase.
       */
      compacting: z.literal(true).optional(),
    }),
  ),
  envelope(
    "turn",
    z.strictObject({
      turn: id.optional(),
      requestId: id.optional(),
      state: z.enum(["started", "rejected", "completed", "failed", "aborted", "interrupted"]),
      reason: z.string().max(64).optional(),
      /** The local end's figures for reason: amounts, limits, the provider. */
      data: wireData.optional(),
      costUsd: z.number().optional(),
    }),
  ),
  /** What the running turn is doing now; sent when it changes. */
  envelope("turn.phase", z.strictObject({ turn: id, phase: wirePhase })),
  envelope("item", z.strictObject({ item: wireItem })),
  envelope("delta", z.strictObject({ turn: id, text: z.string().max(DELTA_BYTES) })),
  envelope(
    "notice",
    z.strictObject({
      code: z.string().max(64),
      data: z.record(z.string().max(64), z.union([z.string().max(256), z.number()])).optional(),
    }),
  ),
  envelope("approval.request", z.strictObject({ approval: wireApproval })),
  envelope(
    "approval.resolved",
    z.strictObject({
      approvalId: id,
      state: decided,
      via: z.enum(["remote", "timeout", "abort"]),
      /** When it was decided or ran out, by the local end's clock. */
      at: z.number().optional(),
      /** For a decision: this connection's or another's. */
      source: source.optional(),
    }),
  ),
  /** A compaction the owner asked for: once when it starts, once when it ends. */
  envelope(
    "compact",
    z.strictObject({
      state: z.enum(["started", "completed", "skipped", "failed", "aborted"]),
      reason: z.string().max(64).optional(),
      data: wireData.optional(),
    }),
  ),
  /** The open conversation's context; after conv.open, a turn's end and a compaction's. */
  envelope("conv.context", wireContext),
  envelope("status", wireStatus),
  /** The answers to wiki.*, only to the page that asked. */
  envelope("wiki.status.result", wikiStatus),
  envelope("wiki.list.result", wikiList),
  envelope("wiki.page.result", wikiPage),
  envelope("wiki.search.result", wikiSearch),
  envelope("wiki.source.result", wikiSource),
  envelope(
    "relay.status",
    z.strictObject({
      online: z.boolean(),
      lastSeenAt: z.number().optional(),
      localSince: z.number().optional(),
    }),
  ),
]);

export type ServerMessage = z.infer<typeof serverMessage>;
export type ServerKind = ServerMessage["kind"];
