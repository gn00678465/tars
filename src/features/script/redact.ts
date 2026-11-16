export const REDACTED = "[REDACTED]";

/** Fields of a JSON secret shorter than this are left alone: masking "id" or "us" would shred output. */
const MIN_FIELD = 6;

/**
 * Every string that would reveal the secret: the whole value, and for a JSON secret each string
 * field and the url's host, since a script prints those apart from the rest.
 */
export function secretNeedles(secret: string): string[] {
  const parts = new Set<string>([secret]);
  try {
    collect(JSON.parse(secret), parts);
  } catch {
    // Not JSON: the whole value is the only part.
  }
  const needles = new Set<string>();
  for (const part of parts) for (const form of encodings(part)) if (form !== "") needles.add(form);
  return [...needles].toSorted((a, b) => b.length - a.length);
}

function collect(value: unknown, parts: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= MIN_FIELD) parts.add(value);
    try {
      const host = new URL(value).hostname;
      if (host.length >= MIN_FIELD) parts.add(host);
    } catch {
      // Not a URL.
    }
  } else if (Array.isArray(value)) for (const v of value) collect(v, parts);
  else if (typeof value === "object" && value !== null)
    for (const v of Object.values(value)) collect(v, parts);
}

function encodings(part: string): string[] {
  const base64 = Buffer.from(part).toString("base64");
  return [
    part,
    encodeURIComponent(part),
    JSON.stringify(part).slice(1, -1),
    base64,
    base64.replace(/=+$/, ""),
    Buffer.from(part).toString("base64url"),
  ];
}

/** Longest needle first, so a shorter one never breaks the match of a longer one that contains it. */
export function redact(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) out = out.replaceAll(needle, REDACTED);
  return out;
}
