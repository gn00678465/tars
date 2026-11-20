import type { Database } from "bun:sqlite";
import type { Env, TarsPaths } from "../../core/paths.ts";
import type { Provider, SecretStore } from "../../core/secrets.ts";
import { loadConfig, type ProviderConfig } from "./config.ts";
import { adjust, spent } from "./ledger.ts";
import type { Log } from "./log.ts";
import { COMPAT_ENDPOINTS, E2E_BASE_URL_VARS, loopbackUrl } from "./provider.ts";

/** OpenRouter's key limit, from GET /key; both null when the key has no limit. */
export interface KeyLimit {
  readonly limit: number | null;
  readonly remaining: number | null;
}

const TIMEOUT_MS = 5000;
const MIN_GAP_USD = 0.005;

/** undefined when the request fails, times out or answers in a shape not understood. */
export async function fetchKeyLimit(
  apiKey: string,
  baseURL: string,
  signal: AbortSignal,
): Promise<KeyLimit | undefined> {
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { limit?: unknown; limit_remaining?: unknown } };
    const limit = body.data?.limit;
    const remaining = body.data?.limit_remaining;
    if (limit === null) return { limit: null, remaining: null };
    const amount = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (!amount(limit) || !amount(remaining) || remaining > limit) return undefined;
    return { limit, remaining };
  } catch {
    return undefined;
  }
}

export type ReconcileResult =
  | { readonly kind: "raised"; readonly to: number }
  /** The local books are higher; nothing changed. */
  | { readonly kind: "lower"; readonly gapUsd: number }
  | { readonly kind: "no_limit" }
  /** The gap is under 0.005 USD. */
  | { readonly kind: "skip" };

/**
 * Bookkeeping only: no request, no output. Only upward (E5): a lagging or reset key limit
 * lowering the books would let a provider past its stop line send again.
 */
export function reconcileOpenRouter(
  db: Database,
  cfg: ProviderConfig,
  key: KeyLimit,
  now: Date,
): ReconcileResult {
  if (key.limit === null || key.remaining === null) return { kind: "no_limit" };
  const used = key.limit - key.remaining;
  // Read, compared and written under one write lock: `tars cost adjust` may run in another
  // terminal, and a figure it wrote between a separate read and the write would be replaced by
  // this lower one.
  return db
    .transaction((): ReconcileResult => {
      const local = spent(db, "openrouter", cfg, now);
      if (used - local >= MIN_GAP_USD) {
        adjust(db, "openrouter", used, "auto: /key", now);
        return { kind: "raised", to: used };
      }
      if (local - used >= MIN_GAP_USD) return { kind: "lower", gapUsd: local - used };
      return { kind: "skip" };
    })
    .immediate();
}

export interface ReconcileDeps {
  readonly db: Database;
  readonly paths: TarsPaths;
  /** Read for TARS_E2E_OPENROUTER_BASE_URL, through loopbackUrl. */
  readonly env: Env;
  /** Read for llm:openrouter. */
  readonly secrets: SecretStore;
  now(): Date;
  warn(message: string): void;
  readonly log: Log;
}

/** Each warning once per process. */
const warned = new Set<"lower" | "no_limit">();

/**
 * After a turn or /compact on an OpenRouter conversation: pulls the books up to what the key
 * limit says was used. Never throws; gives up after 5 seconds.
 */
export async function reconcileAfterTurn(
  deps: ReconcileDeps,
  conv: { readonly provider: Provider },
): Promise<void> {
  if (conv.provider !== "openrouter") return;
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const cfg = (await loadConfig(deps.paths)).config.providers.openrouter;
    if (cfg?.enabled !== true) return;
    const apiKey = await deps.secrets.get("llm:openrouter");
    if (apiKey === null) return;
    const name = E2E_BASE_URL_VARS.openrouter;
    const baseURL = loopbackUrl(name, deps.env[name], "http") ?? COMPAT_ENDPOINTS.openrouter;
    const key = await fetchKeyLimit(apiKey, baseURL, signal);
    if (key === undefined) return deps.log.log("warning", {});
    const result = reconcileOpenRouter(deps.db, cfg, key, deps.now());
    if (result.kind === "raised") deps.log.log("warning", { costUsd: result.to });
    else if (result.kind === "no_limit" && !warned.has("no_limit")) {
      warned.add("no_limit");
      deps.warn("OpenRouter 的金鑰沒有設額度上限，本機的帳無法自動校正");
    } else if (result.kind === "lower" && !warned.has("lower")) {
      warned.add("lower");
      deps.warn(
        `本機的帳比 OpenRouter 的金鑰額度多 ${result.gapUsd.toFixed(2)} USD。確認後用 tars cost adjust openrouter --spent <金額> 修正`,
      );
    }
  } catch {
    deps.log.log("warning", {});
  }
}

/** For tests: forget which warnings this process already gave. */
export const resetReconcileWarnings = () => warned.clear();
