import { TarsError } from "../../core/exit.ts";
import type { TarsPaths } from "../../core/paths.ts";
import { PROVIDERS, type Provider, type SecretStore } from "../../core/secrets.ts";
import {
  activeModels,
  defaultModel,
  loadCatalog,
  resolve,
  type Catalog,
  type ResolvedModel,
} from "./catalog.ts";
import type { TarsConfig } from "./config.ts";
import { effectiveWindow } from "./ledger.ts";
import type { Effort, ModelReason } from "./types.ts";

/**
 * Which model a conversation starts on and whether a model can be used: the terminal's tars chat
 * and tars serve ask the same questions here.
 */
interface Deps {
  readonly secrets: Pick<SecretStore, "get">;
  now(): Date;
}

/**
 * The provider enabled, its key, then the model (its default when none is named): what a new
 * conversation and /model both check.
 */
export type DefaultStart =
  | {
      readonly ok: true;
      readonly provider: Provider;
      readonly model: string;
      readonly effort: Effort;
    }
  | { readonly ok: false; readonly reason: "provider_disabled" | "unknown_model" };

/** A new conversation with no model named: [chat] provider's default model, at [chat] effort. */
export function defaultStart(config: TarsConfig, catalog: Catalog): DefaultStart {
  const provider = config.chat.provider;
  if (config.providers[provider]?.enabled !== true)
    return { ok: false, reason: "provider_disabled" };
  const model = defaultModel(catalog, provider)?.id;
  return model === undefined
    ? { ok: false, reason: "unknown_model" }
    : { ok: true, provider, model, effort: config.chat.effort };
}

type ProviderProblem = {
  readonly reason: "provider_disabled" | "no_key";
  readonly message: string;
};

/** The provider enabled and its key there, or why not. */
async function providerProblem(
  provider: Provider,
  config: TarsConfig,
  deps: Deps,
): Promise<ProviderProblem | undefined> {
  if (config.providers[provider]?.enabled !== true) {
    const enabled = PROVIDERS.filter((p) => config.providers[p]?.enabled === true);
    return {
      reason: "provider_disabled",
      message: `${provider} 沒有啟用：在 config.toml 的 [providers.${provider}] 設 enabled = true。啟用的：${enabled.join(", ") || "（沒有）"}`,
    };
  }
  const key = await deps.secrets.get(`llm:${provider}`);
  if (key === null || key === "")
    return {
      reason: "no_key",
      message: `沒有 ${provider} 的 API 金鑰。設定：tars llm key set ${provider}`,
    };
  return undefined;
}

/** The terminal's check before it starts or switches: a TarsError says what to do. */
export async function usableModel(
  provider: Provider,
  wanted: string | undefined,
  config: TarsConfig,
  paths: TarsPaths,
  deps: Deps,
): Promise<{ model: string; resolved: ResolvedModel }> {
  const problem = await providerProblem(provider, config, deps);
  if (problem !== undefined) throw new TarsError(problem.message);
  const catalog = await loadCatalog(paths);
  // Without a conversation or --model, provider is [chat] provider: the rule tars serve uses too.
  const fallback = wanted === undefined ? defaultStart(config, catalog) : undefined;
  const model = wanted ?? (fallback?.ok === true ? fallback.model : undefined);
  if (model === undefined) {
    const active = activeModels(catalog, provider).map((m) => `  ${provider}/${m.id}`);
    throw new TarsError(
      `${provider} 沒有預設模型。${active.length === 0 ? "清單上沒有 active 的模型；先執行 tars models refresh" : `active 的模型：\n${active.join("\n")}`}\n設定預設：tars models default ${provider}/<id>`,
    );
  }
  const r = resolve(catalog, provider, model, config.limits, deps.now());
  if (!r.ok) throw new TarsError(r.message);
  return { model, resolved: r.model };
}

export interface ModelChoice {
  readonly provider: Provider;
  readonly id: string;
  readonly label: string;
  /** The effective window in tokens; only for a usable one. */
  readonly window?: number;
  /** The one a new conversation gets when none is named. */
  readonly isDefault: boolean;
  /** Why it cannot be used now; absent when it can. */
  readonly unusable?: "provider_disabled" | "no_key" | ModelReason;
}

/**
 * Every active model in the list, judged as usableModel judges one. The keyring is read once
 * per provider.
 */
export async function modelChoices(
  config: TarsConfig,
  catalog: Catalog,
  deps: Deps,
): Promise<ModelChoice[]> {
  const start = defaultStart(config, catalog);
  const problems = new Map<Provider, ProviderProblem | undefined>();
  for (const p of PROVIDERS) problems.set(p, await providerProblem(p, config, deps));
  const now = deps.now();
  return activeModels(catalog).map((m) => {
    const isDefault = start.ok && start.provider === m.provider && start.model === m.id;
    const base = { provider: m.provider, id: m.id, label: m.label, isDefault };
    const problem = problems.get(m.provider);
    if (problem !== undefined) return { ...base, unusable: problem.reason };
    const r = resolve(catalog, m.provider, m.id, config.limits, now);
    return r.ok
      ? { ...base, window: effectiveWindow(r.model, config.limits) }
      : { ...base, unusable: r.reason };
  });
}
