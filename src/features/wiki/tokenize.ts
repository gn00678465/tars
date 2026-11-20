/**
 * ー (U+30FC) and 々 (U+3005) are not in these four scripts' properties, so they are listed on
 * their own; without them コーヒー and 人々 would be cut apart.
 */
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々`;
const SEGMENT = new RegExp(`([${CJK}]+)|((?:(?![${CJK}])[\\p{L}\\p{N}])+)`, "gu");

type Segment = { readonly cjk: boolean; readonly text: string };

function segments(text: string): Segment[] {
  return [...text.normalize("NFKC").matchAll(SEGMENT)].map((m) =>
    m[1] === undefined
      ? { cjk: false, text: (m[2] as string).toLowerCase() }
      : { cjk: true, text: m[1] },
  );
}

/** Each pair of neighbours, then the last character alone, so every character starts a token. */
function cjkTokens(run: string): string[] {
  const c = [...run];
  if (c.length === 1) return c;
  return [...c.slice(0, -1).map((ch, i) => ch + (c[i + 1] as string)), c.at(-1) as string];
}

/** The text as FTS5 unicode61 tokens; the index and the query cut the same way. */
export function tokenize(text: string): string {
  return segments(text)
    .flatMap((s) => (s.cjk ? cjkTokens(s.text) : [s.text]))
    .join(" ");
}

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

/**
 * A MATCH expression for what was typed: every part quoted, joined by AND, so OR, *, : and
 * brackets in it are only text. undefined when nothing in it can be searched.
 */
export function matchQuery(text: string): string | undefined {
  const parts = segments(text).map((s) => {
    if (!s.cjk) return quote(s.text);
    const c = [...s.text];
    // One character starts a token wherever it appears, so its prefix finds every place.
    if (c.length === 1) return `${quote(s.text)} *`;
    return quote(cjkTokens(s.text).slice(0, -1).join(" "));
  });
  return parts.length === 0 ? undefined : parts.join(" AND ");
}

/** The query's parts as plain text, NFKC and lowercased, for finding a snippet's place. */
export const querySegments = (text: string): string[] => segments(text).map((s) => s.text);
