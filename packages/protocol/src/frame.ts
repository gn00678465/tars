import { z } from "zod";

/**
 * A browser connection: the random UUID the Worker gives it. Only that shape, so no value such as
 * "all" can stand for more than one.
 */
export const connId = z.uuid();

/** From the DO to the local end. `m` is checked by the local end with parseClient. */
export const frameToLocal = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("open"),
    conn: connId,
    jwt: z.string().max(8192),
    country: z.string().max(8).optional(),
    ua: z.string().max(256).optional(),
  }),
  z.strictObject({ t: z.literal("close"), conn: connId }),
  z.strictObject({ t: z.literal("msg"), conn: connId, m: z.unknown() }),
  z.strictObject({ t: z.literal("probe") }),
]);

/**
 * From the local end to the DO. `to` is always one connection: there is no "all", so the DO
 * cannot send content to a connection the local end has not checked.
 */
export const frameToRelay = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("msg"), to: connId, m: z.unknown() }),
  z.strictObject({ t: z.literal("drop"), conn: connId, code: z.number().int() }),
  z.strictObject({ t: z.literal("probe.ok") }),
]);

export type FrameToLocal = z.infer<typeof frameToLocal>;
export type FrameToRelay = z.infer<typeof frameToRelay>;
