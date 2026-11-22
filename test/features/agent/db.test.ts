import {
  beginTurn,
  findTurnByRequest,
  getConversation,
  newId,
  readEpoch,
} from "../../../src/features/agent/store.ts";
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import {
  acquireLock,
  acquireLockAt,
  MIGRATIONS,
  openDb,
  openSqlite,
  readLockInfo,
} from "../../../src/features/agent/db.ts";
import { spent } from "../../../src/features/agent/ledger.ts";
import { appendItems } from "../../../src/features/agent/store.ts";
import { agentDb, isolatedPaths, NOW, PROVIDER, seedTurn } from "./db-fixture.ts";

async function refusal(promise: Promise<unknown>): Promise<TarsError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TarsError);
    return err as TarsError;
  }
  throw new Error("expected a refusal");
}

describe("acquireLock", () => {
  test("a second holder is refused with the first holder's pid from lock.json", async () => {
    const paths = isolatedPaths();
    const first = await acquireLock(paths, NOW);
    try {
      expect(await readLockInfo(paths)).toEqual({
        pid: process.pid,
        startedAt: NOW.getTime(),
        command: "chat",
      });
      const err = await refusal(acquireLock(paths, NOW));
      expect(err.exitCode).toBe(1);
      expect(err.message).toBe(
        `對話資料庫正由 tars chat 使用（pid ${process.pid}，${NOW.toISOString()} 開始）`,
      );
    } finally {
      first.release();
    }
  });

  test("tars serve holding it is named as serve", async () => {
    const paths = isolatedPaths();
    const first = await acquireLock(paths, NOW, "serve");
    try {
      expect((await refusal(acquireLock(paths, NOW))).message).toBe(
        `對話資料庫正由 tars serve 使用（pid ${process.pid}，${NOW.toISOString()} 開始）`,
      );
    } finally {
      first.release();
    }
  });

  test("without a readable lock.json no holder is named", async () => {
    const paths = isolatedPaths();
    const first = await acquireLock(paths, NOW);
    try {
      writeFileSync(paths.agentLockInfo, "not json");
      expect((await refusal(acquireLock(paths, NOW))).message).toBe(
        "對話資料庫正由另一個 tars 行程使用",
      );
    } finally {
      first.release();
    }
  });

  test("after release the lock can be taken again", async () => {
    const paths = isolatedPaths();
    (await acquireLock(paths, NOW)).release();
    const again = await acquireLock(paths, NOW);
    again.release();
  });
});

describe("acquireLockAt", () => {
  test("two different locks do not block each other; each refuses its own second holder", async () => {
    const paths = isolatedPaths();
    const other = {
      file: join(paths.agent, "other-lock.db"),
      infoFile: join(paths.agent, "other-lock.json"),
      busy: () => "另一個 other 正在執行",
      command: "other",
    };
    const chat = await acquireLock(paths, NOW);
    const held = await acquireLockAt(other, NOW);
    try {
      expect((await refusal(acquireLockAt(other, NOW))).message).toBe("另一個 other 正在執行");
      expect((await refusal(acquireLock(paths, NOW))).message).toStartWith(
        "對話資料庫正由 tars chat 使用",
      );
      expect(await readLockInfo(paths)).toMatchObject({ command: "chat" });
    } finally {
      held.release();
      chat.release();
    }
  });
});

describe("openSqlite", () => {
  test('read-only, a database from a newer tars gives "newer" instead of throwing', async () => {
    const { paths, db } = await agentDb();
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db.close();
    expect(openSqlite(paths.agentDb, MIGRATIONS, { readonly: true })).toBe("newer");
    const known = openSqlite(paths.agentDb, Array<string>(99).fill(""), { readonly: true });
    expect(known).toBeInstanceOf(Database);
    (known as Database).close();
  });
});

describe("openDb", () => {
  test("an empty database migrates to version 6 with every table", async () => {
    const { db } = await agentDb();
    expect(MIGRATIONS.length).toBe(6);
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "6",
    });
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_"));
    expect(tables).toEqual([
      "adjustments",
      "approvals",
      "conversations",
      "items",
      "meta",
      "tool_calls",
      "turns",
      "usage",
    ]);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  /**
   * A version 1 file whose clock went back: usage 3 was written after usage 2 with an earlier
   * time. Version 1 counted by time, so after the adjustment at 200 it counted usage 2 and 4.
   */
  function v1WithSkew(journal: "DELETE" | "WAL" = "DELETE", writer: "closed" | "open" = "closed") {
    const paths = isolatedPaths();
    mkdirSync(paths.agent, { recursive: true });
    const v1 = new Database(paths.agentDb, { create: true });
    v1.exec(`PRAGMA journal_mode=${journal}`);
    v1.exec(MIGRATIONS[0] as string);
    v1.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    const turn = seedTurn(v1);
    for (const [step, at, usd] of [
      [1, 100, 1],
      [2, 300, 2],
      [3, 150, 3],
      [4, 400, 4],
    ] as const)
      v1.run(
        `INSERT INTO usage (turn_id, conv_id, step, attempt, provider, model, state, reserved_usd,
           max_tokens, cost_usd, cost_source, price, at, day, month)
         VALUES (?, ?, ?, 1, 'anthropic', 'm', 'final', 1, 0, ?, 'table', '{}', ?, 'd', '2026-11')`,
        [turn.turnId, turn.convId, step, usd, at],
      );
    v1.run(
      "INSERT INTO adjustments (provider, at, month, spent_usd) VALUES ('anthropic', 200, '2026-11', 9)",
    );
    if (writer === "closed") v1.close();
    return { paths, writer: v1 };
  }
  const V1_SPENT = 9 + 2 + 4;

  test("migrating version 1 keeps the total, a clock that went back included", async () => {
    const db = await openDb(v1WithSkew().paths);
    expect(spent(db, "anthropic", PROVIDER, NOW)).toBe(V1_SPENT);
    db.close();
  });

  test.each([
    ["DELETE", "closed"],
    ["WAL", "closed"],
    ["WAL", "open"],
  ] as const)(
    "a reader of a version 1 file (%s journal, writer %s) gets the same total and cannot write",
    (journal, writer) => {
      const v1 = v1WithSkew(journal, writer);
      const db = openDb(v1.paths, { readonly: true });
      if (db === undefined) throw new Error("no database");
      try {
        expect(spent(db, "anthropic", PROVIDER, NOW)).toBe(V1_SPENT);
        expect(() => db.run("UPDATE adjustments SET spent_usd = 0")).toThrow();
      } finally {
        db.close();
        v1.writer.close();
      }
      const raw = new Database(v1.paths.agentDb, { readonly: true });
      expect(raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: "1",
      });
      expect(raw.query("SELECT spent_usd FROM adjustments").all()).toEqual([{ spent_usd: 9 }]);
      raw.close();
    },
  );

  test("version 2 to 6 adds parent_id, request_id and its index, and the epoch", async () => {
    const paths = isolatedPaths();
    mkdirSync(paths.agent, { recursive: true });
    const v2 = new Database(paths.agentDb, { create: true });
    for (const sql of MIGRATIONS.slice(0, 2)) v2.exec(sql);
    v2.run("INSERT INTO meta (key, value) VALUES ('schema_version', '2')");
    seedTurn(v2);
    type Master = { type: string; name: string; sql: string | null };
    const master = (db: Database) =>
      db.query("SELECT type, name, sql FROM sqlite_master ORDER BY 1, 2").all() as Master[];
    const dump = (db: Database) =>
      ["conversations", "turns"].map((t) => db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all());
    const changed = (m: Master) =>
      m.type === "table" && (m.name === "conversations" || m.name === "turns");
    const before = { master: master(v2), rows: dump(v2) };
    v2.close();
    const db = await openDb(paths);
    const after = master(db);
    expect(
      after.filter(
        (m) => !changed(m) && m.name !== "turns_request_id" && m.name !== "conversations_active",
      ),
    ).toEqual(before.master.filter((m) => !changed(m)));
    const sqlOf = (ms: Master[], name: string) =>
      ms.find((m) => m.type === "table" && m.name === name)?.sql as string;
    const plus = (sql: string, column: string) =>
      `${sql.slice(0, sql.lastIndexOf(")"))}, ${column})`;
    expect(sqlOf(after, "conversations")).toBe(
      plus(
        plus(sqlOf(before.master, "conversations"), "parent_id TEXT REFERENCES conversations(id)"),
        "archived_at INTEGER",
      ),
    );
    expect(sqlOf(after, "turns")).toBe(plus(sqlOf(before.master, "turns"), "request_id TEXT"));
    expect(after.find((m) => m.name === "turns_request_id")?.type).toBe("index");
    expect(dump(db)).toEqual(
      before.rows.map((rows, i) =>
        rows.map((r) => ({
          ...(r as object),
          ...(i === 0 ? { parent_id: null, archived_at: null } : { request_id: null }),
        })),
      ),
    );
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "6",
    });
    expect(readEpoch(db)).toMatch(/^[0-9a-f]{32}$/);
    db.close();
  });

  test("version 3 to 4: an earlier conversation has no parentId", async () => {
    const paths = isolatedPaths();
    mkdirSync(paths.agent, { recursive: true });
    const v3 = new Database(paths.agentDb, { create: true });
    // Migration 3 is a comment only; the version alone makes the file version 3.
    for (const sql of MIGRATIONS.slice(0, 2)) v3.exec(sql);
    v3.run("INSERT INTO meta (key, value) VALUES ('schema_version', '3')");
    const { convId } = seedTurn(v3);
    v3.close();
    const db = await openDb(paths);
    const conv = getConversation(db, convId);
    expect(conv.parentId).toBeUndefined();
    expect("parentId" in conv).toBe(false);
    db.close();
  });

  /** A version 5 file with conversations, turns, items and usage, for the upgrade to 6. */
  async function v5WithData() {
    const paths = isolatedPaths();
    mkdirSync(paths.agent, { recursive: true });
    const v5 = new Database(paths.agentDb, { create: true });
    v5.exec("PRAGMA journal_mode=WAL");
    // Migration 3 is a comment only, which exec refuses.
    for (const sql of MIGRATIONS.slice(0, 5)) if (!sql.startsWith("--")) v5.exec(sql);
    v5.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')");
    for (const text of ["一", "二", "三"]) {
      const t = seedTurn(v5, { text });
      appendItems(v5, t.convId, t.turnId, [{ kind: "user", step: 0, body: { text } }], 1);
    }
    return { paths, v5 };
  }

  test("version 5 to 6 backs the file up first, owner-only, and keeps every count", async () => {
    const { paths, v5 } = await v5WithData();
    const counts = (d: Database) =>
      ["conversations", "turns", "items"].map(
        (t) => (d.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const before = counts(v5);
    v5.close();
    const db = await openDb(paths);
    expect(counts(db)).toEqual(before);
    expect(
      db.query("SELECT COUNT(*) AS n FROM conversations WHERE archived_at IS NULL").get(),
    ).toEqual({ n: 3 });
    const backups = readdirSync(paths.agent).filter((f) => f.startsWith("agent.db.bak-v5-"));
    expect(backups).toHaveLength(1);
    const file = join(paths.agent, backups[0] as string);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The copy is a database of the old version with the same rows.
    const copy = new Database(file, { readonly: true });
    expect(copy.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "5",
    });
    expect(counts(copy)).toEqual(before);
    copy.close();
    db.close();
    // Already current: opening again makes no second copy.
    (await openDb(paths)).close();
    expect(readdirSync(paths.agent).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });

  test("a backup that cannot be written stops the upgrade and leaves the file at version 5", async () => {
    const { paths, v5 } = await v5WithData();
    v5.close();
    // The copy cannot be made, whatever the reason.
    const real = Database.prototype.run;
    const spy = spyOn(Database.prototype, "run").mockImplementation(function (
      this: Database,
      sql: string,
      ...rest: unknown[]
    ) {
      if (sql.startsWith("VACUUM INTO")) throw new Error("disk full");
      return real.call(this, sql, ...(rest as []));
    } as typeof real);
    try {
      await expect(openDb(paths)).rejects.toThrow("升級前備份資料庫失敗");
    } finally {
      spy.mockRestore();
    }
    const raw = new Database(paths.agentDb, { readonly: true });
    expect(raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "5",
    });
    raw.close();
  });

  test("each new database gets its own epoch, kept across reopening", async () => {
    const a = await agentDb();
    const b = await agentDb();
    const epoch = readEpoch(a.db);
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(readEpoch(b.db)).not.toBe(epoch);
    a.db.close();
    b.db.close();
    const again = await openDb(a.paths);
    expect(readEpoch(again)).toBe(epoch);
    again.close();
  });

  test("a request_id is unique over the whole database; a second one rolls its turn back", async () => {
    const { db } = await agentDb();
    const first = seedTurn(db);
    const requestId = newId();
    beginTurn(db, {
      id: newId(),
      convId: first.convId,
      kind: "chat",
      effort: null,
      now: NOW.getTime(),
      requestId,
    });
    const other = seedTurn(db);
    const turnId = newId();
    expect(() =>
      db.transaction(() =>
        beginTurn(db, {
          id: turnId,
          convId: other.convId,
          kind: "chat",
          effort: null,
          now: NOW.getTime(),
          requestId,
        }),
      )(),
    ).toThrow(/UNIQUE/);
    expect(db.query("SELECT 1 FROM turns WHERE id = ?").get(turnId)).toBeNull();
    expect(findTurnByRequest(db, requestId)?.convId).toBe(first.convId);
    db.close();
  });

  test("reopening does not migrate again", async () => {
    const { paths, db } = await agentDb();
    db.run(
      "INSERT INTO adjustments (provider, at, month, spent_usd) VALUES ('anthropic', 1, '2026-11', 1)",
    );
    db.close();
    const again = await openDb(paths);
    expect(again.query("SELECT count(*) AS n FROM adjustments").get()).toEqual({ n: 1 });
    again.close();
  });

  const newerDb = async () => {
    const { paths, db } = await agentDb();
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db.close();
    return paths;
  };

  test("a database from a newer tars is refused read-only", async () => {
    const paths = await newerDb();
    expect(() => openDb(paths, { readonly: true })).toThrow("較新的 tars");
  });

  test("a database from a newer tars is refused for writing", async () => {
    const err = await refusal(openDb(await newerDb()));
    expect(err.message).toContain("較新的 tars");
  });

  test("read-only opening works while the lock is held and a writer is open", async () => {
    const { paths, db } = await agentDb();
    const lock = await acquireLock(paths, NOW);
    try {
      db.run(
        "INSERT INTO adjustments (provider, at, month, spent_usd) VALUES ('anthropic', 1, '2026-11', 2)",
      );
      const ro = openDb(paths, { readonly: true });
      expect(ro).toBeInstanceOf(Database);
      expect(ro?.query("SELECT spent_usd FROM adjustments").get()).toEqual({ spent_usd: 2 });
      ro?.close();
    } finally {
      lock.release();
      db.close();
    }
  });

  test("read-only opening of a missing database gives undefined and creates nothing", () => {
    const paths = isolatedPaths();
    expect(openDb(paths, { readonly: true })).toBeUndefined();
    expect(existsSync(paths.agentDb)).toBe(false);
    expect(existsSync(paths.agent)).toBe(false);
  });

  test("read-only opening of a database with no schema yet gives undefined", () => {
    const paths = isolatedPaths();
    mkdirSync(paths.agent, { recursive: true });
    new Database(paths.agentDb, { create: true }).close();
    expect(openDb(paths, { readonly: true })).toBeUndefined();
  });
});
