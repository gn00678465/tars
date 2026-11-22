import { z } from "zod";
import { id } from "./envelope.ts";
import {
  WIKI_ALIAS,
  WIKI_ALIASES,
  WIKI_CHANGELOG,
  WIKI_CHANGELOG_TEXT,
  WIKI_CONV_TITLE,
  WIKI_ENTRIES,
  WIKI_ENTRY,
  WIKI_ENTRY_SOURCES,
  WIKI_ERROR,
  WIKI_PAGES,
  WIKI_QUERY,
  WIKI_QUOTE,
  WIKI_QUOTES,
  WIKI_RELATED,
  WIKI_RESULTS,
  WIKI_SNIPPET,
  WIKI_SUMMARY,
  WIKI_TITLE,
  WIKI_TURN_TEXT_BYTES,
} from "./limits.ts";

// The knowledge base, read only. Every browser message here carries what to read and nothing to
// write; the page shows every string as text (T16: what sync took from a conversation is data).

export const WIKI_CATEGORIES = [
  "people",
  "projects",
  "topics",
  "life",
  "learning",
  "investment",
] as const;
export type WikiCategory = (typeof WIKI_CATEGORIES)[number];

/** `<category>/<slug>`, the slug as the local end's wiki/page.ts SLUG allows. */
export const WIKI_PATH = new RegExp(`^(?:${WIKI_CATEGORIES.join("|")})/[a-z0-9][a-z0-9-]{0,63}$`);
/** `<conv8>/<turn8>`, as a page's [[source:…]] writes it. */
export const WIKI_SOURCE_REF = /^[0-9a-f]{8}\/[0-9a-f]{8}$/;
/** A source link inside a page's summary text. */
export const WIKI_SOURCE_LINK = /\[\[source:([0-9a-f]{8}\/[0-9a-f]{8})\]\]/g;

const path = z.string().regex(WIKI_PATH);
const ref = z.string().regex(WIKI_SOURCE_REF);
const day = z.string().max(10);
const chars = (s: string) => [...s].length;
/**
 * At most n characters, as the page rules count them (code points), not UTF-16 units: a title
 * of 80 emoji is a valid page. The byte tests count every character at four bytes.
 */
const text = (n: number) =>
  z
    .string()
    .max(n * 2)
    .refine((s) => chars(s) <= n, `at most ${n} characters`);

/** What `tars wiki search` takes as a query: 1 to 100 characters, not blank. */
export const wikiQuery = text(WIKI_QUERY).refine((s) => s.trim() !== "", "not blank");

export const wikiSearchRequest = z.strictObject({
  query: wikiQuery,
  limit: z.number().int().min(1).max(WIKI_RESULTS).optional(),
});

/** `page`: also the quotes that page took from this turn when sync wrote it. */
export const wikiSourceRequest = z.strictObject({ ref, page: path.optional() });

export const wikiStatus = z.strictObject({
  /** wiki.db exists: tars wiki sync ran at least once. */
  synced: z.boolean(),
  counts: z.strictObject(
    Object.fromEntries(WIKI_CATEGORIES.map((c) => [c, z.number().int().min(0)])) as Record<
      WikiCategory,
      z.ZodNumber
    >,
  ),
  total: z.number().int().min(0),
  /** When the last sync that finished (done, or stopped at a cap) ended. */
  lastSyncAt: z.number().optional(),
  /** How far both search indexes reach. */
  indexedAt: z.number().optional(),
});

export const wikiList = z.strictObject({
  pages: z
    .array(
      z.strictObject({
        path,
        title: text(WIKI_TITLE),
        updated: day,
        /** The file breaks the page rules: wiki.page says why. */
        blocked: z.boolean(),
      }),
    )
    .max(WIKI_PAGES),
  /** More pages than WIKI_PAGES. */
  more: z.boolean(),
});

export const wikiEntry = z.strictObject({
  id: z.string().regex(/^i\d{1,9}$/),
  text: text(WIKI_ENTRY),
  /** Every source is the assistant's words, not the owner's. */
  assistant: z.boolean(),
  /** Each source is a turn sync took this page's text from and checked against its quote. */
  verified: z.boolean(),
  sources: z.array(ref).max(WIKI_ENTRY_SOURCES),
});

export const wikiPage = z.discriminatedUnion("state", [
  /** No such file, or one this side will not follow (a symlink). */
  z.strictObject({ state: z.literal("missing"), path }),
  z.strictObject({ state: z.literal("blocked"), path, error: text(WIKI_ERROR) }),
  z.strictObject({
    state: z.literal("ok"),
    path,
    title: text(WIKI_TITLE),
    aliases: z.array(text(WIKI_ALIAS)).max(WIKI_ALIASES),
    created: day,
    updated: day,
    /** As written, its [[source:…]] links included (WIKI_SOURCE_LINK). */
    summary: text(WIKI_SUMMARY),
    facts: z.array(wikiEntry).max(WIKI_ENTRIES),
    open: z.array(wikiEntry).max(WIKI_ENTRIES),
    related: z.array(path).max(WIKI_RELATED),
    /** Newest first. date is empty for a line the owner wrote without one. */
    changeLog: z
      .array(z.strictObject({ date: day, text: text(WIKI_CHANGELOG_TEXT) }))
      .max(WIKI_CHANGELOG),
    /** Something above was cut to fit. */
    truncated: z.boolean(),
  }),
]);

const indexed = { indexedAt: z.number().optional() };

export const wikiSearch = z.strictObject({
  query: wikiQuery,
  pages: z.strictObject({
    ...indexed,
    results: z
      .array(
        z.strictObject({
          path,
          title: text(WIKI_TITLE),
          updated: day,
          section: z.enum(["meta", "summary", "facts", "open"]),
          item: z
            .string()
            .regex(/^i\d{1,9}$/)
            .optional(),
          snippet: text(WIKI_SNIPPET),
        }),
      )
      .max(WIKI_RESULTS),
  }),
  records: z.strictObject({
    ...indexed,
    results: z
      .array(
        z.strictObject({
          /** Absent once the conversation is deleted, with convTitle and turnNo. */
          conv: id.optional(),
          convTitle: text(WIKI_CONV_TITLE).optional(),
          /** The turn's place in its conversation, from 1. */
          turnNo: z.number().int().positive().optional(),
          at: z.number(),
          speaker: z.enum(["owner", "assistant"]),
          snippet: text(WIKI_SNIPPET),
        }),
      )
      .max(WIKI_RESULTS),
  }),
});

export const wikiSource = z.discriminatedUnion("found", [
  /** The conversation or the turn is gone, or the short ids name more than one. */
  z.strictObject({ ref, found: z.literal(false) }),
  z.strictObject({
    ref,
    found: z.literal(true),
    conv: id,
    convTitle: text(WIKI_CONV_TITLE),
    turnNo: z.number().int().positive(),
    at: z.number(),
    /** Tool calls and results stay out, as sync never reads results (T5). */
    owner: z.string().max(WIKI_TURN_TEXT_BYTES),
    assistant: z.string().max(WIKI_TURN_TEXT_BYTES),
    quotes: z.array(text(WIKI_QUOTE)).max(WIKI_QUOTES),
  }),
]);

export type WikiStatus = z.infer<typeof wikiStatus>;
export type WikiList = z.infer<typeof wikiList>;
export type WikiEntry = z.infer<typeof wikiEntry>;
export type WikiPage = z.infer<typeof wikiPage>;
export type WikiSearch = z.infer<typeof wikiSearch>;
export type WikiSource = z.infer<typeof wikiSource>;
