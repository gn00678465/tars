import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { CONFIG_TEMPLATE, loadConfig } from "../../../src/features/agent/config.ts";
import { adjust, spent } from "../../../src/features/agent/ledger.ts";
import type { Log, LogEvent, LogFields } from "../../../src/features/agent/log.ts";
import {
  fetchKeyLimit,
  reconcileAfterTurn,
  reconcileOpenRouter,
  resetReconcileWarnings,
  type ReconcileDeps,
} from "../../../src/features/agent/openrouter-key.ts";
import { E2E_BASE_URL_VARS } from "../../../src/features/agent/provider.ts";
import { compatHarness, type CompatHarness } from "./compat-fixture.ts";

let h: CompatHarness | undefined;
beforeEach(() => resetReconcileWarnings());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

interface Run {
  readonly warnings: string[];
  readonly logs: [LogEvent, LogFields][];
  readonly deps: ReconcileDeps;
}

async function setup(): Promise<CompatHarness & { run: () => Run }> {
  h = await compatHarness();
  const harness = h;
  return Object.assign(harness, {
    run: (): Run => {
      const warnings: string[] = [];
      const logs: [LogEvent, LogFields][] = [];
      const log: Log = { log: (e, f) => void logs.push([e, f]) };
      return {
        warnings,
        logs,
        deps: {
          db: harness.db,
          paths: harness.paths,
          env: harness.env,
          secrets: harness.secrets,
          now: () => harness.clock.now(),
          warn: (w) => void warnings.push(w),
          log,
        },
      };
    },
  });
}

const adjustments = (x: CompatHarness) =>
  x.db.query("SELECT provider, spent_usd, note FROM adjustments ORDER BY id").all() as {
    provider: string;
    spent_usd: number;
    note: string | null;
  }[];
const keyRequests = (x: CompatHarness) => x.openrouter.requests.filter((r) => r.path === "/key");
const OPENROUTER = { provider: "openrouter" } as const;

describe("reconciling against the key limit", () => {
  // The books start at 2 USD: one manual adjustment.
  async function booksAt2() {
    const x = await setup();
    adjust(x.db, "openrouter", 2, undefined, x.clock.now());
    return x;
  }

  test("the key shows 0.01 more used: an adjustment up to it", async () => {
    const x = await booksAt2();
    x.openrouter.key = { limit: 10, limit_remaining: 7.99 };
    const r = x.run();
    await reconcileAfterTurn(r.deps, OPENROUTER);
    expect(adjustments(x)[1]).toMatchObject({ provider: "openrouter", note: "auto: /key" });
    expect(adjustments(x)[1]?.spent_usd).toBeCloseTo(2.01, 10);
    expect(r.warnings).toEqual([]);
  });

  test("0.001 more: nothing written", async () => {
    const x = await booksAt2();
    x.openrouter.key = { limit: 10, limit_remaining: 7.999 };
    await reconcileAfterTurn(x.run().deps, OPENROUTER);
    expect(adjustments(x)).toHaveLength(1);
  });

  test("1.00 less: nothing written, one warning, none the second time", async () => {
    const x = await booksAt2();
    x.openrouter.key = { limit: 10, limit_remaining: 9 };
    const r = x.run();
    await reconcileAfterTurn(r.deps, OPENROUTER);
    await reconcileAfterTurn(r.deps, OPENROUTER);
    expect(adjustments(x)).toHaveLength(1);
    expect(r.warnings).toEqual([
      "本機的帳比 OpenRouter 的金鑰額度多 1.00 USD。確認後用 tars cost adjust openrouter --spent <金額> 修正",
    ]);
  });

  test("no limit on the key: nothing written, one warning", async () => {
    const x = await booksAt2();
    x.openrouter.key = { limit: null, limit_remaining: null };
    const r = x.run();
    await reconcileAfterTurn(r.deps, OPENROUTER);
    await reconcileAfterTurn(r.deps, OPENROUTER);
    expect(adjustments(x)).toHaveLength(1);
    expect(r.warnings).toEqual(["OpenRouter 的金鑰沒有設額度上限，本機的帳無法自動校正"]);
  });

  test.each([
    ["a shape not understood", { limit: "10", limit_remaining: 5 }],
    ["remaining above the limit", { limit: 10, limit_remaining: 11 }],
    ["a negative amount", { limit: 10, limit_remaining: -1 }],
    ["an HTTP error", 500],
  ] as const)("%s: nothing written", async (_, key) => {
    const x = await booksAt2();
    x.openrouter.key = key as never;
    const r = x.run();
    await reconcileAfterTurn(r.deps, OPENROUTER);
    expect(adjustments(x)).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  test("a /key that does not answer in time: undefined", async () => {
    const x = await setup();
    x.openrouter.key = "hang";
    expect(
      await fetchKeyLimit("or-test", x.openrouter.url, AbortSignal.timeout(50)),
    ).toBeUndefined();
  });
});

describe("a cost adjust from another terminal", () => {
  /**
   * The harness's connection, with `onWrite` run by another connection to the same file at one
   * point of the reconcile; that connection does not wait for a lock.
   */
  async function race(at: "first_lock" | "spend_read") {
    const x = await setup();
    const now = x.clock.now();
    adjust(x.db, "openrouter", 1, undefined, now);
    const cfg = (await loadConfig(x.paths)).config.providers.openrouter;
    if (cfg === undefined) throw new Error("no [providers.openrouter]");
    const other = new Database(x.paths.agentDb);
    other.exec("PRAGMA busy_timeout=0");
    let fired = false;
    let refused = false;
    const otherAdjusts = () => {
      if (fired) return;
      fired = true;
      try {
        adjust(other, "openrouter", 9, "other terminal", now);
      } catch {
        refused = true;
      }
    };
    const db = new Proxy(x.db, {
      get(target, prop) {
        if (prop === "query" && at === "spend_read")
          return (sql: string) => {
            if (sql.includes("SUM(cost_usd)")) otherAdjusts();
            return target.query(sql);
          };
        if (prop === "transaction" && at === "first_lock")
          return (fn: () => unknown) => {
            const tx = target.transaction(fn);
            return Object.assign((...a: []) => tx(...a), {
              deferred: tx.deferred,
              exclusive: tx.exclusive,
              immediate: (...a: []) => {
                otherAdjusts();
                return tx.immediate(...a);
              },
            });
          };
        const v: unknown = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const result = reconcileOpenRouter(db, cfg, { limit: 10, remaining: 8 }, now);
    if (refused) adjust(other, "openrouter", 9, "other terminal, again", now);
    other.close();
    return { result, refused, books: spent(x.db, "openrouter", cfg, now) };
  }

  test("committed just before the reconcile takes the lock: it is read, nothing written", async () => {
    const r = await race("first_lock");
    expect(r.result).toEqual({ kind: "lower", gapUsd: 7 });
    expect(r.books).toBe(9);
  });

  test("tried while the reconcile reads: refused until it is done, and the books end at 9", async () => {
    const r = await race("spend_read");
    expect(r.refused).toBe(true);
    expect(r.result).toEqual({ kind: "raised", to: 2 });
    expect(r.books).toBe(9);
  });
});

describe("reconcileAfterTurn", () => {
  test("an Anthropic conversation sends nothing", async () => {
    const x = await setup();
    await reconcileAfterTurn(x.run().deps, { provider: "anthropic" });
    expect(keyRequests(x)).toHaveLength(0);
  });

  test("OpenRouter not enabled, or no key: nothing sent", async () => {
    const x = await setup();
    await x.secrets.delete("llm:openrouter");
    await reconcileAfterTurn(x.run().deps, OPENROUTER);
    await x.secrets.set("llm:openrouter", "or-test");
    writeFileSync(x.paths.configFile, CONFIG_TEMPLATE);
    await reconcileAfterTurn(x.run().deps, OPENROUTER);
    expect(keyRequests(x)).toHaveLength(0);
  });

  test("the e2e base URL is used, with the key as a bearer token", async () => {
    const x = await setup();
    expect(x.env[E2E_BASE_URL_VARS.openrouter]).toBe(x.openrouter.url);
    await reconcileAfterTurn(x.run().deps, OPENROUTER);
    expect(keyRequests(x).map((r) => r.headers.authorization)).toEqual(["Bearer or-test"]);
  });

  test("a /key that hangs: back within 5 seconds, nothing written", async () => {
    const x = await setup();
    x.openrouter.key = "hang";
    const started = performance.now();
    await reconcileAfterTurn(x.run().deps, OPENROUTER);
    expect(performance.now() - started).toBeLessThan(5500);
    expect(adjustments(x)).toHaveLength(0);
  }, 8000);

  test("an error inside is not thrown", async () => {
    const x = await setup();
    const r = x.run();
    const deps = {
      ...r.deps,
      secrets: { ...r.deps.secrets, get: () => Promise.reject(new Error("keyring broke")) },
    };
    expect(await reconcileAfterTurn(deps, OPENROUTER)).toBeUndefined();
    expect(r.logs.map(([e]) => e)).toContain("warning");
  });
});
