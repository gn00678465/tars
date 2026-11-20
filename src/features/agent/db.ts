import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { writeFileAtomic } from "../../core/fs.ts";
import type { TarsPaths } from "../../core/paths.ts";

/** Schema migrations in order; index i takes the database from version i to i + 1. */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_total_input_tokens INTEGER NOT NULL DEFAULT 0,
  last_request_at INTEGER,
  last_prefix_key TEXT
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  effort TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE items (
  conv_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  step INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conv_id, seq)
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  conv_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  provider_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL,
  child_pid INTEGER,
  child_start TEXT,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL UNIQUE REFERENCES tool_calls(id),
  conv_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  fields TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_via TEXT
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

CREATE TABLE adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  at INTEGER NOT NULL,
  month TEXT NOT NULL,
  spent_usd REAL NOT NULL,
  note TEXT
);
`,
  // Version 1 counted a request against an adjustment by its time. To keep every total the same
  // when a clock went back, the watermark is every row there is, and the rows version 1 counted
  // as later are listed as not covered.
  `
ALTER TABLE adjustments ADD COLUMN usage_upto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adjustments ADD COLUMN usage_pending TEXT NOT NULL DEFAULT '[]';
UPDATE adjustments SET
  usage_upto = COALESCE((SELECT MAX(id) FROM usage), 0),
  usage_pending = (SELECT json_group_array(id) FROM usage
    WHERE usage.provider = adjustments.provider AND usage.at > adjustments.at);
`,
];

export interface LockInfo {
  readonly pid: number;
  readonly startedAt: number;
  readonly command: string;
}

export interface LockHandle {
  release(): void;
}

export interface LockSpec {
  readonly file: string;
  readonly infoFile: string;
  /** The refusal's opening words, such as 另一個 tars chat 正在執行. */
  readonly busy: string;
  readonly command: string;
}

/**
 * The single-writer lock for tars chat: an exclusive lock on lock.db, held by a connection that
 * stays open. The OS drops it when the process ends, kill -9 included.
 */
export const acquireLock = (paths: TarsPaths, now: Date, command = "chat"): Promise<LockHandle> =>
  acquireLockAt(
    {
      file: paths.agentLock,
      infoFile: paths.agentLockInfo,
      busy: "另一個 tars chat 正在執行",
      command,
    },
    now,
  );

/**
 * Who holds a lock goes in the info file beside it, since an exclusively locked database cannot
 * be read by anyone else; the info file may be a dead holder's, so it only feeds the message.
 */
export async function acquireLockAt(spec: LockSpec, now: Date): Promise<LockHandle> {
  await mkdir(dirname(spec.file), { recursive: true });
  const db = new Database(spec.file, { create: true });
  try {
    db.exec("PRAGMA busy_timeout=0");
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS h(x); COMMIT;");
  } catch (err) {
    db.close();
    if (!isBusy(err)) throw err;
    const info = await readLockInfoAt(spec.infoFile);
    throw new TarsError(
      info === undefined
        ? spec.busy
        : `${spec.busy}（pid ${info.pid}，${new Date(info.startedAt).toISOString()} 開始）`,
    );
  }
  await writeFileAtomic(
    spec.infoFile,
    `${JSON.stringify({ pid: process.pid, startedAt: now.getTime(), command: spec.command })}\n`,
  );
  return { release: () => db.close() };
}

export const isBusy = (err: unknown) =>
  (err as { code?: string }).code?.startsWith("SQLITE_BUSY") === true ||
  /database is locked/.test((err as Error).message);

export const readLockInfo = (paths: TarsPaths) => readLockInfoAt(paths.agentLockInfo);

async function readLockInfoAt(file: string): Promise<LockInfo | undefined> {
  try {
    const info = JSON.parse(await readFile(file, "utf8")) as LockInfo;
    return typeof info.pid === "number" && typeof info.startedAt === "number" ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens agent.db. The writer (tars chat, cost adjust) creates it and applies pending migrations
 * in one transaction. A reader never migrates; it gets undefined when there is nothing to read.
 */
export function openDb(paths: TarsPaths, opts: { readonly: true }): Database | undefined;
export function openDb(paths: TarsPaths, opts?: { readonly?: false }): Promise<Database>;
export function openDb(
  paths: TarsPaths,
  opts: { readonly?: boolean } = {},
): Database | undefined | Promise<Database> {
  if (!opts.readonly) return openSqlite(paths.agentDb, MIGRATIONS);
  const db = openSqlite(paths.agentDb, MIGRATIONS, { readonly: true });
  if (db === "newer") throw new TarsError(NEWER);
  return db;
}

const NEWER = "這個資料庫由較新的 tars 建立，請更新 tars";

/**
 * One SQLite file with its own migrations. A reader gets undefined when there is nothing to read
 * and "newer" when a later tars made it; an older version stays as it is until a writer migrates
 * it, so readers of the tables that changed check which version they see.
 */
export function openSqlite(
  file: string,
  migrations: readonly string[],
  opts: { readonly: true },
): Database | undefined | "newer";
export function openSqlite(
  file: string,
  migrations: readonly string[],
  opts?: { readonly?: false },
): Promise<Database>;
export function openSqlite(
  file: string,
  migrations: readonly string[],
  opts: { readonly?: boolean } = {},
): Database | undefined | "newer" | Promise<Database> {
  if (!opts.readonly) return openWritable(file, migrations);
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  db.exec("PRAGMA busy_timeout=5000");
  const version = schemaVersion(db);
  if (version === 0 || version > migrations.length) {
    db.close();
    return version === 0 ? undefined : "newer";
  }
  db.exec("PRAGMA query_only=ON");
  return db;
}

async function openWritable(file: string, migrations: readonly string[]): Promise<Database> {
  await mkdir(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  // Checked outside the transaction: closing inside it would leave nothing to roll back.
  if (schemaVersion(db) > migrations.length) {
    db.close();
    throw new TarsError(NEWER);
  }
  db.transaction(() => {
    const version = schemaVersion(db);
    for (const sql of migrations.slice(version)) db.exec(sql);
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [
      String(migrations.length),
    ]);
  }).immediate();
  return db;
}

function schemaVersion(db: Database): number {
  const meta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (meta === null) return 0;
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  return row === null ? 0 : Number(row.value);
}
