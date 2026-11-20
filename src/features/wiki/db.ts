import type { Database } from "bun:sqlite";
import type { TarsPaths } from "../../core/paths.ts";
import type { Provider } from "../../core/secrets.ts";
import { utcDay } from "../agent/catalog.ts";
import type { ProviderConfig } from "../agent/config.ts";
import { openSqlite, type LockSpec } from "../agent/db.ts";
import { latestAdjustment } from "../agent/ledger.ts";

/**
 * wiki.db: sync's progress, its own usage, and both search indexes. `turns` and `usage` keep
 * agent.db's names and columns so ledger.ts runs on this database unchanged; here a "turn" is a
 * sync job (one extract batch, or one page's consolidate batch) and conv_id is the run.
 */
export const WIKI_MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  stop_reason TEXT,
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  effort TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  conv_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  reserved_usd REAL NOT NULL,
  max_tokens INTEGER NOT NULL,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  cost_source TEXT NOT NULL,
  price TEXT NOT NULL,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  UNIQUE (turn_id, step, attempt)
);
CREATE INDEX usage_provider_month ON usage (provider, month);
CREATE INDEX usage_provider_day ON usage (provider, day);

CREATE TABLE sources (
  turn_id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  turn_rowid INTEGER NOT NULL UNIQUE,
  day TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  clipped INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sources_state ON sources (state, turn_rowid);

CREATE TABLE waiting_turns (turn_rowid INTEGER PRIMARY KEY);

CREATE TABLE candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_turn_id TEXT NOT NULL REFERENCES sources(turn_id),
  page TEXT NOT NULL,
  title TEXT NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT NOT NULL,
  quote TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX candidates_page ON candidates (state, page);

CREATE TABLE pages (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  aliases TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  hash TEXT NOT NULL,
  next_item INTEGER NOT NULL,
  state TEXT NOT NULL,
  last_error TEXT,
  external_change INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE page_docs (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  section TEXT NOT NULL,
  item TEXT,
  text TEXT NOT NULL
);
CREATE INDEX page_docs_path ON page_docs (path);
CREATE VIRTUAL TABLE page_fts USING fts5(
  meta_tokens, body_tokens, content='', contentless_delete=1, tokenize='unicode61'
);

CREATE TABLE raw_docs (
  id INTEGER PRIMARY KEY,
  conv_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (conv_id, seq)
);
CREATE INDEX raw_docs_at ON raw_docs (at);
CREATE VIRTUAL TABLE raw_fts USING fts5(
  tokens, content='', contentless_delete=1, tokenize='unicode61'
);
`,
];

/** Only tars wiki sync opens it for writing; everything else reads it and never migrates. */
export function openWikiDb(
  paths: TarsPaths,
  opts: { readonly: true },
): Database | undefined | "newer";
export function openWikiDb(paths: TarsPaths, opts?: { readonly?: false }): Promise<Database>;
export function openWikiDb(
  paths: TarsPaths,
  opts: { readonly?: boolean } = {},
): Database | undefined | "newer" | Promise<Database> {
  return opts.readonly
    ? openSqlite(paths.wikiDb, WIKI_MIGRATIONS, { readonly: true })
    : openSqlite(paths.wikiDb, WIKI_MIGRATIONS);
}

export const NEWER_WIKI_DB = "這個 wiki.db 由較新的 tars 建立，請更新 tars";

/** Its own lock: sync and chat never wait for each other. */
export const wikiLockSpec = (paths: TarsPaths): LockSpec => ({
  file: paths.wikiLock,
  infoFile: paths.wikiLockInfo,
  busy: "另一個 tars wiki sync 正在執行",
  command: "wiki sync",
});

export interface WikiSpend {
  /** Counted against the provider's caps: what the last cost adjust does not cover yet. */
  readonly period: number;
  readonly today: number;
  /** Sync's own caps: plain sums, adjustments aside. */
  readonly rawToday: number;
  readonly rawMonth: number;
}

const NONE: WikiSpend = { period: 0, today: 0, rawToday: 0, rawMonth: 0 };

/**
 * Sync's spend, read fresh each time in one read transaction. An adjustment is the provider's
 * bill up to its time, sync's requests included, so only later rows (or rows still reserved,
 * not on the bill yet) count on top of it: by time, since the two databases share no row ids.
 * Never throws: undefined means wiki.db could not be read, and the caller refuses to send.
 */
export function wikiSpend(
  paths: TarsPaths,
  agentDb: Database | undefined,
  provider: Provider,
  cfg: ProviderConfig,
  now: Date,
): WikiSpend | undefined {
  let db: Database | undefined | "newer";
  try {
    db = openWikiDb(paths, { readonly: true });
  } catch {
    return undefined;
  }
  if (db === "newer") return undefined;
  if (db === undefined) return NONE;
  const wiki = db;
  try {
    const adj = agentDb === undefined ? null : latestAdjustment(agentDb, provider, cfg, now);
    const day = utcDay(now);
    const month = day.slice(0, 7);
    const sum = (where: string, ...params: (string | number)[]) =>
      (
        wiki
          .query(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE ${where}`)
          .get(...params) as { s: number }
      ).s;
    return wiki
      .transaction(() => {
        const monthly = cfg.period === "utc-month";
        const scope = monthly ? "provider = ? AND month = ?" : "provider = ?";
        const scoped = monthly ? [provider, month] : [provider];
        return {
          period:
            adj === null
              ? sum(scope, ...scoped)
              : sum(`${scope} AND (at > ? OR state = 'reserved')`, ...scoped, adj.at),
          today: sum("provider = ? AND day = ?", provider, day),
          rawToday: sum("day = ?", day),
          rawMonth: sum("month = ?", month),
        };
      })
      .deferred();
  } catch {
    return undefined;
  } finally {
    wiki.close();
  }
}
