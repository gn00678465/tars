import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { openDb } from "../../../src/features/agent/db.ts";
import { openWikiDb, WIKI_MIGRATIONS } from "../../../src/features/wiki/db.ts";
import { isolatedPaths } from "../agent/db-fixture.ts";

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
