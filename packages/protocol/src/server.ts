import { z } from "zod";
import { envelope, id } from "./envelope.ts";
import { DELTA_BYTES, MODELS, SNAPSHOT_ITEMS } from "./limits.ts";
import { wireApproval, wireConv, wireItem, wireModel, wireRunning, wireStatus } from "./wire.ts";

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
    z.strictObject({ reason: z.enum(NACK), need: z.enum(["client", "local"]).optional() }),
  ),
  envelope("conv.list.result", z.strictObject({ convs: z.array(wireConv).max(500) })),
  /** The answer to models.get, only to the page that asked: a page older than it never asks. */
  envelope("models.result", z.strictObject({ models: z.array(wireModel).max(MODELS) })),
  envelope(
    "conv.snapshot",
    z.strictObject({
      epoch: id,
      items: z.array(wireItem).max(SNAPSHOT_ITEMS),
      more: z.boolean(),
      running: wireRunning.optional(),
    }),
  ),
  envelope(
    "turn",
    z.strictObject({
      turn: id.optional(),
      requestId: id.optional(),
      state: z.enum(["started", "rejected", "completed", "failed", "aborted"]),
      reason: z.string().max(64).optional(),
      costUsd: z.number().optional(),
    }),
  ),
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
      state: z.enum(["approved", "denied", "expired", "cancelled"]),
      via: z.enum(["remote", "timeout", "abort"]),
    }),
  ),
  envelope("status", wireStatus),
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
