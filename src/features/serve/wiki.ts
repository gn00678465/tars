import type { Database } from "bun:sqlite";
import {
  MESSAGE_BYTES,
  utf8Bytes,
  WIKI_CHANGELOG,
  WIKI_CHANGELOG_TEXT,
  WIKI_CONV_TITLE,
  WIKI_ENTRIES,
  WIKI_ENTRY_SOURCES,
  WIKI_ERROR,
  WIKI_EXAMPLES,
  WIKI_PAGES,
  WIKI_QUOTE,
  WIKI_QUOTES,
  WIKI_SNIPPET,
  WIKI_TITLE,
  WIKI_TURN_TEXT_BYTES,
  type ClientMessage,
  type WikiEntry,
  type WikiList,
  type WikiPage,
  type WikiSearch,
  type WikiSource,
  type WikiStatus,
} from "@tars/protocol";
import { TarsError } from "../../core/exit.ts";
import type { TarsPaths } from "../../core/paths.ts";
import { clipMiddle } from "../agent/compaction.ts";
import { openDb } from "../agent/db.ts";
import { openWikiDb } from "../wiki/db.ts";
import { readTurnParts, resolveSource, sourceRef } from "../wiki/evidence.ts";
import { parsePage, type Category, type Entry } from "../wiki/page.ts";
import { byUpdated } from "../wiki/index-file.ts";
import { categoryCounts, listPages } from "../wiki/read.ts";
import { scannedAt, searchWiki } from "../wiki/search.ts";
import { readIn, withWikiDir } from "../wiki/wiki-dir.ts";

// The remote page's knowledge base, read only (G4). Both databases are opened read-only, so
// SQLite refuses any write; files are reached only through readIn, which opens O_RDONLY and
// never follows a symlink, so a link planted in <data>/wiki cannot send another file out.
// test/features/serve/wiki.test.ts holds this file to those imports.

export type WikiRequest = Extract<
  ClientMessage,
  { kind: "wiki.status" | "wiki.list" | "wiki.page" | "wiki.search" | "wiki.source" }
>;

export type WikiAnswer =
  | { readonly kind: "wiki.status.result"; readonly p: WikiStatus }
  | { readonly kind: "wiki.list.result"; readonly p: WikiList }
  | { readonly kind: "wiki.page.result"; readonly p: WikiPage }
  | { readonly kind: "wiki.search.result"; readonly p: WikiSearch }
  | { readonly kind: "wiki.source.result"; readonly p: WikiSource };

/** The answer, or "newer" when wiki.db or agent.db was made by a newer tars. */
export async function answerWiki(paths: TarsPaths, m: WikiRequest): Promise<WikiAnswer | "newer"> {
  const wiki = openWikiDb(paths, { readonly: true });
  if (wiki === "newer") return "newer";
  try {
    return await answer(paths, wiki, m);
  } finally {
    wiki?.close();
  }
}

async function answer(
  paths: TarsPaths,
  wiki: Database | undefined,
  m: WikiRequest,
): Promise<WikiAnswer | "newer"> {
  switch (m.kind) {
    case "wiki.status":
      return { kind: "wiki.status.result", p: status(wiki) };
    case "wiki.list":
      return { kind: "wiki.list.result", p: list(wiki) };
    case "wiki.page":
      return { kind: "wiki.page.result", p: await page(paths, wiki, m.p.path) };
    case "wiki.search":
      return withAgent(paths, (agent) => ({
        kind: "wiki.search.result",
        p: search(wiki, agent, m.p.query, m.p.limit ?? DEFAULT_RESULTS),
      }));
    case "wiki.source":
      return withAgent(paths, (agent) => ({
        kind: "wiki.source.result",
        p: source(wiki, agent, m.p.ref, m.p.page),
      }));
  }
}

const DEFAULT_RESULTS = 20;

function withAgent<T>(paths: TarsPaths, use: (agent: Database | undefined) => T): T | "newer" {
  let agent: Database | undefined;
  try {
    agent = openDb(paths, { readonly: true });
  } catch (err) {
    if (err instanceof TarsError) return "newer";
    throw err;
  }
  try {
    return use(agent);
  } finally {
    agent?.close();
  }
}

/** At most n characters, never half of one. */
const cut = (s: string, n: number) => {
  const c = [...s];
  return c.length <= n ? s : c.slice(0, n).join("");
};

function status(wiki: Database | undefined): WikiStatus {
  const counts = categoryCounts(wiki);
  const examples = listPages(wiki)
    .toSorted(byUpdated)
    .flatMap((p) => p.aliases.slice(0, 1))
    .slice(0, WIKI_EXAMPLES);
  const last = wiki
    ?.query(
      "SELECT ended_at AS at FROM runs WHERE state IN ('completed', 'stopped') AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1",
    )
    .get() as { at: number } | null | undefined;
  const indexedAt = scannedAt(wiki);
  return {
    synced: wiki !== undefined,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    examples,
    ...(last === null || last === undefined ? {} : { lastSyncAt: last.at }),
    ...(indexedAt === null ? {} : { indexedAt }),
  };
}

function list(wiki: Database | undefined): WikiList {
  const pages = listPages(wiki);
  return {
    pages: pages.slice(0, WIKI_PAGES).map((p) => ({
      path: p.path,
      title: cut(p.title, WIKI_TITLE),
      updated: p.updated.slice(0, 10),
      blocked: p.state === "blocked",
    })),
    more: pages.length > WIKI_PAGES,
  };
}

/** The `<conv8>/<turn8>` of every turn sync applied to this page after checking its quote. */
function verifiedSources(wiki: Database | undefined, path: string): Set<string> {
  const rows = (wiki
    ?.query(
      `SELECT DISTINCT s.conv_id AS conv, c.source_turn_id AS turn FROM candidates c
       JOIN sources s ON s.turn_id = c.source_turn_id WHERE c.page = ? AND c.state = 'applied'`,
    )
    .all(path) ?? []) as { conv: string; turn: string }[];
  return new Set(rows.map((r) => sourceRef(r.conv, r.turn)));
}

const CHANGE_LINE = /^(\d{4}-\d{2}-\d{2})\s+([\s\S]*)$/;
/** What the envelope around p takes at most: v, an id, the kind, re. */
const ENVELOPE_BYTES = 512;

async function page(paths: TarsPaths, wiki: Database | undefined, path: string): Promise<WikiPage> {
  const slash = path.indexOf("/");
  const category = path.slice(0, slash) as Category;
  const name = `${path.slice(slash + 1)}.md`;
  let markdown: string | undefined;
  try {
    const r = await withWikiDir(paths, category, false, (dir) => readIn(dir, name));
    markdown = "value" in r ? r.value : undefined;
  } catch (err) {
    // ELOOP: the file is a symlink; EISDIR: a directory under a page's name.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ELOOP" && code !== "EISDIR") throw err;
  }
  if (markdown === undefined) return { state: "missing", path };
  const row = wiki?.query("SELECT next_item FROM pages WHERE path = ?").get(path) as
    | { next_item: number }
    | null
    | undefined;
  const parsed = parsePage(markdown, path, row?.next_item ?? 1);
  if (!parsed.ok) return { state: "blocked", path, error: cut(parsed.error, WIKI_ERROR) };
  const p = parsed.page;
  const verified = verifiedSources(wiki, path);
  let truncated = false;
  const entries = (list: readonly Entry[]): WikiEntry[] => {
    if (list.length > WIKI_ENTRIES) truncated = true;
    return list.slice(0, WIKI_ENTRIES).map((e) => {
      if (e.sources.length > WIKI_ENTRY_SOURCES) truncated = true;
      return {
        id: `i${e.id}`,
        text: e.text,
        assistant: e.assistant,
        verified: !e.temp && e.sources.length > 0 && e.sources.every((s) => verified.has(s)),
        sources: e.sources.slice(0, WIKI_ENTRY_SOURCES),
      };
    });
  };
  if (p.changeLog.length > WIKI_CHANGELOG) truncated = true;
  const changeLog = p.changeLog.slice(0, WIKI_CHANGELOG).map((line) => {
    const m = CHANGE_LINE.exec(line);
    const text = m === null ? line : (m[2] as string);
    if ([...text].length > WIKI_CHANGELOG_TEXT) truncated = true;
    return { date: m === null ? "" : (m[1] as string), text: cut(text, WIKI_CHANGELOG_TEXT) };
  });
  const out = {
    state: "ok" as const,
    path,
    title: p.title,
    aliases: [...p.aliases],
    created: p.created,
    updated: p.updated,
    summary: p.summary,
    facts: entries(p.facts),
    open: entries(p.open),
    related: [...p.related],
    changeLog,
    truncated,
  };
  // Escaped control characters can still make a page that is within every count too big: the
  // oldest Change Log lines go first, then the last entries.
  const fits = () => utf8Bytes(JSON.stringify(out)) + ENVELOPE_BYTES <= MESSAGE_BYTES;
  for (const part of [out.changeLog, out.open, out.facts])
    while (!fits() && part.length > 0) {
      part.pop();
      out.truncated = true;
    }
  return out;
}

/** The turn's place among its conversation's chat turns, from 1. */
function turnNo(agent: Database, convId: string, turnId: string): number | undefined {
  const row = agent
    .query(
      `SELECT COUNT(*) AS n FROM turns WHERE conv_id = ?1 AND kind = 'chat'
       AND rowid <= (SELECT rowid FROM turns WHERE id = ?2)`,
    )
    .get(convId, turnId) as { n: number };
  return row.n > 0 ? row.n : undefined;
}

const titleOf = (agent: Database | undefined, convId: string) =>
  (
    agent?.query("SELECT title FROM conversations WHERE id = ?").get(convId) as
      | { title: string }
      | null
      | undefined
  )?.title;

function search(
  wiki: Database | undefined,
  agent: Database | undefined,
  query: string,
  limit: number,
): WikiSearch {
  // No synonyms here: the remote search reads the index as typed, as /wiki does in tars chat.
  const r = searchWiki({ wiki, agent }, { query, also: [], limit });
  const indexed = (at: number | null) => (at === null ? {} : { indexedAt: at });
  return {
    query,
    pages: {
      ...indexed(r.pages.indexedAt),
      results: r.pages.results.map((p) => ({
        path: p.path,
        title: cut(p.title, WIKI_TITLE),
        updated: p.updated.slice(0, 10),
        section: p.section,
        ...(p.item === null ? {} : { item: p.item }),
        snippet: cut(p.snippet, WIKI_SNIPPET),
      })),
    },
    records: {
      ...indexed(r.records.indexedAt),
      results: r.records.results.map((x) => {
        const title = titleOf(agent, x.conv);
        const no =
          title === undefined || agent === undefined ? undefined : turnNo(agent, x.conv, x.turn);
        return {
          ...(title === undefined ? {} : { conv: x.conv, convTitle: cut(title, WIKI_CONV_TITLE) }),
          ...(no === undefined ? {} : { turnNo: no }),
          at: x.at,
          speaker: x.speaker,
          snippet: cut(x.snippet, WIKI_SNIPPET),
        };
      }),
    },
  };
}

/** Room for clipMiddle's omission mark, so a clipped side stays within the limit. */
const MARK_BYTES = 64;

function source(
  wiki: Database | undefined,
  agent: Database | undefined,
  ref: string,
  page: string | undefined,
): WikiSource {
  const turn = agent === undefined ? undefined : resolveSource(agent, ref);
  const title = turn === undefined ? undefined : titleOf(agent, turn.convId);
  const no =
    turn === undefined || agent === undefined ? undefined : turnNo(agent, turn.convId, turn.id);
  if (agent === undefined || turn === undefined || title === undefined || no === undefined)
    return { ref, found: false };
  const parts = readTurnParts(agent, turn);
  const quotes =
    page === undefined || wiki === undefined
      ? []
      : (
          wiki
            .query(
              `SELECT quote FROM candidates WHERE source_turn_id = ? AND page = ?
               AND state = 'applied' GROUP BY quote ORDER BY MIN(id) LIMIT ${WIKI_QUOTES}`,
            )
            .all(turn.id, page) as { quote: string }[]
        ).map((q) => cut(q.quote, WIKI_QUOTE));
  const side = (s: string) => clipMiddle(s, WIKI_TURN_TEXT_BYTES - MARK_BYTES);
  return {
    ref,
    found: true,
    conv: turn.convId,
    convTitle: cut(title, WIKI_CONV_TITLE),
    turnNo: no,
    at: turn.startedAt,
    owner: side(parts.owner),
    assistant: side(parts.assistant.join("\n")),
    quotes,
  };
}
