import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  approvalHash,
  cancel,
  canonicalJson,
  create,
  decide,
  expire,
} from "../../../src/features/agent/approvals.ts";
import { newId, recordToolCalls } from "../../../src/features/agent/store.ts";
import type { ScriptFields } from "../../../src/features/agent/tars-tool.ts";
import { agentDb, NOW, seedTurn } from "./db-fixture.ts";

const FIELDS: ScriptFields = {
  action: "run_script",
  script: "bark-push",
  version: "0123456789abcdef",
  summary: "推播",
  effects: "external-write",
  domains: ["api.day.app"],
  secret: "bark",
  argv: [
    "script",
    "run",
    "bark-push",
    "--expect-version",
    "0123456789abcdef",
    "--timeout",
    "120",
    "--",
  ],
};

const T0 = NOW.getTime();

async function pending(timeoutS = 600) {
  const { db } = await agentDb();
  const { convId, turnId } = seedTurn(db);
  const toolCallId = newId();
  recordToolCalls(db, [
    { id: toolCallId, turnId, convId, step: 1, providerCallId: "tu_1", name: "tars", input: {} },
  ]);
  const record = create(db, { toolCallId, convId, fields: FIELDS, now: T0, timeoutS });
  return { db, record, toolCallId, convId };
}

const approvalRow = (db: Database, id: string) =>
  db.query("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown>;
const callState = (db: Database, id: string) =>
  (db.query("SELECT state FROM tool_calls WHERE id = ?").get(id) as { state: string }).state;

describe("create", () => {
  test("records a pending approval that expires timeoutS later, in milliseconds", async () => {
    const { db, record, toolCallId } = await pending(600);
    expect(record.expiresAt).toBe(T0 + 600_000);
    expect(record.fields).toEqual({ ...FIELDS, approvalId: record.id, expiresAt: T0 + 600_000 });
    const row = approvalRow(db, record.id);
    expect(row).toMatchObject({
      tool_call_id: toolCallId,
      state: "pending",
      created_at: T0,
      expires_at: T0 + 600_000,
      hash: record.hash,
    });
    expect(JSON.parse(row.fields as string)).toEqual(record.fields);
    expect(callState(db, toolCallId)).toBe("pending_approval");
  });

  test("the hash covers the approval id, the conversation, argv, script and version", async () => {
    const { record, convId } = await pending();
    expect(record.hash).toBe(
      approvalHash({
        approvalId: record.id,
        convId,
        argv: FIELDS.argv,
        script: "bark-push",
        version: FIELDS.version,
      }),
    );
  });

  test("when moving the call to pending_approval fails, no approval is left behind", async () => {
    const { db } = await agentDb();
    const { convId, turnId } = seedTurn(db);
    const toolCallId = newId();
    recordToolCalls(db, [
      { id: toolCallId, turnId, convId, step: 1, providerCallId: "tu_1", name: "tars", input: {} },
    ]);
    db.run(
      "CREATE TRIGGER no_update BEFORE UPDATE ON tool_calls BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(() =>
      create(db, { toolCallId, convId, fields: FIELDS, now: T0, timeoutS: 600 }),
    ).toThrow("refused");
    expect((db.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n).toBe(0);
    expect(callState(db, toolCallId)).toBe("received");
  });
});

describe("decide", () => {
  test("a pending, unexpired approval with the same hash is decided once", async () => {
    const { db, record } = await pending();
    const d = {
      id: record.id,
      decision: "approved" as const,
      hash: record.hash,
      via: "tty" as const,
    };
    expect(decide(db, { ...d, now: T0 + 1000 })).toBe("ok");
    expect(approvalRow(db, record.id)).toMatchObject({
      state: "approved",
      decided_at: T0 + 1000,
      decided_via: "tty",
    });
    expect(decide(db, { ...d, decision: "denied", now: T0 + 2000 })).toBe("already_decided");
    expect(approvalRow(db, record.id).state).toBe("approved");
  });

  test("past the expiry it is expired, and the row says so", async () => {
    const { db, record } = await pending(10);
    expect(
      decide(db, {
        id: record.id,
        decision: "approved",
        hash: record.hash,
        via: "tty",
        now: T0 + 10_000,
      }),
    ).toBe("expired");
    expect(approvalRow(db, record.id)).toMatchObject({ state: "expired", decided_at: null });
  });

  test("another hash does not decide it", async () => {
    const { db, record } = await pending();
    expect(
      decide(db, {
        id: record.id,
        decision: "approved",
        hash: "0".repeat(64),
        via: "tty",
        now: T0,
      }),
    ).toBe("hash_mismatch");
    expect(approvalRow(db, record.id).state).toBe("pending");
  });

  test("an unknown id reads as already decided", async () => {
    const { db, record } = await pending();
    expect(
      decide(db, { id: newId(), decision: "denied", hash: record.hash, via: "tty", now: T0 }),
    ).toBe("already_decided");
  });
});

describe("cancel and expire", () => {
  test("change only a pending approval", async () => {
    const { db, record } = await pending();
    expect(cancel(db, record.id)).toBe(true);
    expect(approvalRow(db, record.id).state).toBe("cancelled");
    expect(expire(db, record.id)).toBe(false);
    expect(cancel(db, record.id)).toBe(false);
    expect(approvalRow(db, record.id).state).toBe("cancelled");
  });

  test("expire a pending one; a decided one stays decided", async () => {
    const a = await pending();
    expect(expire(a.db, a.record.id)).toBe(true);
    expect(approvalRow(a.db, a.record.id).state).toBe("expired");
    const b = await pending();
    decide(b.db, { id: b.record.id, decision: "denied", hash: b.record.hash, via: "tty", now: T0 });
    expect(expire(b.db, b.record.id)).toBe(false);
    expect(approvalRow(b.db, b.record.id).state).toBe("denied");
  });
});

describe("canonicalJson and approvalHash", () => {
  const base = {
    approvalId: "a",
    convId: "c",
    argv: ["script", "run", "x", "--", "1", "2"],
    script: "x",
    version: "v",
  };

  test("object keys are sorted at every depth; arrays keep their order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("the hash does not depend on key order", () => {
    const reordered = {
      version: "v",
      script: "x",
      argv: base.argv,
      convId: "c",
      approvalId: "a",
    };
    expect(approvalHash(reordered)).toBe(approvalHash(base));
  });

  test("the hash depends on argv order and on every field", () => {
    const h = approvalHash(base);
    expect(approvalHash({ ...base, argv: ["script", "run", "x", "--", "2", "1"] })).not.toBe(h);
    for (const key of ["approvalId", "convId", "script", "version"] as const)
      expect(approvalHash({ ...base, [key]: "other" })).not.toBe(h);
  });
});
