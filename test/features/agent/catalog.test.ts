import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../../../src/core/paths.ts";
import {
  CatalogInvalid,
  EMPTY_CATALOG,
  loadCatalog,
  mergeListing,
  priceState,
  resolve,
  saveCatalog,
  type Catalog,
  type ModelEntry,
} from "../../../src/features/agent/catalog.ts";
import { DEFAULT_LIMITS } from "../../../src/features/agent/config.ts";
import { tempHome } from "../../helpers.ts";

const NOW = new Date("2026-11-19T12:00:00Z");

const ACTIVE: ModelEntry = {
  provider: "anthropic",
  id: "model-a",
  label: "Model A",
  status: "active",
  default: true,
  lifecycle: "active",
  contextWindow: 200000,
  maxOutput: 64000,
  effortLevels: ["low", "medium", "high"],
  thinkingTypes: ["adaptive", "disabled"],
  price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  priceSource: "manual",
  pricedAt: "2026-11-19",
  firstSeen: "2026-11-01",
  lastSeen: "2026-11-19",
};

const catalogOf = (...models: ModelEntry[]): Catalog => ({ version: 1, models });

function paths() {
  const home = tempHome();
  return resolvePaths({ HOME: home, XDG_CONFIG_HOME: join(home, "cfg") });
}

function writeRaw(text: string) {
  const p = paths();
  mkdirSync(p.config, { recursive: true });
  writeFileSync(p.modelsFile, text);
  return p;
}

async function invalid(models: unknown[]): Promise<string> {
  const p = writeRaw(JSON.stringify({ version: 1, models }));
  try {
    await loadCatalog(p);
  } catch (err) {
    expect(err).toBeInstanceOf(CatalogInvalid);
    return (err as Error).message;
  }
  throw new Error("expected CatalogInvalid");
}

describe("load and save", () => {
  test("a missing file is an empty list", async () => {
    expect(await loadCatalog(paths())).toEqual(EMPTY_CATALOG);
  });

  test("saving creates the directory and reads back the same, as indented JSON", async () => {
    const p = paths();
    const catalog = catalogOf(ACTIVE, {
      ...ACTIVE,
      id: "model-b",
      default: false,
      status: "disabled",
    });
    await saveCatalog(p, catalog);
    expect(await loadCatalog(p)).toEqual(catalog);
    expect(readFileSync(p.modelsFile, "utf8")).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
  });

  test("broken JSON or a wrong version refuses the whole file", async () => {
    for (const text of ["{", JSON.stringify({ version: 2, models: [] }), "[]", '{"version":1}']) {
      await expect(loadCatalog(writeRaw(text))).rejects.toBeInstanceOf(CatalogInvalid);
    }
  });

  test("saving an off-rule list is refused and writes nothing", async () => {
    const p = paths();
    await expect(
      saveCatalog(p, catalogOf({ ...ACTIVE, status: "candidate" as const, default: true })),
    ).rejects.toBeInstanceOf(CatalogInvalid);
    expect(await loadCatalog(p)).toEqual(EMPTY_CATALOG);
  });
});

describe("field rules", () => {
  const { price: _price, pricedAt: _pricedAt, ...noPrice } = ACTIVE;
  test.each<[string, unknown[], string]>([
    ["unknown status", [{ ...ACTIVE, status: "on" }], "status"],
    ["unknown provider", [{ ...ACTIVE, provider: "openai" }], "provider"],
    ["empty id", [{ ...ACTIVE, id: "" }], "id"],
    ["two defaults", [ACTIVE, { ...ACTIVE, id: "model-b" }], "second default"],
    ["a default that is not active", [{ ...ACTIVE, status: "disabled" }], "only an active"],
    ["a model listed twice", [ACTIVE, { ...ACTIVE, default: false }], "listed twice"],
    ["unknown lifecycle", [{ ...ACTIVE, lifecycle: "beta" }], "lifecycle"],
    ["zero context window", [{ ...ACTIVE, contextWindow: 0 }], "contextWindow"],
    ["fractional max output", [{ ...ACTIVE, maxOutput: 1.5 }], "maxOutput"],
    ["active without a context window", [{ ...ACTIVE, contextWindow: undefined }], "contextWindow"],
    ["unknown effort level", [{ ...ACTIVE, effortLevels: ["turbo"] }], "effortLevels"],
    ["unknown thinking type", [{ ...ACTIVE, thinkingTypes: ["deep"] }], "thinkingTypes"],
    ["negative price", [{ ...ACTIVE, price: { ...ACTIVE.price, input: -1 } }], "price.input"],
    ["unknown price field", [{ ...ACTIVE, price: { ...ACTIVE.price, batch: 1 } }], "batch"],
    ["active without a price", [noPrice], "price"],
    [
      "active missing a basic price",
      [{ ...ACTIVE, price: { input: 3, output: 15, cacheRead: 0.3 } }],
      "cacheWrite",
    ],
    ["four prices without pricedAt", [{ ...ACTIVE, pricedAt: undefined }], "pricedAt"],
    ["a bad pricedAt", [{ ...ACTIVE, pricedAt: "19/11/2026" }], "pricedAt"],
    ["a priceSource other than manual", [{ ...ACTIVE, priceSource: "api" }], "priceSource"],
    ["a bad firstSeen", [{ ...ACTIVE, firstSeen: "yesterday" }], "firstSeen"],
    ["an unknown field", [{ ...ACTIVE, comment: "x" }], "unknown field comment"],
  ])("%s refuses the file", async (_name, models, needle) => {
    expect(await invalid(models)).toContain(needle);
  });

  test("a candidate may lack the context window, the limits and a price", async () => {
    const p = writeRaw(
      JSON.stringify({
        version: 1,
        models: [
          {
            provider: "anthropic",
            id: "new",
            label: "New",
            status: "candidate",
            firstSeen: "2026-11-19",
            lastSeen: "2026-11-19",
          },
        ],
      }),
    );
    expect((await loadCatalog(p)).models).toHaveLength(1);
  });
});

describe("resolve", () => {
  const limits = DEFAULT_LIMITS;

  test("an active, priced model resolves with every field a turn needs", () => {
    const r = resolve(catalogOf(ACTIVE), "anthropic", "model-a", limits, NOW);
    expect(r).toMatchObject({
      ok: true,
      priceAgeDays: 0,
      model: { id: "model-a", contextWindow: 200000, maxOutput: 64000, pricedAt: "2026-11-19" },
    });
    expect(r.ok && r.warn).toBeFalsy();
  });

  test("a model not in the list, or not active, is unknown_model", () => {
    expect(resolve(EMPTY_CATALOG, "anthropic", "model-a", limits, NOW)).toMatchObject({
      ok: false,
      reason: "unknown_model",
    });
    for (const status of ["candidate", "disabled", "retired"] as const)
      expect(
        resolve(
          catalogOf({ ...ACTIVE, status, default: false }),
          "anthropic",
          "model-a",
          limits,
          NOW,
        ),
      ).toMatchObject({ ok: false, reason: "unknown_model" });
  });

  test("a missing context window, output limit or basic price is price_incomplete", () => {
    // resolve also guards entries that never went through the file's checks.
    const variants: ModelEntry[] = [
      { ...ACTIVE, contextWindow: undefined } as unknown as ModelEntry,
      { ...ACTIVE, maxOutput: undefined } as unknown as ModelEntry,
      { ...ACTIVE, price: { input: 3, output: 15, cacheRead: 0.3 } },
    ];
    for (const v of variants)
      expect(resolve(catalogOf(v), "anthropic", "model-a", limits, NOW)).toMatchObject({
        ok: false,
        reason: "price_incomplete",
      });
  });

  test("cache_ttl 1h without a 1-hour write price is price_incomplete", () => {
    const { cacheWrite1h: _, ...price } = ACTIVE.price ?? {};
    const r = resolve(
      catalogOf({ ...ACTIVE, price }),
      "anthropic",
      "model-a",
      { ...limits, cache_ttl: "1h" },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, reason: "price_incomplete" });
    expect(resolve(catalogOf({ ...ACTIVE, price }), "anthropic", "model-a", limits, NOW).ok).toBe(
      true,
    );
  });

  test("prices older than price_refuse_days are prices_stale", () => {
    const r = resolve(
      catalogOf({ ...ACTIVE, pricedAt: "2026-08-20" }),
      "anthropic",
      "model-a",
      limits,
      NOW,
    );
    expect(r).toMatchObject({ ok: false, reason: "prices_stale" });
    expect(r.ok ? "" : r.message).toContain("confirm-prices");
  });

  test("exactly price_refuse_days old still passes, with the warning", () => {
    const r = resolve(
      catalogOf({ ...ACTIVE, pricedAt: "2026-08-21" }),
      "anthropic",
      "model-a",
      limits,
      NOW,
    );
    expect(r).toMatchObject({ ok: true, warn: "prices_warn", priceAgeDays: 90 });
  });

  test("prices older than price_warn_days pass with prices_warn", () => {
    const r = resolve(
      catalogOf({ ...ACTIVE, pricedAt: "2026-10-19" }),
      "anthropic",
      "model-a",
      limits,
      NOW,
    );
    expect(r).toMatchObject({ ok: true, warn: "prices_warn", priceAgeDays: 31 });
    const fresh = resolve(
      catalogOf({ ...ACTIVE, pricedAt: "2026-10-20" }),
      "anthropic",
      "model-a",
      limits,
      NOW,
    );
    expect(fresh).toMatchObject({ ok: true, priceAgeDays: 30 });
    expect(fresh.ok && fresh.warn).toBeFalsy();
  });
});

describe("mergeListing", () => {
  const TODAY = "2026-11-20";

  test("a model new upstream joins as a candidate seen today", () => {
    const { catalog, changes } = mergeListing(
      EMPTY_CATALOG,
      "anthropic",
      [
        {
          id: "new",
          label: "New",
          lifecycle: "active",
          contextWindow: 100000,
          maxOutput: 8000,
          effortLevels: ["low"],
          thinkingTypes: ["adaptive"],
        },
      ],
      TODAY,
    );
    expect(catalog.models).toEqual([
      {
        provider: "anthropic",
        id: "new",
        status: "candidate",
        label: "New",
        lifecycle: "active",
        contextWindow: 100000,
        maxOutput: 8000,
        effortLevels: ["low"],
        thinkingTypes: ["adaptive"],
        firstSeen: TODAY,
        lastSeen: TODAY,
      },
    ]);
    expect(changes).toEqual([{ kind: "added", id: "new" }]);
  });

  test("a known model updates lastSeen, label and lifecycle, keeps prices and status", () => {
    const { catalog } = mergeListing(
      catalogOf(ACTIVE),
      "anthropic",
      [{ id: "model-a", label: "Renamed", lifecycle: "active", contextWindow: 300000 }],
      TODAY,
    );
    const m = catalog.models[0] as ModelEntry;
    expect(m).toMatchObject({
      label: "Renamed",
      lastSeen: TODAY,
      firstSeen: ACTIVE.firstSeen,
      status: "active",
      default: true,
      price: ACTIVE.price,
      pricedAt: ACTIVE.pricedAt,
      contextWindow: 300000,
    });
  });

  test("capabilities upstream does not give keep the local values", () => {
    const { catalog } = mergeListing(
      catalogOf(ACTIVE),
      "anthropic",
      [{ id: "model-a", label: "Model A", lifecycle: "active" }],
      TODAY,
    );
    expect(catalog.models[0]).toMatchObject({
      contextWindow: ACTIVE.contextWindow,
      maxOutput: ACTIVE.maxOutput,
      effortLevels: ACTIVE.effortLevels,
      thinkingTypes: ACTIVE.thinkingTypes,
    });
  });

  test("capabilities upstream gives replace the local ones", () => {
    const { catalog, changes } = mergeListing(
      catalogOf(ACTIVE),
      "anthropic",
      [
        {
          id: "model-a",
          label: "Model A",
          lifecycle: "active",
          effortLevels: ["high"],
          thinkingTypes: [],
        },
      ],
      TODAY,
    );
    expect(catalog.models[0]).toMatchObject({ effortLevels: ["high"], thinkingTypes: [] });
    expect(changes).toContainEqual({ kind: "updated", id: "model-a" });
  });

  test("a model gone upstream is retired and loses default", () => {
    const { catalog, changes } = mergeListing(catalogOf(ACTIVE), "anthropic", [], TODAY);
    const m = catalog.models[0] as ModelEntry;
    expect(m.status).toBe("retired");
    expect(m.default).toBeUndefined();
    expect(m.price).toEqual(ACTIVE.price);
    expect(changes).toEqual([{ kind: "retired", id: "model-a", wasDefault: true }]);
  });

  test("a model upstream marks retired is retired too", () => {
    const { catalog, changes } = mergeListing(
      catalogOf({ ...ACTIVE, default: false }),
      "anthropic",
      [{ id: "model-a", label: "Model A", lifecycle: "retired" }],
      TODAY,
    );
    expect(catalog.models[0]?.status).toBe("retired");
    expect(changes).toEqual([{ kind: "retired", id: "model-a", wasDefault: false }]);
  });

  test("an already retired model reports no change; another provider's model is untouched", () => {
    const retired = { ...ACTIVE, status: "retired" as const, default: false };
    const other = { ...ACTIVE, provider: "gemini" as const, id: "g" };
    const { catalog, changes } = mergeListing(catalogOf(retired, other), "anthropic", [], TODAY);
    expect(catalog.models).toEqual([retired, other]);
    expect(changes).toEqual([]);
  });

  test("a deprecated model keeps its status and reports its retirement date", () => {
    const { catalog, changes } = mergeListing(
      catalogOf(ACTIVE),
      "anthropic",
      [{ id: "model-a", label: "Model A", lifecycle: "deprecated", retiresAt: "2027-01-31" }],
      TODAY,
    );
    expect(catalog.models[0]).toMatchObject({
      status: "active",
      default: true,
      lifecycle: "deprecated",
    });
    expect(changes).toContainEqual({ kind: "deprecated", id: "model-a", retiresAt: "2027-01-31" });
  });

  test("the merged list is still valid to save", async () => {
    const { catalog } = mergeListing(
      catalogOf(ACTIVE),
      "anthropic",
      [{ id: "x", label: "X" }],
      TODAY,
    );
    await saveCatalog(paths(), catalog);
  });
});

describe("OpenRouter prices", () => {
  const TODAY = "2026-11-20";
  const ROUTED: ModelEntry = {
    provider: "openrouter",
    id: "vendor/model-r",
    label: "Model R",
    status: "active",
    contextWindow: 128000,
    maxOutput: 16000,
    price: { input: 1, output: 4, cacheRead: 1, cacheWrite: 1 },
    priceSource: "openrouter",
    pricedAt: "2026-11-19",
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-19",
  };
  const upstreamPrice = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 };

  test("mergeListing writes an upstream price with its source and date; an owner's price stays", () => {
    const listed = [
      {
        id: "vendor/model-r",
        label: "Model R",
        price: upstreamPrice,
        priceSource: "openrouter" as const,
      },
      { id: "vendor/new", label: "New", price: upstreamPrice, priceSource: "openrouter" as const },
      {
        id: "vendor/manual",
        label: "Manual",
        price: upstreamPrice,
        priceSource: "openrouter" as const,
      },
    ];
    const manual: ModelEntry = { ...ROUTED, id: "vendor/manual", priceSource: "manual" };
    const { catalog } = mergeListing(catalogOf(ROUTED, manual), "openrouter", listed, TODAY);
    const by = (id: string) => catalog.models.find((m) => m.id === id);
    expect(by("vendor/model-r")).toMatchObject({
      price: upstreamPrice,
      priceSource: "openrouter",
      pricedAt: TODAY,
    });
    expect(by("vendor/new")).toMatchObject({
      status: "candidate",
      price: upstreamPrice,
      priceSource: "openrouter",
      pricedAt: TODAY,
    });
    expect(by("vendor/manual")).toEqual({ ...manual, label: "Manual", lastSeen: TODAY });
  });

  test("a guessed effortLevels fills an empty field and never replaces one already there", () => {
    const set: ModelEntry = { ...ROUTED, effortLevels: ["low", "xhigh"] };
    const bare: ModelEntry = { ...ROUTED, id: "vendor/bare" };
    const guess = {
      label: "R",
      effortLevels: ["low", "medium", "high"] as const,
      inferred: ["effortLevels"] as const,
    };
    const { catalog } = mergeListing(
      catalogOf(set, bare),
      "openrouter",
      [
        { id: "vendor/model-r", ...guess },
        { id: "vendor/bare", ...guess },
        { id: "vendor/added", ...guess },
      ],
      TODAY,
    );
    const by = (id: string) => catalog.models.find((m) => m.id === id);
    expect(by("vendor/model-r")?.effortLevels).toEqual(["low", "xhigh"]);
    expect(by("vendor/bare")?.effortLevels).toEqual(["low", "medium", "high"]);
    expect(by("vendor/added")?.effortLevels).toEqual(["low", "medium", "high"]);
  });

  test("a list refresh wrote, with priceSource openrouter, loads back", async () => {
    const p = paths();
    await saveCatalog(p, catalogOf(ROUTED));
    expect((await loadCatalog(p)).models[0]?.priceSource).toBe("openrouter");
  });

  test("over price_refuse_days: an OpenRouter price only warns, an owner's is refused", () => {
    const old = "2026-08-20";
    const limits = DEFAULT_LIMITS;
    const routed = { ...ROUTED, pricedAt: old };
    expect(priceState(routed, limits, NOW)).toBe("stale");
    expect(resolve(catalogOf(routed), "openrouter", routed.id, limits, NOW)).toMatchObject({
      ok: true,
      warn: "prices_warn",
    });
    const manual = { ...routed, priceSource: "manual" as const };
    expect(priceState(manual, limits, NOW)).toBe("refused");
    expect(resolve(catalogOf(manual), "openrouter", manual.id, limits, NOW)).toMatchObject({
      ok: false,
      reason: "prices_stale",
    });
  });

  test("cache_ttl 1h asks a 1-hour write price only of Anthropic models", () => {
    const limits = { ...DEFAULT_LIMITS, cache_ttl: "1h" as const };
    expect(resolve(catalogOf(ROUTED), "openrouter", ROUTED.id, limits, NOW).ok).toBe(true);
    const { cacheWrite1h: _, ...price } = ACTIVE.price ?? {};
    expect(
      resolve(catalogOf({ ...ACTIVE, price }), "anthropic", "model-a", limits, NOW),
    ).toMatchObject({
      ok: false,
      reason: "price_incomplete",
    });
  });
});
