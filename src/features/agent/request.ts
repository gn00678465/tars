import type { Database } from "bun:sqlite";
import type { Env, TarsPaths } from "../../core/paths.ts";
import type { Provider, SecretStore } from "../../core/secrets.ts";
import { utf8Bytes } from "./bytes.ts";
import { loadCatalog, resolve, type ResolvedModel } from "./catalog.ts";
import { loadConfig, type Limits, type ProviderConfig } from "./config.ts";
import { recordEnd, recordEstimatedEnd, recordFailure, recordStart } from "./ledger.ts";
import { ProviderError, type AdapterFor, type ProviderAdapter } from "./provider.ts";
import type {
  FailReason,
  ModelRequest,
  ProviderEvent,
  ReasonCode,
  RejectReason,
  TurnKind,
  Usage,
} from "./types.ts";

export const REASON_TEXT: Readonly<Record<ReasonCode, string>> = {
  aborted: "已取消",
  config_invalid: "config.toml 有問題",
  catalog_invalid: "models.json 有問題",
  boot_failed: "讀不到 SOUL.md 或 MEMORY.md",
  provider_disabled: "這家 provider 沒有啟用",
  no_key: "沒有 API 金鑰",
  unknown_model: "模型不在清單上，或沒有啟用",
  price_incomplete: "模型的上限或單價不完整",
  prices_stale: "模型的價目太久沒有確認",
  conv_too_long: "對話太長，超過硬停線。用 /compact 壓縮，或開新對話",
  budget_stopped: "本期花費已到停用門檻",
  daily_cap: "今日花費已到上限",
  turn_cap: "這個回合的花費已到上限",
  budget_unreadable: "讀不到 wiki.db 的用量帳（它可能由較新的 tars 建立），請更新 tars",
  request_limit: "這個回合的模型請求次數已到上限",
  provider_spend_limit: "provider 端的花費上限已到",
  auth: "provider 拒絕了 API 金鑰",
  bad_request: "provider 拒絕了這個請求",
  provider_error: "provider 暫時無法回應，重試用完了",
  stream_interrupted: "回應中途斷線",
  compact_too_large: "要壓縮的內容太大",
  compact_truncated: "摘要超過輸出上限",
  compact_bad_summary: "摘要的格式不對",
};

export const MAX_RETRIES = 2;
export const RETRY_WAITS_MS = [2000, 8000];
export const MAX_RETRY_AFTER_MS = 60_000;
export const TRANSIENT = new Set(["rate_limit", "overloaded", "server", "connection"]);

export interface Setup {
  readonly cfg: ProviderConfig;
  readonly limits: Limits;
  readonly model: ResolvedModel;
  readonly adapter: ProviderAdapter;
  readonly priceAgeDays: number;
  readonly pricesWarn: boolean;
}

export interface Rejected {
  readonly kind: "rejected";
  readonly reason: RejectReason;
  readonly message: string;
}

export const rejected = (reason: RejectReason, message = REASON_TEXT[reason]): Rejected => ({
  kind: "rejected",
  reason,
  message,
});

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface PrepareDeps {
  readonly paths: TarsPaths;
  readonly env: Env;
  readonly secrets: SecretStore;
  readonly adapterFor: AdapterFor;
  now(): Date;
  warn(message: string): void;
}

/** Config, catalog and key read fresh, the model resolved, and its adapter built. */
export async function prepareModel(
  deps: PrepareDeps,
  provider: Provider,
  modelId: string,
): Promise<Setup | Rejected> {
  let config;
  try {
    const loaded = await loadConfig(deps.paths);
    loaded.warnings.forEach((w) => deps.warn(w));
    config = loaded.config;
  } catch (err) {
    return rejected("config_invalid", errorText(err));
  }
  let catalog;
  try {
    catalog = await loadCatalog(deps.paths);
  } catch (err) {
    return rejected("catalog_invalid", errorText(err));
  }
  const cfg = config.providers[provider];
  if (cfg === undefined || !cfg.enabled)
    return rejected(
      "provider_disabled",
      `${provider} 沒有啟用：在 config.toml 的 [providers.${provider}] 設 enabled = true`,
    );
  const key = await deps.secrets.get(`llm:${provider}`);
  if (key === null || key === "")
    return rejected("no_key", `沒有 ${provider} 的 API 金鑰。設定：tars llm key set ${provider}`);
  const r = resolve(catalog, provider, modelId, config.limits, deps.now());
  if (!r.ok) return rejected(r.reason, r.message);
  return {
    cfg,
    limits: config.limits,
    model: r.model,
    adapter: await deps.adapterFor(provider, key, deps.env, (w) => deps.warn(w)),
    priceAgeDays: r.priceAgeDays,
    pricesWarn: r.warn === "prices_warn",
  };
}

/** One request's stream, read to its end or to its error. */
export interface Consumed {
  readonly text: string;
  readonly calls: readonly Extract<ProviderEvent, { type: "tool_call" }>[];
  readonly receivedStart: boolean;
  /** start reported the input tokens. */
  readonly inputKnown: boolean;
  /** The request counted as reasoning; see reasoningOf. */
  readonly reasoning: boolean;
  readonly end?: Extract<ProviderEvent, { type: "end" }>;
  readonly error?: ProviderError;
}

/**
 * A model may think without a word in the stream: when its catalog entry has levels and this
 * request did not send the off setting, it counts as reasoning. Only an off setting the model
 * accepts (thinkingTypes has disabled), with no thinking seen, is not.
 */
function reasoningOf(req: ModelRequest, sawThinking: boolean): boolean {
  if (sawThinking) return true;
  if (req.effort !== undefined && req.effort !== "off") return true;
  const offSent = req.effort === "off" && req.capabilities.thinkingTypes.includes("disabled");
  return req.capabilities.effortLevels.length > 0 && !offSent;
}

/** What a failed request leads to when it is not retried. */
export function failureOf(e: ProviderError): FailReason | "aborted" {
  switch (e.kind) {
    case "aborted":
      return "aborted";
    case "spend_limit":
      return "provider_spend_limit";
    case "auth":
      return "auth";
    case "bad_request":
      return "bad_request";
    default:
      return e.receivedContent ? "stream_interrupted" : "provider_error";
  }
}

/** How long to wait before attempt `attempt + 1`, or undefined when it is not retried. */
export function retryWait(e: ProviderError, attempt: number): number | undefined {
  if (!TRANSIENT.has(e.kind) || e.receivedContent || attempt > MAX_RETRIES) return undefined;
  return e.retryAfterMs === undefined
    ? RETRY_WAITS_MS[attempt - 1]
    : Math.min(e.retryAfterMs, MAX_RETRY_AFTER_MS);
}

export async function consume(
  db: Database,
  adapter: ProviderAdapter,
  req: ModelRequest,
  usageId: number,
  signal: AbortSignal,
  onEvent: (ev: { type: "delta"; text: string } | { type: "thinking" }) => void,
): Promise<Consumed> {
  let text = "";
  const calls: Extract<ProviderEvent, { type: "tool_call" }>[] = [];
  let receivedStart = false;
  let inputKnown = false;
  let sawThinking = false;
  const read = () => ({
    text,
    calls,
    receivedStart,
    inputKnown,
    reasoning: reasoningOf(req, sawThinking),
  });
  try {
    for await (const ev of adapter.stream(req, signal)) {
      if (ev.type === "start") {
        receivedStart = true;
        if (ev.usage !== undefined) {
          inputKnown = true;
          recordStart(db, usageId, ev.usage);
        }
      } else if (ev.type === "text") {
        text += ev.delta;
        onEvent({ type: "delta", text: ev.delta });
      } else if (ev.type === "thinking") {
        sawThinking = true;
        onEvent(ev);
      } else if (ev.type === "tool_call") calls.push(ev);
      else return { ...read(), end: ev };
    }
    throw new ProviderError("connection", { receivedStart, receivedContent: text !== "" });
  } catch (err) {
    if (!(err instanceof ProviderError) && !signal.aborted) throw err;
    const seen = { receivedStart, receivedContent: text !== "" || calls.length > 0 };
    const mayHaveRun = err instanceof ProviderError && err.mayHaveRun === true;
    const error = signal.aborted
      ? new ProviderError("aborted", { ...seen, mayHaveRun })
      : (err as ProviderError);
    return { ...read(), error };
  }
}

export function settleFailure(db: Database, usageId: number, got: Consumed): void {
  const e = got.error as ProviderError;
  recordFailure(db, {
    usageId,
    ...(e.kind === "aborted" || e.status === undefined ? {} : { status: e.status }),
    receivedStart: got.receivedStart,
    textBytes: utf8Bytes(got.text),
    inputKnown: got.inputKnown,
    reasoning: got.reasoning,
    mayHaveRun: e.mayHaveRun === true,
  });
}

/**
 * The output that arrived: the text, and each tool call's name and input, which the model wrote
 * as output too. Calls come only with the end, so a failed request has none.
 */
const outputBytes = (got: Consumed) =>
  got.calls.reduce(
    (n, c) => n + utf8Bytes(c.name) + utf8Bytes(JSON.stringify(c.input) ?? ""),
    utf8Bytes(got.text),
  );

/**
 * Settles a request that reached its end, in the caller's transaction. No usage in the result:
 * the response reported none and its row is an estimate; the caller tells the owner.
 */
export function settleEnd(
  db: Database,
  usageId: number,
  got: Consumed,
  opts: { readonly turnKind: TurnKind | "sync"; readonly prefixKey: string },
): { readonly usage?: Usage } {
  const end = got.end as NonNullable<Consumed["end"]>;
  if (end.usage === undefined) {
    recordEstimatedEnd(db, { usageId, textBytes: outputBytes(got), reasoning: got.reasoning });
    return {};
  }
  recordEnd(db, {
    usageId,
    usage: end.usage,
    ...(end.costUsd === undefined ? {} : { costUsd: end.costUsd }),
    turnKind: opts.turnKind,
    prefixKey: opts.prefixKey,
  });
  return { usage: end.usage };
}
