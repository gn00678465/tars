import { z } from "zod";
import { ID_CHARS, PROTOCOL_VERSION } from "./limits.ts";

export const id = z.string().min(1).max(ID_CHARS);

/**
 * Every message: { v, id, kind, conv?, re?, p }; p's shape depends on kind. Strict objects, so a
 * key no one knows is refused. `conv` is required where the message only makes sense with one.
 */
export const envelope = <K extends string, P extends z.ZodType>(
  kind: K,
  p: P,
  conv: "optional" | "required" = "optional",
) =>
  z.strictObject({
    v: z.literal(PROTOCOL_VERSION),
    id,
    kind: z.literal(kind),
    conv: conv === "required" ? id : id.optional(),
    re: id.optional(),
    p,
  });
