const encoder = new TextEncoder();

/** UTF-8 bytes of a string, without encoding it when its length alone decides. */
export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/** Is s at most max UTF-8 bytes? A UTF-16 unit is 1 to 3 bytes, so most cases need no encoding. */
export function withinBytes(s: string, max: number): boolean {
  if (s.length > max) return false;
  if (s.length * 3 <= max) return true;
  return utf8Bytes(s) <= max;
}
