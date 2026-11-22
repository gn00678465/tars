import { z } from "zod";
import { envelope, id, inConv } from "./envelope.ts";
import { KEEP_LAST, TEXT_BYTES } from "./limits.ts";
import { wireModelRef } from "./wire.ts";

const empty = z.strictObject({});

/** What a browser sends. */
export const clientMessage = z.discriminatedUnion("kind", [
  envelope("hello", empty),
  envelope("conv.list", empty),
  inConv("conv.open", z.strictObject({ before: z.number().int().positive().optional() })),
  /**
   * No conv: a new conversation. The text's byte limit is checked by parseClient.
   *
   * model, from and keepLast are only for a new conversation (no conv): model picks its model
   * instead of [chat]'s default; from continues that conversation in it, carrying its text, as
   * the terminal's /model does, so from needs model; keepLast needs from. Optional: a local end
   * older than them refuses a turn.submit that has one (strictObject), so the page offers them
   * only after models.result came. The page can then go out before the local end is updated,
   * which status's optional fields need (see wireStatus).
   */
  envelope(
    "turn.submit",
    z
      .strictObject({
        requestId: id,
        text: z.string().min(1).max(TEXT_BYTES),
        model: wireModelRef.optional(),
        from: id.optional(),
        keepLast: z.number().int().positive().max(KEEP_LAST).optional(),
      })
      .refine((p) => p.from === undefined || p.model !== undefined, "from needs model")
      .refine((p) => p.keepLast === undefined || p.from !== undefined, "keepLast needs from"),
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
  /** The models a new conversation can be started on; answered by models.result. */
  envelope("models.get", empty),
]);

export type ClientMessage = z.infer<typeof clientMessage>;
export type ClientKind = ClientMessage["kind"];
