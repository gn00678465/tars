export const REDACTED = "[REDACTED]";

const MIN_MASKED_FIELD_LENGTH = 6;

export function secretNeedles(secret: string): string[] {
  const parts = new Set<string>([secret]);
  try {
    collect(JSON.parse(secret), parts);
  } catch {}
  const needles = new Set<string>();
  for (const part of parts) for (const form of encodings(part)) if (form !== "") needles.add(form);
  return [...needles];
}

function collect(value: unknown, parts: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= MIN_MASKED_FIELD_LENGTH) parts.add(value);
    try {
      const host = new URL(value).hostname;
      if (host.length >= MIN_MASKED_FIELD_LENGTH) parts.add(host);
    } catch {}
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

export function redact(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles.toSorted((a, b) => b.length - a.length))
    out = out.replaceAll(needle, REDACTED);
  return out;
}
