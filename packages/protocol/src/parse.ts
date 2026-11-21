import type { z } from "zod";
import { withinBytes } from "./bytes.ts";
import { clientMessage, type ClientMessage } from "./client.ts";
import { frameToLocal, frameToRelay, type FrameToLocal, type FrameToRelay } from "./frame.ts";
import { FRAME_BYTES, MESSAGE_BYTES, PROTOCOL_VERSION, TEXT_BYTES } from "./limits.ts";
import { serverMessage, type ServerMessage } from "./server.ts";

export type ParseFailure = "too_large" | "bad_message" | "version";
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ParseFailure };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Bytes first, then JSON, then the schema: a huge input is refused before it is parsed. Never
 * throws. A message whose `v` is not this version is "version", so the other side can say so.
 */
function parseWith<T>(
  raw: string,
  maxBytes: number,
  schema: z.ZodType<T>,
  versioned: boolean,
): Parsed<T> {
  if (typeof raw !== "string" || !withinBytes(raw, maxBytes))
    return { ok: false, reason: "too_large" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_message" };
  }
  if (!isRecord(json)) return { ok: false, reason: "bad_message" };
  if (versioned && json.v !== PROTOCOL_VERSION) return { ok: false, reason: "version" };
  const r = schema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, reason: "bad_message" };
}

export function parseClient(raw: string): Parsed<ClientMessage> {
  const r = parseWith(raw, MESSAGE_BYTES, clientMessage, true);
  if (r.ok && r.value.kind === "turn.submit" && !withinBytes(r.value.p.text, TEXT_BYTES))
    return { ok: false, reason: "too_large" };
  return r;
}

export const parseServer = (raw: string): Parsed<ServerMessage> =>
  parseWith(raw, MESSAGE_BYTES, serverMessage, true);

/** A frame the local end receives. */
export const parseFrame = (raw: string): Parsed<FrameToLocal> =>
  parseWith(raw, FRAME_BYTES, frameToLocal, false);

/** A frame the DO receives from the local end. */
export const parseRelayFrame = (raw: string): Parsed<FrameToRelay> =>
  parseWith(raw, FRAME_BYTES, frameToRelay, false);

/** A frame's `m`: JSON the DO already parsed, checked like a raw message, bytes included. */
export function checkClient(m: unknown): Parsed<ClientMessage> {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(m);
  } catch {
    return { ok: false, reason: "bad_message" };
  }
  return raw === undefined ? { ok: false, reason: "bad_message" } : parseClient(raw);
}
