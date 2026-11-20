import type { Database } from "bun:sqlite";
import { visible } from "../agent/tty-frontend.ts";
import { sourceRef } from "./evidence.ts";
import { minuteText } from "./page.ts";
import { matchQuery, querySegments } from "./tokenize.ts";

const RRF_K = 60;
const LIST = 50;
const PAGE_ROWS = 200;
/** A result only a date-range list found counts as if it ranked just past the main list. */
const EXTRA_RANK = LIST + 1;
const SNIPPET_CHARS = 120;
const SUMMARY_CHARS = 300;

export interface SearchQuery {
  readonly query: string;
  readonly also: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}

export interface PageResult {
  readonly path: string;
  readonly title: string;
  readonly aliases: string[];
  readonly updated: string;
  readonly score: number;
  readonly section: "meta" | "summary" | "facts" | "open";
  readonly item: string | null;
  readonly snippet: string;
}

export interface RecordResult {
  readonly source: string;
  readonly conv: string;
  readonly turn: string;
  readonly at: number;
  readonly speaker: "owner" | "assistant";
  readonly score: number;
  readonly snippet: string;
}

export interface SearchJson {
  readonly query: string;
  readonly also: readonly string[];
  readonly pages: { readonly indexedAt: number | null; readonly results: PageResult[] };
  readonly records: {
    readonly indexedAt: number | null;
    readonly unindexedTurns: number;
    readonly results: RecordResult[];
  };
}

export interface RankList {
  /** Ranked best first. */
  readonly main: readonly string[];
  /** The date-range list: only adds what main does not have. */
  readonly extra?: readonly string[];
}

/** Reciprocal rank fusion over one list per term; a term that missed adds nothing. */
export function rrf(lists: readonly RankList[]): Map<string, number> {
  const score = new Map<string, number>();
  const add = (id: string, rank: number) =>
    score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank));
  for (const l of lists) {
    const seen = new Set(l.main);
    l.main.forEach((id, i) => add(id, i + 1));
    for (const id of l.extra ?? []) if (!seen.has(id)) add(id, EXTRA_RANK);
  }
  return score;
}

export const normalizeTerm = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** The query and its expansions, normalized, without repeats or blanks. */
export function searchTerms(q: Pick<SearchQuery, "query" | "also">): string[] {
  return [...new Set([q.query, ...q.also].map(normalizeTerm))].filter((t) => t !== "");
}

const oneLine = (s: string) => visible(s).replace(/\n/g, " ");

/** Where any part of the query first appears, 120 characters around it; else the start. */
export function snippet(text: string, terms: readonly string[]): string {
  const norm = [...text.normalize("NFKC").toLowerCase()];
  const flat = norm.join("");
  const at = terms
    .flatMap(querySegments)
    .map((seg) => flat.indexOf(seg))
    .filter((i) => i >= 0)
    .map((i) => Array.from(flat.slice(0, i)).length);
  const pos = at.length === 0 ? 0 : Math.min(...at);
  const start = Math.max(0, Math.min(pos - SNIPPET_CHARS / 2, norm.length - SNIPPET_CHARS));
  return oneLine(norm.slice(start, start + SNIPPET_CHARS).join(""));
}

const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
const DAY_MS = 86_400_000;

interface PageRow {
  id: number;
  path: string;
  section: PageResult["section"];
  item: string | null;
  text: string;
}

interface RawRow {
  id: number;
  conv_id: string;
  turn_id: string;
  seq: number;
  speaker: "owner" | "assistant";
  at: number;
}

export interface SearchDbs {
  readonly wiki: Database | undefined;
  readonly agent: Database | undefined;
}

export const scannedAt = (wiki: Database | undefined) => {
  const row = wiki?.query("SELECT value FROM meta WHERE key = 'scanned_at'").get() as
    | { value: string }
    | null
    | undefined;
  return row === null || row === undefined ? null : Number(row.value);
};

/** Turns agent.db has past the scan cursor, and the ones still waiting to end. */
export function unindexedTurns(wiki: Database | undefined, agent: Database | undefined): number {
  const cursor =
    (
      wiki?.query("SELECT value FROM cursors WHERE name = 'scan'").get() as
        | { value: number }
        | null
        | undefined
    )?.value ?? 0;
  const later =
    agent === undefined
      ? 0
      : (
          agent.query("SELECT COUNT(*) AS n FROM turns WHERE rowid > ?").get(cursor) as {
            n: number;
          }
        ).n;
  const waiting =
    wiki === undefined
      ? 0
      : (wiki.query("SELECT COUNT(*) AS n FROM waiting_turns").get() as { n: number }).n;
  return later + waiting;
}

/** Both tracks, each ranked on its own: the wiki pages and the raw conversation records. */
export function searchWiki(dbs: SearchDbs, q: SearchQuery): SearchJson {
  const terms = searchTerms(q);
  const matches = terms.map(matchQuery).filter((m): m is string => m !== undefined);
  const ranged = q.since !== undefined || q.until !== undefined;
  const from = q.since ?? "0000-01-01";
  const to = q.until ?? "9999-12-31";
  const inDay = (day: string) => day >= from && day <= to;
  const json: SearchJson = {
    query: q.query,
    also: q.also,
    pages: { indexedAt: scannedAt(dbs.wiki), results: [] },
    records: {
      indexedAt: scannedAt(dbs.wiki),
      unindexedTurns: unindexedTurns(dbs.wiki, dbs.agent),
      results: [],
    },
  };
  const wiki = dbs.wiki;
  if (wiki === undefined || matches.length === 0) return json;

  // Pages: the best rows, gathered page by page before the cut, so one page with many hits
  // does not push the others out.
  const pageRows = wiki.query(
    `SELECT d.id, d.path, d.section, d.item, d.text, bm25(page_fts) AS s
     FROM page_fts JOIN page_docs d ON d.id = page_fts.rowid JOIN pages p ON p.path = d.path
     WHERE page_fts MATCH ?1 AND p.updated BETWEEN ?2 AND ?3 ORDER BY s, d.id LIMIT ${PAGE_ROWS}`,
  );
  const firstRow = new Map<string, PageRow>();
  const pageList = (match: string, lo: string, hi: string) => {
    const paths: string[] = [];
    for (const r of pageRows.all(match, lo, hi) as PageRow[]) {
      if (paths.includes(r.path)) continue;
      paths.push(r.path);
      if (!firstRow.has(r.path)) firstRow.set(r.path, r);
      if (paths.length === LIST) break;
    }
    return paths;
  };
  const pageScores = rrf(
    matches.map((m) => ({
      main: pageList(m, "0000-01-01", "9999-12-31"),
      ...(ranged ? { extra: pageList(m, from, to) } : {}),
    })),
  );
  const pageInfo = wiki.query("SELECT title, aliases, updated FROM pages WHERE path = ?");
  const pages = [...pageScores].flatMap(([path, score]) => {
    const info = pageInfo.get(path) as { title: string; aliases: string; updated: string } | null;
    const row = firstRow.get(path);
    if (info === null || row === undefined) return [];
    const text =
      row.section === "summary" ? [...row.text].slice(0, SUMMARY_CHARS).join("") : row.text;
    return [
      {
        path,
        title: oneLine(info.title),
        aliases: (JSON.parse(info.aliases) as string[]).map(oneLine),
        updated: info.updated,
        score: ranged && inDay(info.updated) ? score * 2 : score,
        section: row.section,
        item: row.item,
        snippet: oneLine(text),
      },
    ];
  });
  json.pages.results.push(
    ...pages
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          (a.updated === b.updated ? 0 : a.updated < b.updated ? 1 : -1) ||
          (a.path < b.path ? -1 : 1),
      )
      .slice(0, q.limit),
  );

  // Raw records.
  const rawRows = wiki.query(
    `SELECT d.*, bm25(raw_fts) AS s FROM raw_fts JOIN raw_docs d ON d.id = raw_fts.rowid
     WHERE raw_fts MATCH ?1 AND d.at >= ?2 AND d.at < ?3 ORDER BY s, d.id LIMIT ${LIST}`,
  );
  const rows = new Map<string, RawRow>();
  const rawList = (match: string, lo: number, hi: number) =>
    (rawRows.all(match, lo, hi) as RawRow[]).map((r) => {
      rows.set(String(r.id), r);
      return String(r.id);
    });
  const lo = q.since === undefined ? 0 : dayStart(q.since);
  const hi = q.until === undefined ? Number.MAX_SAFE_INTEGER : dayStart(q.until) + DAY_MS;
  const rawScores = rrf(
    matches.map((m) => ({
      main: rawList(m, 0, Number.MAX_SAFE_INTEGER),
      ...(ranged ? { extra: rawList(m, lo, hi) } : {}),
    })),
  );
  const itemText = dbs.agent?.query("SELECT body FROM items WHERE conv_id = ? AND seq = ?");
  const records = [...rawScores].map(([id, score]): { result: RecordResult; seq: number } => {
    const r = rows.get(id) as RawRow;
    const body = itemText?.get(r.conv_id, r.seq) as { body: string } | null | undefined;
    const text =
      body === null || body === undefined
        ? ""
        : ((JSON.parse(body.body) as { text?: string }).text ?? "");
    return {
      result: {
        source: sourceRef(r.conv_id, r.turn_id),
        conv: r.conv_id,
        turn: r.turn_id,
        at: r.at,
        speaker: r.speaker,
        score: ranged && r.at >= lo && r.at < hi ? score * 2 : score,
        snippet: snippet(text, terms),
      },
      seq: r.seq,
    };
  });
  json.records.results.push(
    ...records
      .toSorted(
        (a, b) =>
          b.result.score - a.result.score ||
          b.result.at - a.result.at ||
          (a.result.conv === b.result.conv
            ? a.seq - b.seq
            : a.result.conv < b.result.conv
              ? -1
              : 1),
      )
      .slice(0, q.limit)
      .map((x) => x.result),
  );
  return json;
}

const SECTION_TEXT: Readonly<Record<PageResult["section"], string>> = {
  meta: "標題",
  summary: "摘要",
  facts: "事實",
  open: "未決",
};

/** The text form; every field from a page or a conversation has been through visible. */
export function formatResults(r: SearchJson): string[] {
  const out = [
    `Wiki 頁面（${r.pages.results.length}）｜${r.pages.indexedAt === null ? "還沒有索引" : `頁面索引到 ${minuteText(r.pages.indexedAt)}`}`,
  ];
  r.pages.results.forEach((p, i) => {
    out.push(`${i + 1}. ${p.path}｜${p.title}｜更新 ${p.updated}`);
    out.push(`   ${SECTION_TEXT[p.section]}${p.item === null ? "" : ` ${p.item}`}：${p.snippet}`);
  });
  out.push(
    "",
    `原始對話紀錄（${r.records.results.length}）｜${
      r.records.indexedAt === null ? "還沒有索引" : `索引到 ${minuteText(r.records.indexedAt)}`
    }，之後有 ${r.records.unindexedTurns} 個回合還沒進索引`,
  );
  r.records.results.forEach((x, i) => {
    out.push(
      `${i + 1}. ${x.source}｜${new Date(x.at).toISOString().slice(0, 10)}｜${x.speaker === "owner" ? "擁有者" : "tars"}`,
    );
    out.push(`   ${x.snippet}`);
  });
  if (r.pages.indexedAt === null) out.push("還沒有索引。在自己的終端執行 tars wiki sync");
  return out;
}
