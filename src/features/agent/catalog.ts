import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { sibling, writeFileAtomic } from "../../core/fs.ts";
import type { TarsPaths } from "../../core/paths.ts";
import { PROVIDERS, type Provider } from "../../core/secrets.ts";
import { isRecord } from "../script/metadata.ts";
import type { Limits } from "./config.ts";
import { isBusy } from "./db.ts";
import { EFFORTS, type Effort, type ListedModel, type ModelReason } from "./types.ts";

export const MODEL_STATUSES = ["candidate", "active", "disabled", "retired"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];
const LIFECYCLES = ["active", "deprecated", "retired"] as const;
const THINKING_TYPES = ["enabled", "disabled", "between_tools", "adaptive"] as const;

/** US dollars per million tokens. */
export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
}

export const BASIC_PRICES = ["input", "output", "cacheRead", "cacheWrite"] as const;
const PRICE_KEYS = [...BASIC_PRICES, "cacheWrite1h"] as const;

export interface ModelEntry {
  readonly provider: Provider;
  readonly id: string;
  readonly label: string;
  readonly status: ModelStatus;
  readonly default?: boolean;
  readonly lifecycle?: (typeof LIFECYCLES)[number];
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly effortLevels?: readonly Effort[];
  readonly thinkingTypes?: readonly string[];
  readonly price?: Partial<Price>;
  readonly priceSource?: "manual";
  readonly pricedAt?: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface Catalog {
  readonly version: 1;
  readonly models: readonly ModelEntry[];
}

export const EMPTY_CATALOG: Catalog = { version: 1, models: [] };

export class CatalogInvalid extends TarsError {
  constructor(
    readonly file: string,
    readonly problems: readonly string[],
  ) {
    super(
      `${file} is not a valid model list; fix or remove it:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = new Set([
  "provider",
  "id",
  "label",
  "status",
  "default",
  "lifecycle",
  "contextWindow",
  "maxOutput",
  "effortLevels",
  "thinkingTypes",
  "price",
  "priceSource",
  "pricedAt",
  "firstSeen",
  "lastSeen",
]);

/** A missing file is an empty list; anything unreadable or off-rule throws CatalogInvalid. */
export async function loadCatalog(paths: TarsPaths): Promise<Catalog> {
  const text = await readFile(paths.modelsFile, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (text === undefined) return EMPTY_CATALOG;
  const problems: string[] = [];
  const catalog = parseCatalog(text, problems);
  if (problems.length > 0) throw new CatalogInvalid(paths.modelsFile, problems);
  return catalog;
}

export async function saveCatalog(paths: TarsPaths, catalog: Catalog): Promise<void> {
  const problems: string[] = [];
  validateModels(catalog.models, problems);
  if (problems.length > 0) throw new CatalogInvalid(paths.modelsFile, problems);
  await mkdir(dirname(paths.modelsFile), { recursive: true });
  await writeFileAtomic(paths.modelsFile, `${JSON.stringify(catalog, null, 2)}\n`);
}

const CATALOG_LOCK_WAIT_MS = 10_000;

/**
 * One read-modify-write of models.json under an exclusive lock, so two `tars models` commands
 * cannot each write back a list without the other's change. The lock is a SQLite exclusive
 * transaction on a hidden sibling, which the OS releases if the process dies.
 */
export async function updateCatalog(
  paths: TarsPaths,
  change: (catalog: Catalog) => Catalog,
): Promise<void> {
  await mkdir(dirname(paths.modelsFile), { recursive: true });
  const lock = new Database(sibling(paths.modelsFile, "lock"), { create: true });
  try {
    lock.exec(`PRAGMA busy_timeout=${CATALOG_LOCK_WAIT_MS}`);
    lock.exec("PRAGMA journal_mode=DELETE");
    try {
      lock.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS h(x);");
    } catch (err) {
      if (!isBusy(err)) throw err;
      throw new TarsError("另一個 tars models 指令正在修改 models.json；稍後再試");
    }
    await saveCatalog(paths, change(await loadCatalog(paths)));
  } finally {
    lock.close();
  }
}

export function parseCatalog(text: string, problems: string[]): Catalog {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    problems.push(`not JSON: ${(err as Error).message}`);
    return EMPTY_CATALOG;
  }
  if (!isRecord(json) || json.version !== 1) {
    problems.push('"version" must be 1');
    return EMPTY_CATALOG;
  }
  if (!Array.isArray(json.models)) {
    problems.push('"models" must be an array');
    return EMPTY_CATALOG;
  }
  const models = json.models as ModelEntry[];
  validateModels(models, problems);
  return { version: 1, models };
}

function validateModels(models: readonly unknown[], problems: string[]): void {
  const keys = new Set<string>();
  const defaults = new Set<string>();
  models.forEach((raw, i) => {
    const at = `models[${i}]`;
    if (!isRecord(raw)) return void problems.push(`${at} must be an object`);
    const e = raw as unknown as ModelEntry;
    const name = `${at} (${String(e.provider)}/${String(e.id)})`;
    const bad = (rule: string) => problems.push(`${name}: ${rule}`);
    for (const k of Object.keys(raw)) if (!ENTRY_KEYS.has(k)) bad(`unknown field ${k}`);
    if (!PROVIDERS.includes(e.provider)) bad(`provider must be one of ${PROVIDERS.join(", ")}`);
    if (typeof e.id !== "string" || e.id === "") bad("id must be a non-empty string");
    if (typeof e.label !== "string") bad("label must be a string");
    if (!MODEL_STATUSES.includes(e.status))
      bad(`status must be one of ${MODEL_STATUSES.join(", ")}`);
    const key = `${e.provider}/${e.id}`;
    if (keys.has(key)) bad("listed twice");
    keys.add(key);
    if (e.default !== undefined && typeof e.default !== "boolean") bad("default must be a boolean");
    if (e.default === true) {
      if (e.status !== "active") bad("only an active model can be the default");
      if (defaults.has(e.provider)) bad(`a second default for ${e.provider}`);
      defaults.add(e.provider);
    }
    if (e.lifecycle !== undefined && !LIFECYCLES.includes(e.lifecycle))
      bad(`lifecycle must be one of ${LIFECYCLES.join(", ")}`);
    for (const field of ["contextWindow", "maxOutput"] as const) {
      const v = e[field];
      if (v === undefined ? e.status === "active" : !Number.isInteger(v) || v <= 0)
        bad(`${field} must be a positive whole number`);
    }
    if (!subsetOf(e.effortLevels, EFFORTS))
      bad(`effortLevels must be a subset of ${EFFORTS.join(", ")}`);
    if (!subsetOf(e.thinkingTypes, THINKING_TYPES))
      bad(`thinkingTypes must be a subset of ${THINKING_TYPES.join(", ")}`);
    validatePrice(e, bad);
    for (const field of ["firstSeen", "lastSeen"] as const)
      if (typeof e[field] !== "string" || !DATE.test(e[field])) bad(`${field} must be YYYY-MM-DD`);
  });
}

function validatePrice(e: ModelEntry, bad: (rule: string) => void): void {
  if (e.priceSource !== undefined && e.priceSource !== "manual")
    bad('priceSource must be "manual"');
  if (e.pricedAt !== undefined && (typeof e.pricedAt !== "string" || !DATE.test(e.pricedAt)))
    bad("pricedAt must be YYYY-MM-DD");
  if (e.price === undefined) {
    if (e.status === "active") bad("an active model needs a price");
    return;
  }
  if (!isRecord(e.price)) return bad("price must be an object");
  for (const k of Object.keys(e.price))
    if (!PRICE_KEYS.includes(k as (typeof PRICE_KEYS)[number])) bad(`price has unknown field ${k}`);
  for (const k of PRICE_KEYS) {
    const v = e.price[k];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v >= 0))
      bad(`price.${k} must be a number, 0 or more`);
  }
  const complete = BASIC_PRICES.every((k) => e.price?.[k] !== undefined);
  if (e.status === "active" && !complete) bad(`an active model needs ${BASIC_PRICES.join(", ")}`);
  if (complete && e.pricedAt === undefined) bad("pricedAt is required with the four basic prices");
}

const subsetOf = (value: unknown, allowed: readonly string[]) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every((v) => allowed.includes(v)) &&
    new Set(value).size === value.length);

/** UTC calendar date, YYYY-MM-DD. */
export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Whole days from `day` (a UTC date) to now's UTC date. */
export const daysSince = (day: string, now: Date) =>
  Math.round((Date.parse(utcDay(now)) - Date.parse(day)) / 86_400_000);

export type PriceState = "ok" | "stale" | "refused" | "missing";

export function priceState(entry: ModelEntry, limits: Limits, now: Date): PriceState {
  if (entry.pricedAt === undefined) return "missing";
  const age = daysSince(entry.pricedAt, now);
  return age > limits.price_refuse_days ? "refused" : age > limits.price_warn_days ? "stale" : "ok";
}

/** A model that passed resolve: every field a turn needs is there. */
export interface ResolvedModel {
  readonly provider: Provider;
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly effortLevels?: readonly Effort[];
  readonly thinkingTypes: readonly string[];
  readonly price: Price;
  readonly pricedAt: string;
}

export type Resolution =
  | {
      readonly ok: true;
      readonly model: ResolvedModel;
      readonly warn?: "prices_warn";
      readonly priceAgeDays: number;
    }
  | { readonly ok: false; readonly reason: ModelReason; readonly message: string };

export function resolve(
  catalog: Catalog,
  provider: Provider,
  id: string,
  limits: Limits,
  now: Date,
): Resolution {
  const entry = catalog.models.find((m) => m.provider === provider && m.id === id);
  const ref = `${provider}/${id}`;
  if (entry === undefined || entry.status !== "active")
    return {
      ok: false,
      reason: "unknown_model",
      message: `${ref} 不在模型清單上，或不是 active。查看：tars models list；啟用：tars models enable ${ref}`,
    };
  const price = entry.price ?? {};
  const complete =
    entry.contextWindow !== undefined &&
    entry.maxOutput !== undefined &&
    BASIC_PRICES.every((k) => price[k] !== undefined) &&
    (limits.cache_ttl !== "1h" || price.cacheWrite1h !== undefined);
  if (!complete || entry.pricedAt === undefined)
    return {
      ok: false,
      reason: "price_incomplete",
      message: `${ref} 缺 context 視窗、輸出上限或單價${limits.cache_ttl === "1h" ? "（cache_ttl = 1h 要 --cache-write-1h）" : ""}。補上：tars models set ${ref} …`,
    };
  const state = priceState(entry, limits, now);
  const priceAgeDays = daysSince(entry.pricedAt, now);
  if (state === "refused")
    return {
      ok: false,
      reason: "prices_stale",
      message: `${ref} 的價目 ${priceAgeDays} 天沒有確認（上限 ${limits.price_refuse_days} 天）。到 Console 核對後執行：tars models confirm-prices --provider ${provider}`,
    };
  return {
    ok: true,
    model: {
      provider,
      id,
      label: entry.label,
      contextWindow: entry.contextWindow as number,
      maxOutput: entry.maxOutput as number,
      ...(entry.effortLevels === undefined ? {} : { effortLevels: entry.effortLevels }),
      thinkingTypes: entry.thinkingTypes ?? [],
      price: price as Price,
      pricedAt: entry.pricedAt,
    },
    priceAgeDays,
    ...(state === "stale" ? { warn: "prices_warn" as const } : {}),
  };
}

export type ListingChange =
  | { readonly kind: "added"; readonly id: string }
  | { readonly kind: "updated"; readonly id: string }
  | { readonly kind: "retired"; readonly id: string; readonly wasDefault: boolean }
  | { readonly kind: "deprecated"; readonly id: string; readonly retiresAt?: string };

/**
 * Folds one provider's upstream list into the catalog. Prices and the active status are the
 * owner's; this never touches them, except that a model gone upstream is retired.
 */
export function mergeListing(
  catalog: Catalog,
  provider: Provider,
  listed: readonly ListedModel[],
  today: string,
): { catalog: Catalog; changes: ListingChange[] } {
  const changes: ListingChange[] = [];
  const upstream = new Map(listed.map((m) => [m.id, m]));
  const models: ModelEntry[] = catalog.models.map((entry) => {
    if (entry.provider !== provider) return entry;
    const up = upstream.get(entry.id);
    if (up === undefined || up.lifecycle === "retired") {
      if (entry.status === "retired") return entry;
      changes.push({ kind: "retired", id: entry.id, wasDefault: entry.default === true });
      const { default: _, ...rest } = entry;
      return { ...rest, status: "retired", ...(up === undefined ? {} : upstreamFields(up)) };
    }
    if (up.lifecycle === "deprecated")
      changes.push({
        kind: "deprecated",
        id: entry.id,
        ...(up.retiresAt ? { retiresAt: up.retiresAt } : {}),
      });
    const next = { ...entry, ...upstreamFields(up), lastSeen: today };
    if (JSON.stringify(next) !== JSON.stringify({ ...entry, lastSeen: today }))
      changes.push({ kind: "updated", id: entry.id });
    return next;
  });
  const known = new Set(catalog.models.filter((m) => m.provider === provider).map((m) => m.id));
  for (const up of listed) {
    if (known.has(up.id) || up.lifecycle === "retired") continue;
    if (up.lifecycle === "deprecated")
      changes.push({
        kind: "deprecated",
        id: up.id,
        ...(up.retiresAt ? { retiresAt: up.retiresAt } : {}),
      });
    changes.push({ kind: "added", id: up.id });
    models.push({
      provider,
      id: up.id,
      status: "candidate",
      ...upstreamFields(up),
      firstSeen: today,
      lastSeen: today,
    });
  }
  return { catalog: { version: 1, models }, changes };
}

/** label and lifecycle always; the capability fields only when upstream gave a value. */
function upstreamFields(up: ListedModel) {
  return {
    label: up.label,
    ...(up.lifecycle === undefined ? {} : { lifecycle: up.lifecycle }),
    ...(up.contextWindow === undefined ? {} : { contextWindow: up.contextWindow }),
    ...(up.maxOutput === undefined ? {} : { maxOutput: up.maxOutput }),
    ...(up.effortLevels === undefined ? {} : { effortLevels: up.effortLevels }),
    ...(up.thinkingTypes === undefined ? {} : { thinkingTypes: up.thinkingTypes }),
  };
}

export const findModel = (catalog: Catalog, provider: Provider, id: string) =>
  catalog.models.find((m) => m.provider === provider && m.id === id);

export const defaultModel = (catalog: Catalog, provider: Provider) =>
  catalog.models.find((m) => m.provider === provider && m.default === true);

export const activeModels = (catalog: Catalog, provider?: Provider) =>
  catalog.models.filter(
    (m) => m.status === "active" && (provider === undefined || m.provider === provider),
  );
