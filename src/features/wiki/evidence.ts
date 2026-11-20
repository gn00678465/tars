import type { Database } from "bun:sqlite";
import { cutUtf8, utf8Bytes } from "../agent/bytes.ts";
import { utcDay } from "../agent/catalog.ts";
import { clipMiddle, escTags } from "../agent/compaction.ts";
import { shortId } from "../agent/store.ts";
import { argvText } from "../agent/tty-frontend.ts";
import type { Item } from "../agent/types.ts";
import { isRecord } from "../script/metadata.ts";

/** Every tag a sync prompt uses: text inside one can neither close it nor open another. */
export const WIKI_TAGS = [
  "turn",
  "owner",
  "assistant",
  "tools",
  "wiki-pages",
  "page",
  "title",
  "aliases",
  "summary",
  "facts",
  "open",
  "related",
  "candidates",
] as const;
export const escWiki = escTags(WIKI_TAGS);

const SPEAKER_BYTES = 4000;
const TOOLS_BYTES = 2000;

export interface TurnRef {
  readonly id: string;
  readonly convId: string;
  readonly startedAt: number;
}

/** One source turn as sync reads it; tool results stay out (T5). */
export interface TurnEvidence {
  /** `<conv8>/<turn8>` */
  readonly source: string;
  readonly turnId: string;
  readonly date: string;
  readonly owner: string;
  /** The turn's assistant texts, empty ones left out, joined by "\n". */
  readonly assistant: string;
  readonly tools: string;
}

export const sourceRef = (convId: string, turnId: string) =>
  `${shortId(convId)}/${shortId(turnId)}`;

/** A turn's own words and its tool calls; tool results stay out (T5). */
export interface TurnParts {
  readonly owner: string;
  /** Its non-empty assistant texts, in order. */
  readonly assistant: readonly string[];
  readonly tools: readonly {
    readonly name: string;
    readonly argv: readonly string[] | null;
    readonly status: string;
  }[];
}

export function readTurnParts(db: Database, turn: Pick<TurnRef, "id" | "convId">): TurnParts {
  const items = (
    db
      .query("SELECT kind, body FROM items WHERE conv_id = ? AND turn_id = ? ORDER BY seq")
      .all(turn.convId, turn.id) as { kind: Item["kind"]; body: string }[]
  ).map((r) => ({ kind: r.kind, body: JSON.parse(r.body) as Record<string, unknown> }));
  const textOf = (kind: string) =>
    items
      .filter((i) => i.kind === kind && typeof i.body.text === "string" && i.body.text !== "")
      .map((i) => i.body.text as string);
  const status = new Map(
    items
      .filter((i) => i.kind === "tool_result")
      .map((i) => [i.body.callId as string, i.body.status as string]),
  );
  return {
    owner: textOf("user")[0] ?? "",
    assistant: textOf("assistant"),
    tools: items
      .filter((i) => i.kind === "tool_call")
      .map((i) => {
        const argv = isRecord(i.body.input) ? i.body.input.argv : undefined;
        return {
          name: String(i.body.name),
          argv:
            i.body.name === "tars" &&
            Array.isArray(argv) &&
            argv.every((a) => typeof a === "string")
              ? (argv as string[])
              : null,
          status: status.get(i.body.callId as string) ?? "沒有結果",
        };
      }),
  };
}

export const toolLine = (t: TurnParts["tools"][number]) =>
  `${t.argv === null ? t.name : `tars ${argvText(t.argv)}`}（${t.status}）`;

export function readTurnEvidence(db: Database, turn: TurnRef): TurnEvidence {
  const parts = readTurnParts(db, turn);
  let tools = parts.tools.map(toolLine).join("\n");
  if (utf8Bytes(tools) > TOOLS_BYTES) tools = `${cutUtf8(tools, TOOLS_BYTES - 3)}…`;
  return {
    source: sourceRef(turn.convId, turn.id),
    turnId: turn.id,
    date: utcDay(new Date(turn.startedAt)),
    owner: parts.owner,
    assistant: parts.assistant.join("\n"),
    tools,
  };
}

/** The turn for the model; `clipped` when a side was over 4000 bytes and lost its middle. */
export function renderTurn(e: TurnEvidence): { text: string; clipped: boolean } {
  const owner = clipMiddle(e.owner, SPEAKER_BYTES);
  const assistant = clipMiddle(e.assistant, SPEAKER_BYTES);
  const text = [
    `<turn source="${e.source}" date="${e.date}">`,
    "<owner>",
    escWiki(owner),
    "</owner>",
    "<assistant>",
    escWiki(assistant),
    "</assistant>",
    "<tools>",
    escWiki(e.tools),
    "</tools>",
    "</turn>",
  ].join("\n");
  return { text, clipped: owner !== e.owner || assistant !== e.assistant };
}

/** NFKC, every run of whitespace one space, trimmed: quotes and texts compare in this form. */
export const normalizeForQuote = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/**
 * A quote must be 4 to 200 characters of what that speaker said in that turn, compared with the
 * whole text: clipping only drops the middle, so a quote copied from what the model saw still
 * matches, and one taken across the omission mark does not.
 */
export function quoteMatches(quote: string, original: string): boolean {
  const q = normalizeForQuote(quote);
  const n = [...q].length;
  return n >= 4 && n <= 200 && normalizeForQuote(original).includes(q);
}

/** The turn a `<conv8>/<turn8>` names, when exactly one does. */
export function resolveSource(db: Database, ref: string): TurnRef | undefined {
  const [conv, turn] = ref.split("/");
  if (conv === undefined || turn === undefined) return undefined;
  const rows = db
    .query(
      `SELECT id, conv_id AS convId, started_at AS startedAt FROM turns
       WHERE substr(conv_id, -8) = ? AND substr(id, -8) = ? LIMIT 2`,
    )
    .all(conv, turn) as TurnRef[];
  return rows.length === 1 ? rows[0] : undefined;
}
