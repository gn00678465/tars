import { z } from "zod";
import { envelope, id, inConv } from "./envelope.ts";
import { TEXT_BYTES } from "./limits.ts";

const empty = z.strictObject({});

/** What a browser sends. */
export const clientMessage = z.discriminatedUnion("kind", [
  envelope("hello", empty),
  envelope("conv.list", empty),
  inConv("conv.open", z.strictObject({ before: z.number().int().positive().optional() })),
  /** No conv: a new conversation. The text's byte limit is checked by parseClient. */
  envelope(
    "turn.submit",
    z.strictObject({ requestId: id, text: z.string().min(1).max(TEXT_BYTES) }),
  ),
  inConv("turn.abort", empty),
  envelope(
    "approval.decide",
    z.strictObject({
      approvalId: id,
      decision: z.enum(["approved", "denied"]),
      hash: z.string().length(64),
    }),
  ),
  envelope("status.get", empty),
]);

export type ClientMessage = z.infer<typeof clientMessage>;
export type ClientKind = ClientMessage["kind"];
