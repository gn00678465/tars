import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { create as createApproval } from "../../../src/features/agent/approvals.ts";
import { MIGRATIONS } from "../../../src/features/agent/db.ts";
import {
  archiveBlocker,
  archiveConversation,
  endTurn,
  findConversation,
  getConversation,
  listConversations,
  newId,
  recordToolCalls,
  unarchiveConversation,
} from "../../../src/features/agent/store.ts";
import type { ScriptFields } from "../../../src/features/agent/tars-tool.ts";
import { agentDb, isolatedPaths, NOW, seedTurn } from "./db-fixture.ts";

const T = NOW.getTime();

/** A conversation whose only turn has ended. */
async function idle() {
  const { db } = await agentDb();
  const seed = seedTurn(db);
  endTurn(db, { id: seed.turnId, convId: seed.convId, state: "completed", now: T + 1 });
  return { db, id: seed.convId };
}

describe("archiving a conversation", () => {
  test("it leaves the list in use for the archived one, and unarchiving puts it back where it was", async () => {
    const { db, id } = await idle();
    const other = seedTurn(db, { now: new Date(T + 5000) });
    endTurn(db, { id: other.turnId, convId: other.convId, state: "completed", now: T + 5000 });
    const updatedAt = getConversation(db, id).updatedAt;
    expect(archiveConversation(db, id, T + 9000)).toBe("archived");
    expect(listConversations(db).map((c) => c.id)).toEqual([other.convId]);
    expect(listConversations(db, { archived: true }).map((c) => [c.id, c.archivedAt])).toEqual([
      [id, T + 9000],
    ]);
    // Reading it by id still works: sync, spend and "continued from" go that way.
    expect(findConversation(db, id).archivedAt).toBe(T + 9000);
    expect(unarchiveConversation(db, id)).toBe(true);
    expect(unarchiveConversation(db, id)).toBe(false);
    expect(getConversation(db, id).updatedAt).toBe(updatedAt);
    expect(getConversation(db, id).archivedAt).toBeUndefined();
    expect(listConversations(db).map((c) => c.id)).toEqual([other.convId, id]);
  });

  test("archiving again keeps the first time", async () => {
    const { db, id } = await idle();
    archiveConversation(db, id, T + 10);
    expect(archiveConversation(db, id, T + 20)).toBe("already");
    expect(getConversation(db, id).archivedAt).toBe(T + 10);
  });

  test("a running turn, a compaction or a pending approval keeps it from being archived", async () => {
    const { db } = await agentDb();
    const running = seedTurn(db);
    expect(archiveBlocker(db, running.convId)).toBe("running");
    expect(archiveConversation(db, running.convId, T)).toBe("running");
    const compacting = seedTurn(db, { kind: "compaction" });
    expect(archiveConversation(db, compacting.convId, T)).toBe("running");

    const waiting = seedTurn(db);
    const fields: ScriptFields = {
      action: "run_script",
      script: "s",
      version: "v",
      summary: "x",
      effects: "read-only",
      domains: [],
      secret: null,
      argv: ["script", "run", "s"],
    };
    const toolCallId = newId();
    recordToolCalls(db, [
      {
        id: toolCallId,
        turnId: waiting.turnId,
        convId: waiting.convId,
        step: 1,
        providerCallId: "tu_1",
        name: "tars",
        input: {},
      },
    ]);
    createApproval(db, { toolCallId, convId: waiting.convId, fields, now: T, timeoutS: 600 });
    // Its turn ends, the approval does not: the approval alone blocks.
    endTurn(db, { id: waiting.turnId, convId: waiting.convId, state: "completed", now: T });
    expect(archiveConversation(db, waiting.convId, T)).toBe("approval");
    expect(listConversations(db)).toHaveLength(3);
    expect(listConversations(db, { archived: true })).toEqual([]);
  });

  test("a database not yet migrated to version 6 lists everything as in use and nothing archived", () => {
    const paths = isolatedPaths();
    mkdirSync(paths.agent, { recursive: true });
    const v5 = new Database(paths.agentDb, { create: true });
    for (const sql of MIGRATIONS.slice(0, 5)) if (!sql.startsWith("--")) v5.exec(sql);
    const { convId } = seedTurn(v5);
    expect(listConversations(v5).map((c) => c.id)).toEqual([convId]);
    expect(listConversations(v5, { archived: true })).toEqual([]);
    expect(getConversation(v5, convId).archivedAt).toBeUndefined();
    v5.close();
  });
});
