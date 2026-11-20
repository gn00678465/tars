import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { openDb } from "../../../src/features/agent/db.ts";
import { adjust } from "../../../src/features/agent/ledger.ts";
import { openWikiDb, WIKI_MIGRATIONS, wikiSpend } from "../../../src/features/wiki/db.ts";
import { isolatedPaths, NOW, PROVIDER } from "../agent/db-fixture.ts";
import { syncUsage } from "./wiki-fixture.ts";

const columns = (db: Database, table: string) =>
  db.query(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}')`).all();
const indexes = (db: Database, table: string) =>
  (
    db
      .query(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
      )
      .all(table) as { sql: string }[]
  ).map((r) => r.sql);

describe("openWikiDb", () => {
  test("the writer creates version 1 with every table", async () => {
    const paths = isolatedPaths();
    const db = await openWikiDb(paths);
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(WIKI_MIGRATIONS.length),
    });
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of [
      "runs",
      "turns",
      "usage",
      "sources",
      "waiting_turns",
      "candidates",
      "pages",
      "cursors",
      "page_docs",
      "page_fts",
      "raw_docs",
      "raw_fts",
    ])
      expect(names).toContain(t);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });

  test("a reader gets undefined without a file, and creates nothing", () => {
    const paths = isolatedPaths();
    expect(openWikiDb(paths, { readonly: true })).toBeUndefined();
    expect(existsSync(paths.wikiDb)).toBe(false);
  });

  test("a reader never migrates and cannot write", async () => {
    const paths = isolatedPaths();
    (await openWikiDb(paths)).close();
    const db = openWikiDb(paths, { readonly: true });
    if (!(db instanceof Database)) throw new Error("no database");
    expect(() => db.run("DELETE FROM pages")).toThrow();
    db.close();
  });

  test('a database from a newer tars is "newer" for a reader, an error for the writer', async () => {
    const paths = isolatedPaths();
    const db = await openWikiDb(paths);
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db.close();
    expect(openWikiDb(paths, { readonly: true })).toBe("newer");
    await expect(openWikiDb(paths)).rejects.toThrow("較新的 tars");
  });
});

describe("the tables ledger.ts writes keep agent.db's shape", () => {
  test("usage is the same, columns and indexes; turns has every column ledger.ts uses", async () => {
    const paths = isolatedPaths();
    const agent = await openDb(paths);
    const wiki = await openWikiDb(paths);
    expect(columns(wiki, "usage")).toEqual(columns(agent, "usage"));
    expect(indexes(wiki, "usage")).toEqual(indexes(agent, "usage"));
    const turnCols = columns(wiki, "turns");
    for (const name of ["id", "conv_id", "state", "requests", "cost_usd", "ended_at"])
      expect(turnCols).toContainEqual(expect.objectContaining({ name }));
    agent.close();
    wiki.close();
  });
});

describe("wikiSpend", () => {
  const LAST_MONTH = new Date("2026-10-30T00:00:00Z");
  const EARLIER = new Date("2026-11-19T01:00:00Z");
  const LATER = new Date("2026-11-19T11:00:00Z");

  test("without wiki.db: four zeros", () => {
    expect(wikiSpend(isolatedPaths(), undefined, "anthropic", PROVIDER, NOW)).toEqual({
      period: 0,
      today: 0,
      rawToday: 0,
      rawMonth: 0,
    });
  });

  test("without agent.db, or without an adjustment: plain sums", async () => {
    const paths = isolatedPaths();
    await syncUsage(paths, 1, LAST_MONTH);
    await syncUsage(paths, 2, new Date("2026-11-02T00:00:00Z"));
    await syncUsage(paths, 3, EARLIER);
    const expected = { period: 5, today: 3, rawToday: 3, rawMonth: 5 };
    expect(wikiSpend(paths, undefined, "anthropic", PROVIDER, NOW)).toEqual(expected);
    const agent = await openDb(paths);
    expect(wikiSpend(paths, agent, "anthropic", PROVIDER, NOW)).toEqual(expected);
    agent.close();
  });

  test("after an adjustment only later rows and rows still reserved count for the provider", async () => {
    const paths = isolatedPaths();
    await syncUsage(paths, 3, EARLIER);
    await syncUsage(paths, 4, EARLIER, true);
    const agent = await openDb(paths);
    adjust(agent, "anthropic", 20, undefined, new Date("2026-11-19T06:00:00Z"));
    await syncUsage(paths, 5, LATER);
    expect(wikiSpend(paths, agent, "anthropic", PROVIDER, NOW)).toEqual({
      period: 9,
      today: 12,
      rawToday: 12,
      rawMonth: 12,
    });
    agent.close();
  });

  test('period "total" reaches back past this month', async () => {
    const paths = isolatedPaths();
    await syncUsage(paths, 1, LAST_MONTH);
    await syncUsage(paths, 2, EARLIER);
    const total = { ...PROVIDER, period: "total" as const };
    expect(wikiSpend(paths, undefined, "anthropic", total, NOW)?.period).toBe(3);
    expect(wikiSpend(paths, undefined, "anthropic", PROVIDER, NOW)?.period).toBe(2);
  });

  test("a wiki.db from a newer tars gives undefined, not an exception", async () => {
    const paths = isolatedPaths();
    const db = await openWikiDb(paths);
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db.close();
    expect(wikiSpend(paths, undefined, "anthropic", PROVIDER, NOW)).toBeUndefined();
  });
});
