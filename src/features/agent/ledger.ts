import type { Database } from "bun:sqlite";
import type { Provider } from "../../core/secrets.ts";
import { utcDay, type Price, type ResolvedModel } from "./catalog.ts";
import type { Limits, ProviderConfig } from "./config.ts";
import { estimateTokens } from "./bytes.ts";
import type { Conversation } from "./store.ts";
import {
  totalInputTokens,
  type BudgetReason,
  type CacheTtl,
  type InputUsage,
  type TurnKind,
  type Usage,
} from "./types.ts";

// Everything here is computed from the database at the time asked; nothing is kept in memory,
// so a `tars cost adjust` from another terminal counts at the next reservation.

const MIN_OUTPUT = 1024;
const SAFETY = 1.2;
const TTL_MS: Record<CacheTtl, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

export type UsageState = "reserved" | "final" | "estimated" | "voided";

/** The price snapshot a usage row keeps, so its cost can be redone from the row alone. */
export interface PriceSnapshot extends Price {
  readonly pricedAt: string;
  readonly cacheTtl: CacheTtl;
}

const month = (now: Date) => utcDay(now).slice(0, 7);
const sum = (db: Database, sql: string, ...params: (string | number)[]) =>
  (
    db.query(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE ${sql}`).get(...params) as {
      s: number;
    }
  ).s;

/**
 * This period's spend: the last adjustment plus usage it does not cover, or all usage (+ prior
 * spend). One read transaction, so the schema probe and both tables come from the same snapshot;
 * inside a caller's transaction Bun makes it a savepoint.
 */
export const spent = (db: Database, provider: Provider, cfg: ProviderConfig, now: Date): number =>
  db.transaction(() => readSpent(db, provider, cfg, now)).deferred();

export interface Adjustment {
  readonly spentUsd: number;
  readonly at: number;
  /** null on a version 1 database, whose adjustment covers usage by time. */
  readonly usageUpto: number | null;
  readonly usagePending: readonly number[];
}

const scopeOf = (provider: Provider, cfg: ProviderConfig, now: Date) =>
  cfg.period === "utc-month"
    ? { scope: "provider = ?1 AND month = ?2", params: [provider, month(now)] }
    : { scope: "provider = ?1", params: [provider] };

/** The period's last `tars cost adjust`, or null. */
export function latestAdjustment(
  db: Database,
  provider: Provider,
  cfg: ProviderConfig,
  now: Date,
): Adjustment | null {
  const { scope, params } = scopeOf(provider, cfg, now);
  // A reader never migrates, so it may see version 1.
  const v1 =
    db.query("SELECT 1 FROM pragma_table_info('adjustments') WHERE name = 'usage_upto'").get() ===
    null;
  const adj = db
    .query(
      `SELECT spent_usd, at${v1 ? "" : ", usage_upto, usage_pending"} FROM adjustments
       WHERE ${scope} ORDER BY id DESC LIMIT 1`,
    )
    .get(...params) as {
    spent_usd: number;
    at: number;
    usage_upto?: number;
    usage_pending?: string;
  } | null;
  if (adj === null) return null;
  return {
    spentUsd: adj.spent_usd,
    at: adj.at,
    usageUpto: adj.usage_upto ?? null,
    usagePending: JSON.parse(adj.usage_pending ?? "[]") as number[],
  };
}

function readSpent(db: Database, provider: Provider, cfg: ProviderConfig, now: Date): number {
  const { scope, params } = scopeOf(provider, cfg, now);
  const adj = latestAdjustment(db, provider, cfg, now);
  if (adj === null)
    return sum(db, scope, ...params) + (cfg.period === "utc-month" ? 0 : cfg.prior_spend_usd);
  const n = params.length;
  return adj.usageUpto === null
    ? adj.spentUsd + sum(db, `${scope} AND at > ?${n + 1}`, ...params, adj.at)
    : adj.spentUsd +
        sum(
          db,
          `${scope} AND (id > ?${n + 1} OR id IN (SELECT value FROM json_each(?${n + 2})))`,
          ...params,
          adj.usageUpto,
          JSON.stringify(adj.usagePending),
        );
}

/** Today's (UTC) usage; an adjustment corrects the period's total, not any one day. */
export const spentToday = (db: Database, provider: Provider, now: Date) =>
  sum(db, "provider = ? AND day = ?", provider, utcDay(now));

export const turnSpent = (db: Database, turnId: string) => sum(db, "turn_id = ?", turnId);
export const usageCost = (db: Database, usageId: number) => sum(db, "id = ?", usageId);

/**
 * Input tokens for the next request. With a measured total from the last request under the same
 * prefix, that plus the new bytes; without one (a new or just-compacted conversation, or a
 * changed prefix) the whole prompt's bytes.
 */
export function estimateInput(s: {
  fullBytes: number;
  newBytes: number;
  lastTotal: number;
}): number {
  const base =
    s.lastTotal > 0 ? s.lastTotal + estimateTokens(s.newBytes) : estimateTokens(s.fullBytes);
  return Math.ceil(base * SAFETY);
}

export const cacheWritePrice = (price: Price, ttl: CacheTtl) =>
  ttl === "1h" ? (price.cacheWrite1h ?? price.cacheWrite) : price.cacheWrite;

export const effectiveWindow = (model: ResolvedModel, limits: Limits) =>
  Math.min(model.contextWindow, limits.max_input_tokens);

export interface ReserveInput {
  readonly db: Database;
  readonly provider: ProviderConfig;
  readonly limits: Limits;
  readonly model: ResolvedModel;
  readonly conv: Pick<Conversation, "id" | "lastRequestAt" | "lastPrefixKey"> | undefined;
  readonly prefixKey: string;
  readonly estInput: number;
  readonly turnId: string | undefined;
  readonly turnKind: TurnKind;
  /** Upper bound on the output, before the budget lowers it. */
  readonly maxOutput: number;
  readonly now: Date;
}

export type Reservation =
  | {
      readonly ok: true;
      readonly maxTokens: number;
      readonly inputUsd: number;
      readonly capped: boolean;
    }
  | { readonly ok: false; readonly reason: BudgetReason | "conv_too_long" };

/**
 * The tokens the conversation's last measured chat request read from or wrote to the cache:
 * only those can be read next time. Below the provider's minimum cacheable length nothing is
 * cached, and the part after the last breakpoint never is.
 */
function lastCachedTokens(db: Database, convId: string): number {
  const row = db
    .query(
      `SELECT u.cache_read_tokens + u.cache_write_tokens AS n FROM usage u
       JOIN turns t ON t.id = u.turn_id
       WHERE u.conv_id = ? AND u.state = 'final' AND t.kind = 'chat' ORDER BY u.id DESC LIMIT 1`,
    )
    .get(convId) as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * Prices the next request before it is sent. Input still in a warm cache is priced at the read
 * rate; the rest at the dearer of input and cache write. The output limit shrinks to what the
 * tightest of the three budgets can pay, instead of refusing outright. A compaction turn is not
 * held to the per-turn cap: it happens when the context is nearly full, and refusing it would
 * leave the conversation too long to continue and too dear to shorten.
 */
export function reserve(r: ReserveInput): Reservation {
  const { limits, model, provider: cfg, now } = r;
  if (r.estInput > effectiveWindow(model, limits) * limits.context_stop_ratio)
    return { ok: false, reason: "conv_too_long" };
  const price = model.price;
  const conv = r.conv;
  const warm =
    r.turnKind === "chat" &&
    conv !== undefined &&
    conv.lastPrefixKey === r.prefixKey &&
    conv.lastRequestAt !== null &&
    // A clock that went back leaves the age unknown: price it as fresh.
    now.getTime() >= conv.lastRequestAt &&
    now.getTime() - conv.lastRequestAt < TTL_MS[limits.cache_ttl];
  const cached = warm ? Math.min(lastCachedTokens(r.db, conv.id), r.estInput) : 0;
  const fresh = r.estInput - cached;
  const inputUsd =
    (cached * price.cacheRead +
      fresh * Math.max(price.input, cacheWritePrice(price, limits.cache_ttl))) /
    1e6;
  const caps: [BudgetReason, number][] = [
    ["budget_stopped", cfg.quota_usd * cfg.stop_ratio - spent(r.db, model.provider, cfg, now)],
    ["daily_cap", cfg.daily_cap_usd - spentToday(r.db, model.provider, now)],
  ];
  if (r.turnKind === "chat")
    caps.push([
      "turn_cap",
      limits.turn_cap_usd - (r.turnId === undefined ? 0 : turnSpent(r.db, r.turnId)),
    ]);
  const [tightest, room] = caps.reduce((a, b) => (b[1] < a[1] ? b : a));
  const headroom = room - inputUsd;
  const affordable =
    price.output > 0 ? Math.floor((headroom * 1e6) / price.output) : headroom >= 0 ? Infinity : -1;
  if (affordable < MIN_OUTPUT) return { ok: false, reason: tightest };
  const maxTokens = Math.min(r.maxOutput, affordable);
  return { ok: true, maxTokens, inputUsd, capped: maxTokens < r.maxOutput };
}

export function insertReserved(
  db: Database,
  u: {
    turnId: string;
    convId: string;
    step: number;
    attempt: number;
    model: ResolvedModel;
    cacheTtl: CacheTtl;
    maxTokens: number;
    inputUsd: number;
    now: Date;
  },
): number {
  const reserved = u.inputUsd + (u.maxTokens * u.model.price.output) / 1e6;
  const snapshot: PriceSnapshot = {
    ...u.model.price,
    pricedAt: u.model.pricedAt,
    cacheTtl: u.cacheTtl,
  };
  const insert = db.query(
    `INSERT INTO usage (turn_id, conv_id, step, attempt, provider, model, state, reserved_usd,
         max_tokens, cost_usd, cost_source, price, at, day, month)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, 'reserved', ?, ?, ?, ?) RETURNING id`,
  );
  return withTurnCost(db, u.turnId, () => {
    const row = insert.get(
      u.turnId,
      u.convId,
      u.step,
      u.attempt,
      u.model.provider,
      u.model.id,
      reserved,
      u.maxTokens,
      reserved,
      JSON.stringify(snapshot),
      u.now.getTime(),
      utcDay(u.now),
      month(u.now),
    ) as { id: number };
    return row.id;
  });
}

interface UsageRow {
  id: number;
  turn_id: string;
  conv_id: string;
  state: UsageState;
  reserved_usd: number;
  max_tokens: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  price: string;
  at: number;
}

const usageRow = (db: Database, id: number) =>
  db.query("SELECT * FROM usage WHERE id = ?").get(id) as UsageRow;

const inputUsd = (u: InputUsage, p: PriceSnapshot) =>
  (u.uncachedInputTokens * p.input +
    u.cacheWriteTokens * cacheWritePrice(p, p.cacheTtl) +
    u.cacheReadTokens * p.cacheRead) /
  1e6;

const rowInput = (r: UsageRow): InputUsage => ({
  uncachedInputTokens: r.uncached_input_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
});

/** turns.cost_usd always equals the sum of its usage rows. */
export function syncTurnCost(db: Database, turnId: string): void {
  db.run(
    "UPDATE turns SET cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE turn_id = ?1) WHERE id = ?1",
    [turnId],
  );
}

/** A usage write and the turn total it changes commit together or not at all. */
function withTurnCost<T>(db: Database, turnId: string, write: () => T): T {
  return db.transaction(() => {
    const out = write();
    syncTurnCost(db, turnId);
    return out;
  })();
}

/** start arrived: the input is known; the output stays at its reservation. */
export function recordStart(db: Database, usageId: number, usage: InputUsage): void {
  const row = usageRow(db, usageId);
  const price = JSON.parse(row.price) as PriceSnapshot;
  const cost = inputUsd(usage, price) + (row.max_tokens * price.output) / 1e6;
  withTurnCost(db, row.turn_id, () =>
    db.run(
      `UPDATE usage SET uncached_input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?
       WHERE id = ?`,
      [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, cost, usageId],
    ),
  );
}

/**
 * end arrived: the row is final, priced by the table or by the provider's own figure. A chat
 * request also becomes the conversation's measured baseline; a summary request's input is not
 * the conversation's context, so compaction resets the baseline itself.
 */
export function recordEnd(
  db: Database,
  e: {
    usageId: number;
    usage: Usage;
    costUsd?: number;
    turnKind: TurnKind;
    prefixKey: string;
  },
): void {
  const row = usageRow(db, e.usageId);
  const price = JSON.parse(row.price) as PriceSnapshot;
  const table = inputUsd(e.usage, price) + (e.usage.outputTokens * price.output) / 1e6;
  const u = e.usage;
  withTurnCost(db, row.turn_id, () => {
    db.run(
      `UPDATE usage SET state = 'final', uncached_input_tokens = ?, cache_read_tokens = ?,
         cache_write_tokens = ?, output_tokens = ?, thinking_tokens = ?, cost_usd = ?, cost_source = ?
       WHERE id = ?`,
      [
        u.uncachedInputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.outputTokens,
        u.thinkingTokens,
        e.costUsd ?? table,
        e.costUsd === undefined ? "table" : "provider",
        e.usageId,
      ],
    );
    // The cache lifetime runs from when the request was sent, and `at` is set just before that.
    if (e.turnKind === "chat")
      db.run(
        "UPDATE conversations SET last_total_input_tokens = ?, last_request_at = ?, last_prefix_key = ? WHERE id = ?",
        [totalInputTokens(u), row.at, e.prefixKey, row.conv_id],
      );
  });
}

/**
 * A request that failed or was aborted. A provider that answered with a status before any
 * start refused it and charged nothing. Otherwise it may have run: a known input is kept and
 * the output is estimated from the text that arrived; an unknown input stays at its reservation.
 */
export function recordFailure(
  db: Database,
  f: { usageId: number; status?: number; receivedStart: boolean; textBytes: number },
): UsageState {
  const row = usageRow(db, f.usageId);
  const price = JSON.parse(row.price) as PriceSnapshot;
  let state: UsageState;
  let cost: number;
  let outputTokens = 0;
  if (f.status !== undefined && !f.receivedStart) {
    state = "voided";
    cost = 0;
  } else if (f.receivedStart) {
    state = "estimated";
    outputTokens = estimateTokens(f.textBytes);
    cost = inputUsd(rowInput(row), price) + (outputTokens * price.output) / 1e6;
  } else {
    state = "estimated";
    cost = row.reserved_usd - (row.max_tokens * price.output) / 1e6;
  }
  withTurnCost(db, row.turn_id, () =>
    db.run(
      "UPDATE usage SET state = ?, output_tokens = ?, cost_usd = ?, cost_source = ? WHERE id = ?",
      [state, outputTokens, cost, state === "voided" ? "none" : "estimate", f.usageId],
    ),
  );
  return state;
}

/** Reconcile: a reservation left by a dead process keeps its reserved amount as an estimate. */
export function settleReserved(db: Database): string[] {
  const turns = (
    db.query("SELECT DISTINCT turn_id FROM usage WHERE state = 'reserved'").all() as {
      turn_id: string;
    }[]
  ).map((r) => r.turn_id);
  db.run("UPDATE usage SET state = 'estimated', cost_source = 'estimate' WHERE state = 'reserved'");
  for (const t of turns) syncTurnCost(db, t);
  return turns;
}

/**
 * After a dead process: reserved usage becomes estimated, and a running turn (a chat turn, or a
 * sync job) becomes interrupted with its total caught up to its usage rows.
 */
export function reconcileLedger(db: Database, now: Date): { usage: number; turns: number } {
  const usage = settleReserved(db).length;
  const running = db.query("SELECT id FROM turns WHERE state = 'running'").all() as {
    id: string;
  }[];
  for (const t of running) syncTurnCost(db, t.id);
  const turns = db.run(
    "UPDATE turns SET state = 'interrupted', ended_at = ? WHERE state = 'running'",
    [now.getTime()],
  ).changes;
  return { usage, turns };
}

/** Before a tool runs: the first budget line already reached, or null. */
export function limitReached(
  db: Database,
  s: { provider: Provider; cfg: ProviderConfig; limits: Limits; turnId: string; now: Date },
): BudgetReason | null {
  if (spent(db, s.provider, s.cfg, s.now) >= s.cfg.quota_usd * s.cfg.stop_ratio)
    return "budget_stopped";
  if (spentToday(db, s.provider, s.now) >= s.cfg.daily_cap_usd) return "daily_cap";
  if (turnSpent(db, s.turnId) >= s.limits.turn_cap_usd) return "turn_cap";
  return null;
}

export interface BudgetStatus {
  readonly provider: Provider;
  readonly period: ProviderConfig["period"];
  readonly spentUsd: number;
  readonly quotaUsd: number;
  readonly warnUsd: number;
  readonly stopUsd: number;
  readonly todayUsd: number;
  readonly dailyCapUsd: number;
  readonly state: "ok" | "warn" | "stopped";
}

/** db undefined: no database yet, so nothing spent. */
export function status(
  db: Database | undefined,
  provider: Provider,
  cfg: ProviderConfig,
  now: Date,
): BudgetStatus {
  const spentUsd =
    db === undefined
      ? cfg.period === "total"
        ? cfg.prior_spend_usd
        : 0
      : spent(db, provider, cfg, now);
  const warnUsd = cfg.quota_usd * cfg.warn_ratio;
  const stopUsd = cfg.quota_usd * cfg.stop_ratio;
  return {
    provider,
    period: cfg.period,
    spentUsd,
    quotaUsd: cfg.quota_usd,
    warnUsd,
    stopUsd,
    todayUsd: db === undefined ? 0 : spentToday(db, provider, now),
    dailyCapUsd: cfg.daily_cap_usd,
    state: spentUsd >= stopUsd ? "stopped" : spentUsd >= warnUsd ? "warn" : "ok",
  };
}

/**
 * "Up to now, this period's spend is `spentUsd`", from the provider's own bill. It covers every
 * usage row recorded so far except those still reserved: a request in flight is not on the bill
 * yet, so its cost keeps counting on top of the figure.
 */
export function adjust(
  db: Database,
  provider: Provider,
  spentUsd: number,
  note: string | undefined,
  now: Date,
): void {
  db.transaction(() => {
    const { upto } = db.query("SELECT COALESCE(MAX(id), 0) AS upto FROM usage").get() as {
      upto: number;
    };
    const pending = db
      .query("SELECT id FROM usage WHERE provider = ? AND state = 'reserved'")
      .all(provider) as { id: number }[];
    db.run(
      `INSERT INTO adjustments (provider, at, month, spent_usd, note, usage_upto, usage_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        provider,
        now.getTime(),
        month(now),
        spentUsd,
        note ?? null,
        upto,
        JSON.stringify(pending.map((r) => r.id)),
      ],
    );
  }).immediate();
}

export interface RecentRequest {
  readonly at: number;
  readonly model: string;
  readonly state: UsageState;
  readonly costUsd: number;
  readonly costSource: string;
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
}

export function recentRequests(db: Database | undefined, count: number): RecentRequest[] {
  if (db === undefined) return [];
  return db
    .query(
      `SELECT at, model, state, cost_usd AS costUsd, cost_source AS costSource,
         uncached_input_tokens AS uncachedInputTokens, cache_read_tokens AS cacheReadTokens,
         cache_write_tokens AS cacheWriteTokens, output_tokens AS outputTokens,
         thinking_tokens AS thinkingTokens
       FROM usage ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(count) as RecentRequest[];
}
