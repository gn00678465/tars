import { MODELS, PRICE_WARNS, type WireCatalogEntry, type WireStatus } from "@tars/protocol";
import { daysSince, priceState, type Catalog, type ModelEntry } from "../agent/catalog.ts";
import type { Limits } from "../agent/config.ts";

/**
 * The read-only price table and its warnings, from models.json as it is on disk: nothing here
 * refreshes the list, asks a provider or writes. The page's price table is never a second place
 * to change prices; tars models confirm-prices stays the one.
 */

const ORDER = { active: 0, candidate: 1, disabled: 2, retired: 3 } as const;

/** Active first, then the rest, at most MODELS; total says how many the list has. */
export function catalogTable(catalog: Catalog): {
  catalog: WireCatalogEntry[];
  catalogTotal: number;
  updatedAt?: string;
} {
  const sorted = [...catalog.models].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const lastSeen = catalog.models.reduce<string | undefined>(
    (max, m) => (max === undefined || m.lastSeen > max ? m.lastSeen : max),
    undefined,
  );
  return {
    catalog: sorted.slice(0, MODELS).map(entry),
    catalogTotal: catalog.models.length,
    ...(lastSeen === undefined ? {} : { updatedAt: lastSeen.slice(0, 10) }),
  };
}

function entry(m: ModelEntry): WireCatalogEntry {
  const p = m.price;
  const price =
    p === undefined
      ? undefined
      : Object.fromEntries(
          (["input", "output", "cacheRead", "cacheWrite"] as const)
            .filter((k) => p[k] !== undefined)
            .map((k) => [k, p[k] as number]),
        );
  return {
    provider: m.provider,
    id: m.id.slice(0, 128),
    label: m.label.slice(0, 128),
    status: m.status,
    ...(m.contextWindow === undefined ? {} : { window: m.contextWindow }),
    ...(price === undefined ? {} : { price }),
    ...(m.priceSource === undefined ? {} : { priceSource: m.priceSource }),
    ...(m.pricedAt === undefined ? {} : { pricedAt: m.pricedAt.slice(0, 10) }),
  };
}

/** Active models whose price is old or missing, as resolve judges them; and the list's counts. */
export function priceWarnings(
  catalog: Catalog,
  limits: Limits,
  now: Date,
): Pick<WireStatus, "prices" | "candidates" | "retired"> {
  const prices = catalog.models
    .filter((m) => m.status === "active")
    .map((m) => ({ m, state: priceState(m, limits, now) }))
    .filter((x) => x.state !== "ok")
    .slice(0, PRICE_WARNS)
    .map(({ m, state }) => ({
      provider: m.provider,
      model: m.id.slice(0, 128),
      ...(m.pricedAt === undefined ? {} : { ageDays: daysSince(m.pricedAt, now) }),
      state: state as "stale" | "refused" | "missing",
    }));
  return {
    prices,
    candidates: catalog.models.filter((m) => m.status === "candidate").length,
    retired: catalog.models.filter((m) => m.status === "retired").length,
  };
}
