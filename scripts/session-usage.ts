// Sums the token usage and wall time of Claude Code transcripts, for M2 step 8: one request that
// is not in the library, from writing the script to running it after approval.
//
//   bun scripts/session-usage.ts [--from <ISO time>] [--to <ISO time>] <transcript.jsonl>...
//
// A `tars claude` session keeps its transcripts under
// <data dir>/harness/claude-config/projects/<project>/; subagents write their own files, so pass
// those too. Prints one JSON object on stdout.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface Usage {
  readonly files: number;
  readonly messages: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly first: string | null;
  readonly last: string | null;
  readonly seconds: number;
}

const FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

export function sumUsage(texts: readonly string[], from?: Date, to?: Date): Usage {
  const totals = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<
    (typeof FIELDS)[number],
    number
  >;
  // One assistant message with several content blocks is written as several lines that repeat
  // the same message id and usage; counting each line would multiply it.
  const seen = new Set<string>();
  let first: number | undefined;
  let last: number | undefined;
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      const { timestamp, message, type } = entry as Record<string, unknown>;
      const time = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
      if (Number.isNaN(time)) continue;
      if ((from && time < from.getTime()) || (to && time > to.getTime())) continue;
      first = first === undefined ? time : Math.min(first, time);
      last = last === undefined ? time : Math.max(last, time);
      if (type !== "assistant" || typeof message !== "object" || message === null) continue;
      const { id, usage } = message as Record<string, unknown>;
      if (typeof id !== "string" || seen.has(id)) continue;
      if (typeof usage !== "object" || usage === null) continue;
      seen.add(id);
      for (const field of FIELDS) {
        const value = (usage as Record<string, unknown>)[field];
        if (typeof value === "number" && Number.isFinite(value)) totals[field] += value;
      }
    }
  }
  return {
    files: texts.length,
    messages: seen.size,
    ...totals,
    first: first === undefined ? null : new Date(first).toISOString(),
    last: last === undefined ? null : new Date(last).toISOString(),
    seconds: first === undefined || last === undefined ? 0 : Math.round((last - first) / 1000),
  };
}

function time(value: string | undefined, flag: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    console.error(`error: ${flag} is not a time: ${value}`);
    process.exit(2);
  }
  return date;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { from: { type: "string" }, to: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    console.error(
      "usage: bun scripts/session-usage.ts [--from <ISO time>] [--to <ISO time>] <transcript.jsonl>...",
    );
    process.exit(2);
  }
  const texts = positionals.map((path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      console.error(`error: cannot read ${path}`);
      process.exit(1);
    }
  });
  console.log(
    JSON.stringify(sumUsage(texts, time(values.from, "--from"), time(values.to, "--to"))),
  );
}
