import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
        `另一個 tars chat 正在執行（pid ${process.pid}，${NOW.toISOString()} 開始）`,
      );
    } finally {
      first.release();
    }
  });

  test("without a readable lock.json only the first half is printed", async () => {
    const paths = isolatedPaths();
    const first = await acquireLock(paths, NOW);
    try {
      writeFileSync(paths.agentLockInfo, "not json");
      expect((await refusal(acquireLock(paths, NOW))).message).toBe("另一個 tars chat 正在執行");
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
      busy: "另一個 other 正在執行",
      command: "other",
    };
    const chat = await acquireLock(paths, NOW);
    const held = await acquireLockAt(other, NOW);
    try {
      expect((await refusal(acquireLockAt(other, NOW))).message).toStartWith(
        "另一個 other 正在執行（pid",
      );
      expect((await refusal(acquireLock(paths, NOW))).message).toStartWith(
        "另一個 tars chat 正在執行",
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
  test("an empty database migrates to version 2 with every table", async () => {
    const { db } = await agentDb();
    expect(MIGRATIONS.length).toBe(2);
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "2",
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
