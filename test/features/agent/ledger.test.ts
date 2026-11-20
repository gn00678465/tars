import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { utf8Bytes } from "../../../src/features/agent/bytes.ts";
import { DEFAULT_LIMITS, type Limits } from "../../../src/features/agent/config.ts";
import {
  adjust,
  estimateInput,
  insertReserved,
  latestAdjustment,
  limitReached,
  recentRequests,
  recordEnd,
  recordEstimatedEnd,
  recordFailure,
  recordStart,
  reconcileLedger,
  reserve,
  settleReserved,
  spent,
  spentToday,
  status,
  type ReserveInput,
} from "../../../src/features/agent/ledger.ts";
import { getConversation } from "../../../src/features/agent/store.ts";
import { ZERO_USAGE, type Usage } from "../../../src/features/agent/types.ts";
import { openWikiDb } from "../../../src/features/wiki/db.ts";
import { agentDb, isolatedPaths, MODEL, NOW, PROVIDER, seedTurn } from "./db-fixture.ts";

type Turn = { convId: string; turnId: string };

let step = 0;
/** A request still in flight, reserved at `usd` (no output, so its cost is the amount). */
function inFlight(db: Database, turn: Turn, usd: number, at: Date = NOW): number {
  return insertReserved(db, {
    ...turn,
    step: ++step,
    attempt: 1,
    model: MODEL,
    cacheTtl: "5m",
    maxTokens: 0,
    inputUsd: usd,
    now: at,
  });
}

/** A settled usage row worth `usd` at `at`. */
function spend(db: Database, turn: Turn, usd: number, at: Date = NOW): number {
  const usageId = inFlight(db, turn, usd, at);
  recordFailure(db, { usageId, receivedStart: false, textBytes: 0 });
  return usageId;
}

const row = (db: Database, id: number) =>
  db.query("SELECT * FROM usage WHERE id = ?").get(id) as Record<string, number | string>;
const turnCost = (db: Database, turnId: string) =>
  (db.query("SELECT cost_usd FROM turns WHERE id = ?").get(turnId) as { cost_usd: number })
    .cost_usd;

describe("spent", () => {
  test("a UTC month counts only its own usage", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    spend(db, turn, 1, new Date("2026-10-31T23:59:00Z"));
    spend(db, turn, 2, new Date("2026-11-01T00:00:00Z"));
    expect(spent(db, "anthropic", PROVIDER, new Date("2026-11-15T00:00:00Z"))).toBe(2);
    expect(spent(db, "anthropic", PROVIDER, new Date("2026-10-31T23:59:30Z"))).toBe(1);
  });

  test("reads one snapshot: a write landing between its queries is not counted", async () => {
    const { paths, db } = await agentDb();
    const turn = seedTurn(db);
    spend(db, turn, 5);
    adjust(db, "anthropic", 20, undefined, NOW);
    spend(db, turn, 1);
    const reader = new Database(paths.agentDb, { readonly: true });
    // Another process records $7 of usage after spent has probed the schema.
    let queries = 0;
    const hooked = new Proxy(reader, {
      get(target, key) {
        if (key === "query")
          return (sql: string) => {
            if (++queries === 2) spend(db, turn, 7);
            return target.query(sql);
          };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(spent(hooked, "anthropic", PROVIDER, NOW)).toBe(21);
    expect(queries).toBeGreaterThan(2);
    expect(spent(reader, "anthropic", PROVIDER, NOW)).toBe(28);
    reader.close();
  });

  test("inside a write transaction it reads through a savepoint", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    spend(db, turn, 3);
    const inside = db
      .transaction(() => {
        spend(db, turn, 4);
        return spent(db, "anthropic", PROVIDER, NOW);
      })
      .immediate();
    expect(inside).toBe(7);
    expect(db.inTransaction).toBe(false);
    expect(spent(db, "anthropic", PROVIDER, NOW)).toBe(7);
  });

  test("after an adjustment only later usage is added to it", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    spend(db, turn, 5, new Date("2026-11-10T00:00:00Z"));
    adjust(db, "anthropic", 20, "console", new Date("2026-11-11T00:00:00Z"));
    spend(db, turn, 1.5, new Date("2026-11-12T00:00:00Z"));
    expect(spent(db, "anthropic", PROVIDER, NOW)).toBe(21.5);
  });

  test("an adjustment in an earlier month does not carry into this one", async () => {
    const { db } = await agentDb();
    adjust(db, "anthropic", 50, undefined, new Date("2026-10-20T00:00:00Z"));
    spend(db, seedTurn(db), 1, NOW);
    expect(spent(db, "anthropic", PROVIDER, NOW)).toBe(1);
  });

  test('period "total" adds prior spend until an adjustment replaces it', async () => {
    const { db } = await agentDb();
    const total = { ...PROVIDER, period: "total" as const, prior_spend_usd: 7 };
    const turn = seedTurn(db);
    spend(db, turn, 1, new Date("2026-09-01T00:00:00Z"));
    spend(db, turn, 2, NOW);
    expect(spent(db, "anthropic", total, NOW)).toBe(10);
    adjust(db, "anthropic", 30, undefined, new Date("2026-11-19T12:30:00Z"));
    spend(db, turn, 0.5, new Date("2026-11-19T13:00:00Z"));
    expect(spent(db, "anthropic", total, new Date("2026-11-19T14:00:00Z"))).toBe(30.5);
  });

  test("spentToday counts today's usage and ignores adjustments", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    spend(db, turn, 1, new Date("2026-11-18T23:00:00Z"));
    spend(db, turn, 2, new Date("2026-11-19T01:00:00Z"));
    adjust(db, "anthropic", 99, undefined, new Date("2026-11-19T02:00:00Z"));
    expect(spentToday(db, "anthropic", NOW)).toBe(2);
  });

  test("a request in the adjustment's millisecond is placed by its id, not its time", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    inFlight(db, turn, 5); // not on the bill yet, so it counts on top
    spend(db, turn, 1);
    adjust(db, "anthropic", 20, undefined, NOW);
    spend(db, turn, 4, NOW);
    expect(spent(db, "anthropic", PROVIDER, NOW)).toBe(29);
  });

  test("voided rows count for nothing", async () => {
    const { db } = await agentDb();
    const id = inFlight(db, seedTurn(db), 3);
    recordFailure(db, { usageId: id, status: 429, receivedStart: false, textBytes: 0 });
    expect(spent(db, "anthropic", PROVIDER, NOW)).toBe(0);
  });
});

describe("latestAdjustment", () => {
  test("a UTC month sees only this month's last adjustment, with its watermark", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    adjust(db, "anthropic", 50, undefined, new Date("2026-10-20T00:00:00Z"));
    expect(latestAdjustment(db, "anthropic", PROVIDER, NOW)).toBeNull();
    spend(db, turn, 1);
    const pending = inFlight(db, turn, 2);
    adjust(db, "anthropic", 9, undefined, new Date("2026-11-10T00:00:00Z"));
    adjust(db, "anthropic", 12, undefined, NOW);
    expect(latestAdjustment(db, "anthropic", PROVIDER, NOW)).toEqual({
      spentUsd: 12,
      at: NOW.getTime(),
      usageUpto: pending,
      usagePending: [pending],
    });
  });

  test('period "total" sees the last adjustment of any month', async () => {
    const { db } = await agentDb();
    const total = { ...PROVIDER, period: "total" as const };
    const at = new Date("2026-09-01T00:00:00Z");
    adjust(db, "anthropic", 30, undefined, at);
    expect(latestAdjustment(db, "anthropic", total, NOW)).toEqual({
      spentUsd: 30,
      at: at.getTime(),
      usageUpto: 0,
      usagePending: [],
    });
    expect(latestAdjustment(db, "anthropic", PROVIDER, NOW)).toBeNull();
  });
});

describe("estimateInput", () => {
  test("without a measured total: half the full prompt's bytes, times 1.2", () => {
    const chinese = utf8Bytes("請幫我整理這週的工作".repeat(10)); // 300 bytes
    expect(chinese).toBe(300);
    expect(estimateInput({ fullBytes: chinese, newBytes: 0, lastTotal: 0 })).toBe(180);
  });

  test("with a measured total: that plus half the new bytes, times 1.2", () => {
    const english = utf8Bytes("summarize this week's work. ".repeat(5)); // 140 bytes
    expect(english).toBe(140);
    expect(estimateInput({ fullBytes: 1_000_000, newBytes: english, lastTotal: 1000 })).toBe(
      Math.ceil((1000 + 70) * 1.2),
    );
  });
});

describe("reserve", () => {
  const conv = {
    id: "no-such-conversation",
    lastRequestAt: NOW.getTime() - 60_000,
    lastPrefixKey: "k",
  };
  /** A conversation whose last chat request, 10,000 tokens, put `cached` of them in the cache. */
  async function measured(cached = 10_000, sentAt = new Date(NOW.getTime() - 60_000)) {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    const usageId = inFlight(db, turn, 0, sentAt);
    recordEnd(db, {
      usageId,
      usage: {
        uncachedInputTokens: 10_000 - cached,
        cacheReadTokens: 0,
        cacheWriteTokens: cached,
        outputTokens: 0,
        thinkingTokens: 0,
      },
      turnKind: "chat",
      prefixKey: "k",
    });
    return { db, conv: getConversation(db, turn.convId) };
  }
  const base = (db: Database, over: Partial<ReserveInput> = {}): ReserveInput => ({
    db,
    provider: PROVIDER,
    limits: DEFAULT_LIMITS,
    model: MODEL,
    conv,
    prefixKey: "k",
    estInput: 12_000,
    turnId: undefined,
    turnKind: "chat",
    maxOutput: 16000,
    now: NOW,
    ...over,
  });
  const inputUsd = (db: Database, over: Partial<ReserveInput>) => {
    const r = reserve(base(db, over));
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r.inputUsd;
  };
  // Warm: 10,000 at cache read, 2,000 at max(input 3, cache write 3.75).
  const WARM = (10_000 * 0.3 + 2_000 * 3.75) / 1e6;
  const COLD = (12_000 * 3.75) / 1e6;

  test("warm cache prices the cached part at the read rate", async () => {
    const { db, conv: c } = await measured();
    expect(inputUsd(db, { conv: c })).toBeCloseTo(WARM, 12);
  });

  type Conv = NonNullable<ReserveInput["conv"]>;
  test.each([
    ["another prefix", (c: Conv) => ({ conv: c, prefixKey: "other" })],
    ["past the TTL", (c: Conv) => ({ conv: { ...c, lastRequestAt: NOW.getTime() - 5 * 60_000 } })],
    ["no last request", (c: Conv) => ({ conv: { ...c, lastRequestAt: null } })],
    [
      "a last request in the future (the clock went back an hour)",
      (c: Conv) => ({ conv: { ...c, lastRequestAt: NOW.getTime() + 60 * 60_000 } }),
    ],
    ["a compaction turn", (c: Conv) => ({ conv: c, turnKind: "compaction" as const })],
    ["no measured request in this conversation", () => ({ conv })],
  ])("%s: everything priced as fresh input", async (_, over) => {
    const { db, conv: c } = await measured();
    expect(inputUsd(db, over(c))).toBeCloseTo(COLD, 12);
  });

  test("same prefix but the last request cached nothing: priced as fresh input", async () => {
    const { db, conv: c } = await measured(0);
    expect(inputUsd(db, { conv: c })).toBeCloseTo(COLD, 12);
  });

  test("near the quota, a prefix that never cached does not borrow the read rate", async () => {
    // 0.04 USD of room: enough for warm input (0.0105) plus 1,024 output tokens (0.01536),
    // not for the same input fresh (0.045).
    for (const [cached, ok] of [
      [10_000, true],
      [0, false],
    ] as const) {
      const { db, conv: c } = await measured(cached);
      adjust(db, "anthropic", 95 - 0.04, undefined, NOW);
      expect(reserve(base(db, { conv: c })).ok).toBe(ok);
    }
  });

  test('cache_ttl "1h" uses the 1-hour write price and the 1-hour TTL', async () => {
    const { db, conv: c } = await measured();
    const limits: Limits = { ...DEFAULT_LIMITS, cache_ttl: "1h" };
    const old = { ...c, lastRequestAt: NOW.getTime() - 30 * 60_000 };
    expect(inputUsd(db, { limits, conv: old })).toBeCloseTo(
      WARM - (2_000 * 3.75 - 2_000 * 6) / 1e6,
      12,
    );
    const { db: never, conv: c0 } = await measured(0);
    expect(inputUsd(never, { limits, conv: c0 })).toBeCloseTo((12_000 * 6) / 1e6, 12);
  });

  test("a partly cached request: only what it cached gets the read rate", async () => {
    // 2,000 cached and 8,000 not: 2,000 at 0.3, the other 10,000 at 3.75.
    const { db, conv: c } = await measured(2_000);
    expect(inputUsd(db, { conv: c })).toBeCloseTo((2_000 * 0.3 + 10_000 * 3.75) / 1e6, 12);
    adjust(db, "anthropic", 95 - 0.04, undefined, NOW);
    expect(reserve(base(db, { conv: c })).ok).toBe(false);
  });

  test("the cache lifetime counts from when the last request was sent, not when it ended", async () => {
    // Sent 301 s ago; its answer ended 2 s ago.
    const sentAt = new Date(NOW.getTime() - 301_000);
    const { db, conv: c } = await measured(10_000, sentAt);
    expect(c.lastRequestAt).toBe(sentAt.getTime());
    expect(inputUsd(db, { conv: c })).toBeCloseTo(COLD, 12);
  });

  test("a model with output at 75 is capped below 16,000, not refused", async () => {
    const { db } = await agentDb();
    const pricey = { ...MODEL, price: { ...MODEL.price, output: 75 } };
    const r = reserve(base(db, { model: pricey, conv: undefined, estInput: 1000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.capped).toBe(true);
    expect(r.maxTokens).toBe(Math.floor(((1 - (1000 * 3.75) / 1e6) * 1e6) / 75));
    expect(r.maxTokens).toBeLessThan(16000);
  });

  test("enough room: the full output and not capped", async () => {
    const { db, conv: c } = await measured();
    expect(reserve(base(db, { conv: c }))).toEqual({
      ok: true,
      maxTokens: 16000,
      inputUsd: WARM,
      capped: false,
    });
  });

  test("other spend brings each provider cap closer", async () => {
    const { db } = await agentDb();
    expect(reserve(base(db, { conv: undefined })).ok).toBe(true);
    expect(reserve(base(db, { conv: undefined, other: { period: 94.99, today: 0 } }))).toEqual({
      ok: false,
      reason: "budget_stopped",
    });
    expect(reserve(base(db, { conv: undefined, other: { period: 0, today: 9.99 } }))).toEqual({
      ok: false,
      reason: "daily_cap",
    });
  });

  test("an extra cap that is the tightest names the refusal", async () => {
    const { db } = await agentDb();
    const r = reserve({ ...base(db, { conv: undefined }), extraCaps: [["wiki_daily_cap", 0.01]] });
    expect(r).toEqual({ ok: false, reason: "wiki_daily_cap" });
    const roomy = reserve({ ...base(db, { conv: undefined }), extraCaps: [["wiki_daily_cap", 5]] });
    expect(roomy.ok).toBe(true);
  });

  test('a "sync" job ignores a warm cache and the per-turn cap', async () => {
    const { db, conv: c } = await measured();
    expect(inputUsd(db, { conv: c, turnKind: "sync" })).toBeCloseTo(COLD, 12);
    const turn = seedTurn(db);
    spend(db, turn, 0.999);
    expect(reserve(base(db, { conv: c, turnKind: "sync", turnId: turn.turnId })).ok).toBe(true);
  });

  test("exactOutput refuses when only half the output is affordable, instead of lowering it", async () => {
    const { db } = await agentDb();
    // Room for the cold input (0.045) and 8,000 of the 16,000 output tokens (0.12).
    adjust(db, "anthropic", 95 - 0.165, undefined, NOW);
    const lowered = reserve(base(db, { conv: undefined }));
    expect(lowered.ok && lowered.capped).toBe(true);
    expect(reserve(base(db, { conv: undefined, exactOutput: true }))).toEqual({
      ok: false,
      reason: "budget_stopped",
    });
  });

  test("leaving the three new fields out gives the same result as their neutral values", async () => {
    const { db, conv: c } = await measured();
    const plain = base(db, { conv: c });
    expect(
      reserve({ ...plain, other: { period: 0, today: 0 }, extraCaps: [], exactOutput: false }),
    ).toEqual(reserve(plain));
  });

  test("past the context stop line: conv_too_long", async () => {
    const { db } = await agentDb();
    const window = Math.min(MODEL.contextWindow, DEFAULT_LIMITS.max_input_tokens);
    const line = window * DEFAULT_LIMITS.context_stop_ratio;
    expect(reserve(base(db, { estInput: line })).ok).toBe(true);
    expect(reserve(base(db, { estInput: line + 1 }))).toEqual({
      ok: false,
      reason: "conv_too_long",
    });
  });

  test("the smallest headroom names the refusal", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    // turn: 1 - 0.995 leaves under 1,024 output tokens at 15 USD/M.
    spend(db, turn, 0.995);
    expect(reserve(base(db, { turnId: turn.turnId }))).toEqual({ ok: false, reason: "turn_cap" });
    // A compaction turn is not held to the per-turn cap.
    expect(reserve(base(db, { turnId: turn.turnId, turnKind: "compaction" })).ok).toBe(true);

    const other = seedTurn(db);
    spend(db, other, 9); // today 9.995 of 10
    expect(reserve(base(db, { turnId: undefined }))).toEqual({ ok: false, reason: "daily_cap" });

    const { db: db2 } = await agentDb();
    spend(db2, seedTurn(db2), 94.99, new Date("2026-11-02T00:00:00Z"));
    expect(reserve(base(db2))).toEqual({ ok: false, reason: "budget_stopped" });
  });
});

describe("recording a request", () => {
  async function reserved(over: { maxTokens?: number; inputUsd?: number } = {}) {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    const usageId = insertReserved(db, {
      ...turn,
      step: 1,
      attempt: 1,
      model: MODEL,
      cacheTtl: "5m",
      maxTokens: over.maxTokens ?? 2000,
      inputUsd: over.inputUsd ?? 0.04,
      now: NOW,
    });
    return { db, turn, usageId };
  }
  const usage: Usage = {
    uncachedInputTokens: 1000,
    cacheReadTokens: 2000,
    cacheWriteTokens: 3000,
    outputTokens: 400,
    thinkingTokens: 100,
  };
  const tableCost = (1000 * 3 + 3000 * 3.75 + 2000 * 0.3 + 400 * 15) / 1e6;

  test("insertReserved: reserved_usd = input + max_tokens × output, and a price snapshot", async () => {
    const { db, turn, usageId } = await reserved();
    const r = row(db, usageId);
    expect(r.state).toBe("reserved");
    expect(r.cost_source).toBe("reserved");
    expect(r.reserved_usd).toBeCloseTo(0.04 + (2000 * 15) / 1e6, 12);
    expect(r.cost_usd).toBe(r.reserved_usd as number);
    expect(r.day).toBe("2026-11-19");
    expect(r.month).toBe("2026-11");
    expect(JSON.parse(r.price as string)).toEqual({
      ...MODEL.price,
      pricedAt: "2026-11-19",
      cacheTtl: "5m",
    });
    expect(turnCost(db, turn.turnId)).toBe(r.reserved_usd as number);
  });

  test("recordStart: actual input plus the output still reserved", async () => {
    const { db, turn, usageId } = await reserved();
    recordStart(db, usageId, {
      uncachedInputTokens: 1000,
      cacheReadTokens: 2000,
      cacheWriteTokens: 3000,
    });
    const expected = (1000 * 3 + 3000 * 3.75 + 2000 * 0.3) / 1e6 + (2000 * 15) / 1e6;
    expect(row(db, usageId).cost_usd).toBeCloseTo(expected, 12);
    expect(turnCost(db, turn.turnId)).toBeCloseTo(expected, 12);
  });

  test("recordEnd from the table; a chat request becomes the conversation's baseline", async () => {
    const { db, turn, usageId } = await reserved();
    recordEnd(db, { usageId, usage, turnKind: "chat", prefixKey: "pk" });
    const r = row(db, usageId);
    expect([r.state, r.cost_source, r.output_tokens, r.thinking_tokens]).toEqual([
      "final",
      "table",
      400,
      100,
    ]);
    expect(r.cost_usd).toBeCloseTo(tableCost, 12);
    expect(turnCost(db, turn.turnId)).toBeCloseTo(tableCost, 12);
    const c = getConversation(db, turn.convId);
    expect([c.lastTotalInputTokens, c.lastRequestAt, c.lastPrefixKey]).toEqual([
      6000,
      NOW.getTime(),
      "pk",
    ]);
  });

  test("recordEnd with the provider's own cost; a compaction request leaves the baseline", async () => {
    const { db, turn, usageId } = await reserved();
    recordEnd(db, {
      usageId,
      usage,
      costUsd: 0.5,
      turnKind: "compaction",
      prefixKey: "pk",
    });
    expect([row(db, usageId).cost_usd, row(db, usageId).cost_source]).toEqual([0.5, "provider"]);
    const c = getConversation(db, turn.convId);
    expect([c.lastTotalInputTokens, c.lastRequestAt, c.lastPrefixKey]).toEqual([0, null, null]);
  });

  test("failure with a status and no start: voided, nothing charged", async () => {
    const { db, turn, usageId } = await reserved();
    expect(recordFailure(db, { usageId, status: 529, receivedStart: false, textBytes: 0 })).toBe(
      "voided",
    );
    const r = row(db, usageId);
    expect([r.state, r.cost_usd, r.cost_source]).toEqual(["voided", 0, "none"]);
    expect(turnCost(db, turn.turnId)).toBe(0);
  });

  test("failure after start: actual input plus the output estimated from the text", async () => {
    const { db, usageId } = await reserved();
    recordStart(db, usageId, {
      uncachedInputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(recordFailure(db, { usageId, status: 529, receivedStart: true, textBytes: 301 })).toBe(
      "estimated",
    );
    const r = row(db, usageId);
    expect([r.state, r.cost_source, r.output_tokens]).toEqual(["estimated", "estimate", 151]);
    expect(r.cost_usd).toBeCloseTo((1000 * 3 + 151 * 15) / 1e6, 12);
  });

  test("failure with neither status nor start: the reserved input, no output", async () => {
    const { db, usageId } = await reserved({ inputUsd: 0.07 });
    expect(recordFailure(db, { usageId, receivedStart: false, textBytes: 0 })).toBe("estimated");
    const r = row(db, usageId);
    expect([r.state, r.cost_source, r.output_tokens]).toEqual(["estimated", "estimate", 0]);
    expect(r.cost_usd).toBeCloseTo(0.07, 12);
  });

  test.each([
    ["recordStart", (db: Database, id: number) => recordStart(db, id, usage)],
    [
      "recordFailure",
      (db: Database, id: number) =>
        recordFailure(db, { usageId: id, receivedStart: false, textBytes: 0 }),
    ],
    [
      "recordEnd",
      (db: Database, id: number) =>
        recordEnd(db, { usageId: id, usage, turnKind: "chat", prefixKey: "k" }),
    ],
  ])("%s: a failed turn total rolls the usage row back too", async (_, write) => {
    const { db, usageId } = await reserved();
    const before = row(db, usageId);
    db.run(
      "CREATE TRIGGER no_turn_update BEFORE UPDATE OF cost_usd ON turns BEGIN SELECT RAISE(ABORT, 'turns locked'); END",
    );
    expect(() => write(db, usageId)).toThrow("turns locked");
    expect(row(db, usageId)).toEqual(before);
  });

  test("turns.cost_usd stays the sum of the turn's rows", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    const a = inFlight(db, turn, 0.2);
    const b = inFlight(db, turn, 0.3);
    recordEnd(db, { usageId: a, usage, turnKind: "chat", prefixKey: "k" });
    recordFailure(db, { usageId: b, status: 500, receivedStart: false, textBytes: 0 });
    const sum = (
      db.query("SELECT SUM(cost_usd) AS s FROM usage WHERE turn_id = ?").get(turn.turnId) as {
        s: number;
      }
    ).s;
    expect(turnCost(db, turn.turnId)).toBeCloseTo(sum, 12);
    expect(sum).toBeCloseTo(tableCost, 12);
  });
});

describe("the recording functions on wiki.db", () => {
  test("reserve, start, end, failure and settleReserved keep a sync job's total", async () => {
    const db = await openWikiDb(isolatedPaths());
    db.run("INSERT INTO runs (id, state, model, started_at) VALUES ('r1', 'running', 'm', ?)", [
      NOW.getTime(),
    ]);
    db.run(
      "INSERT INTO turns (id, conv_id, kind, state, started_at) VALUES ('j1', 'r1', 'extract', 'running', ?)",
      [NOW.getTime()],
    );
    const job = { convId: "r1", turnId: "j1" };
    const ended = inFlight(db, job, 2);
    expect(turnCost(db, "j1")).toBe(2);
    recordStart(db, ended, { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(turnCost(db, "j1")).toBeCloseTo(0.003, 12);
    recordEnd(db, {
      usageId: ended,
      usage: { ...ZERO_USAGE, uncachedInputTokens: 1000, outputTokens: 100 },
      turnKind: "compaction",
      prefixKey: "",
    });
    expect(row(db, ended).state).toBe("final");
    const failed = inFlight(db, job, 5);
    recordFailure(db, { usageId: failed, status: 500, receivedStart: false, textBytes: 0 });
    expect(row(db, failed).state).toBe("voided");
    inFlight(db, job, 1);
    expect(settleReserved(db)).toEqual(["j1"]);
    expect(turnCost(db, "j1")).toBeCloseTo(0.0045 + 1, 12);
    expect(reconcileLedger(db, NOW)).toEqual({ usage: 0, turns: 1 });
    expect(db.query("SELECT state FROM turns WHERE id = 'j1'").get()).toEqual({
      state: "interrupted",
    });
    db.close();
  });
});

describe("limitReached", () => {
  const check = (db: Database, turnId: string) =>
    limitReached(db, {
      provider: "anthropic",
      cfg: PROVIDER,
      limits: DEFAULT_LIMITS,
      turnId,
      now: NOW,
    });

  test("nothing reached: null", async () => {
    const { db } = await agentDb();
    expect(check(db, seedTurn(db).turnId)).toBeNull();
  });

  test("each line is reached at exactly its amount", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    spend(db, turn, 1);
    expect(check(db, turn.turnId)).toBe("turn_cap");
    spend(db, seedTurn(db), 9);
    expect(check(db, turn.turnId)).toBe("daily_cap");
    spend(db, seedTurn(db), 85, new Date("2026-11-02T00:00:00Z"));
    expect(check(db, turn.turnId)).toBe("budget_stopped");
  });
});

describe("status", () => {
  test("no database: nothing spent (prior spend for total)", () => {
    expect(status(undefined, "anthropic", PROVIDER, NOW)).toEqual({
      provider: "anthropic",
      period: "utc-month",
      spentUsd: 0,
      quotaUsd: 100,
      warnUsd: 80,
      stopUsd: 95,
      todayUsd: 0,
      dailyCapUsd: 10,
      state: "ok",
    });
    const total = { ...PROVIDER, period: "total" as const, prior_spend_usd: 4 };
    expect(status(undefined, "anthropic", total, NOW).spentUsd).toBe(4);
  });

  test.each([
    [79.99, "ok"],
    [80, "warn"],
    [95, "stopped"],
  ])("spent %d is %s", async (amount, state) => {
    const { db } = await agentDb();
    adjust(db, "anthropic", amount, undefined, NOW);
    expect(status(db, "anthropic", PROVIDER, NOW).state).toBe(state as "ok");
  });
});

describe("recentRequests", () => {
  test("newest first, at most the count; none without a database", async () => {
    const { db } = await agentDb();
    const turn = seedTurn(db);
    spend(db, turn, 1, new Date("2026-11-19T10:00:00Z"));
    spend(db, turn, 2, new Date("2026-11-19T11:00:00Z"));
    spend(db, turn, 3, new Date("2026-11-19T09:00:00Z"));
    const recent = recentRequests(db, 2);
    expect(recent.map((r) => r.costUsd)).toEqual([2, 1]);
    expect(Object.keys(recent[0] as object).toSorted()).toEqual(
      [
        "at",
        "model",
        "state",
        "costUsd",
        "costSource",
        "uncachedInputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "outputTokens",
        "thinkingTokens",
      ].toSorted(),
    );
    expect(recentRequests(undefined, 20)).toEqual([]);
  });
});

describe("usage the response never gave", () => {
  // Input reserved at 0.2 USD, a 1,000-token output limit at 15 USD per million: 0.015 more.
  const reserved = (db: Database) =>
    insertReserved(db, {
      ...seedTurn(db),
      step: ++step,
      attempt: 1,
      model: MODEL,
      cacheTtl: "5m",
      maxTokens: 1000,
      inputUsd: 0.2,
      now: NOW,
    });
  // 200 bytes of text: 100 tokens, 0.0015 USD.
  const TEXT = 200;
  const cost = (db: Database, id: number) => row(db, id).cost_usd as number;

  test("an HTTP status before start: voided, 0", async () => {
    const { db } = await agentDb();
    const id = reserved(db);
    expect(
      recordFailure(db, { usageId: id, status: 500, receivedStart: false, textBytes: 0 }),
    ).toBe("voided");
    expect(cost(db, id)).toBe(0);
  });

  test("input known: the input start reported, plus the text's output", async () => {
    const { db } = await agentDb();
    const id = reserved(db);
    recordStart(db, id, { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    recordFailure(db, { usageId: id, receivedStart: true, textBytes: TEXT });
    expect(row(db, id).state).toBe("estimated");
    expect(cost(db, id)).toBeCloseTo(0.003 + 0.0015, 10);
  });

  test("started, input unknown, no reasoning: the reserved input plus the text's output", async () => {
    const { db } = await agentDb();
    const id = reserved(db);
    recordFailure(db, {
      usageId: id,
      receivedStart: true,
      textBytes: TEXT,
      inputKnown: false,
      reasoning: false,
    });
    expect(row(db, id)).toMatchObject({ state: "estimated", cost_source: "estimate" });
    expect(cost(db, id)).toBeCloseTo(0.2 + 0.0015, 10);
  });

  test("started, input unknown, reasoning: the whole reservation, output at the limit", async () => {
    const { db } = await agentDb();
    const id = reserved(db);
    recordFailure(db, {
      usageId: id,
      receivedStart: true,
      textBytes: TEXT,
      inputKnown: false,
      reasoning: true,
    });
    expect(row(db, id)).toMatchObject({ state: "estimated", output_tokens: 1000 });
    expect(cost(db, id)).toBeCloseTo(0.215, 10);
  });

  test("nothing at all: the reserved input", async () => {
    const { db } = await agentDb();
    const id = reserved(db);
    recordFailure(db, { usageId: id, receivedStart: false, textBytes: TEXT });
    expect(cost(db, id)).toBeCloseTo(0.2, 10);
  });

  test("recordEstimatedEnd: the text's output, or the limit when the request reasoned", async () => {
    const { db } = await agentDb();
    const plain = reserved(db);
    recordEstimatedEnd(db, { usageId: plain, textBytes: TEXT, reasoning: false });
    expect(row(db, plain)).toMatchObject({ state: "estimated", cost_source: "estimate" });
    expect(cost(db, plain)).toBeCloseTo(0.2015, 10);
    const thought = reserved(db);
    recordEstimatedEnd(db, { usageId: thought, textBytes: TEXT, reasoning: true });
    expect(cost(db, thought)).toBeCloseTo(0.215, 10);
  });
});
