const encoder = new TextEncoder();

export const utf8Bytes = (text: string) => encoder.encode(text).length;

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8, never splitting a character. */
export function cutUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // A continuation byte is 10xxxxxx; back up to the start of its character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Tokens from UTF-8 bytes: a Traditional Chinese character is 3 bytes and about 1.5 to 2.5
 * tokens, an English token about 4 bytes, so halving is close for Chinese and high for English.
 */
export const estimateTokens = (bytes: number) => Math.ceil(bytes / 2);

/** A tool result as sent to the model: at most `limit` bytes, with a note when cut. */
export function clipToolResult(text: string, limit: number): { text: string; truncated: boolean } {
  const total = utf8Bytes(text);
  if (total <= limit) return { text, truncated: false };
  const note = `\n（已截斷，完整輸出共 ${total} 位元組）`;
  return { text: cutUtf8(text, limit - utf8Bytes(note)) + note, truncated: true };
}

/** The longest suffix of `text` that fits in `maxBytes` of UTF-8, never splitting a character. */
export function tailUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - Math.max(0, maxBytes);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}
