import { z } from "zod";
import { ID_CHARS, PROTOCOL_VERSION } from "./limits.ts";

export const id = z.string().min(1).max(ID_CHARS);

const shape = <K extends string, P extends z.ZodType>(kind: K, p: P) => ({
  v: z.literal(PROTOCOL_VERSION),
  id,
  kind: z.literal(kind),
  re: id.optional(),
  p,
});

/**
 * Every message: { v, id, kind, conv?, re?, p }; p's shape depends on kind. Strict objects, so a
 * key no one knows is refused.
 */
export const envelope = <K extends string, P extends z.ZodType>(kind: K, p: P) =>
  z.strictObject({ ...shape(kind, p), conv: id.optional() });

/** A message that only makes sense in a conversation: conv is required. */
export const inConv = <K extends string, P extends z.ZodType>(kind: K, p: P) =>
  z.strictObject({ ...shape(kind, p), conv: id });
