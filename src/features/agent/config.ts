import { readFile } from "node:fs/promises";
import { TarsError } from "../../core/exit.ts";
import type { TarsPaths } from "../../core/paths.ts";
import { PROVIDERS, type Provider } from "../../core/secrets.ts";
import { isRecord, SLUG } from "../script/metadata.ts";
import { EFFORTS, type CacheTtl, type ChatConfig } from "./types.ts";

export interface ProviderConfig {
  readonly enabled: boolean;
  readonly quota_usd: number;
  readonly period: "utc-month" | "total";
  readonly stop_ratio: number;
  readonly warn_ratio: number;
  readonly daily_cap_usd: number;
  /** With period = "total": what was spent outside tars before. */
  readonly prior_spend_usd: number;
}

export interface Limits {
  readonly turn_cap_usd: number;
  readonly max_requests_per_turn: number;
  readonly max_output_tokens: number;
  readonly max_input_tokens: number;
  readonly tool_result_bytes: number;
  readonly approval_timeout_s: number;
  readonly price_warn_days: number;
  readonly price_refuse_days: number;
  readonly context_warn_ratio: number;
  readonly context_compact_ratio: number;
  readonly context_stop_ratio: number;
  readonly auto_compact: boolean;
  readonly compact_keep_recent_tokens: number;
  readonly compact_max_output_tokens: number;
  readonly cache_ttl: CacheTtl;
}

export interface WikiConfig {
  /** Sync's own caps, per UTC day and UTC month, on top of the provider's. */
  readonly daily_cap_usd: number;
  readonly monthly_cap_usd: number;
  /** "" for the default Anthropic model, or "<provider>/<id>". */
  readonly model: string;
}

/**
 * Where tars serve connects and whom it lets in. Each key may be missing here: tars serve and
 * tars link status say which ones are, or still hold a template placeholder.
 */
export interface LinkConfig {
  readonly url?: string;
  readonly access_team_domain?: string;
  readonly access_aud?: string;
  readonly owner_email?: string;
}

export const LINK_KEYS = ["url", "access_team_domain", "access_aud", "owner_email"] as const;

export interface NotifyConfig {
  /** A library script's name; "" sends nothing. */
  readonly script: string;
  /** "{title}" and "{body}" are each replaced, as a whole argument, by fixed text. */
  readonly args: readonly string[];
  /** Also notify when a new browser connection passes the checks. */
  readonly on_connect: boolean;
}

export const NOTIFY_PLACEHOLDERS = ["{title}", "{body}"] as const;

export const DEFAULT_NOTIFY: NotifyConfig = {
  script: "",
  args: ["--title", "{title}", "--body", "{body}"],
  on_connect: true,
};

export interface TarsConfig {
  readonly providers: Partial<Record<Provider, ProviderConfig>>;
  readonly limits: Limits;
  readonly chat: ChatConfig;
  readonly wiki: WikiConfig;
  /** Absent without a [link] section. */
  readonly link?: LinkConfig;
  /** Absent without a [notify] section. */
  readonly notify?: NotifyConfig;
}

export const DEFAULT_LIMITS: Limits = {
  turn_cap_usd: 1,
  max_requests_per_turn: 20,
  max_output_tokens: 16000,
  max_input_tokens: 200000,
  tool_result_bytes: 16384,
  approval_timeout_s: 600,
  price_warn_days: 30,
  price_refuse_days: 90,
  context_warn_ratio: 0.6,
  context_compact_ratio: 0.75,
  context_stop_ratio: 0.85,
  auto_compact: true,
  compact_keep_recent_tokens: 20000,
  compact_max_output_tokens: 4096,
  cache_ttl: "5m",
};

export const DEFAULT_CHAT: ChatConfig = { effort: "medium", provider: "anthropic" };

export const DEFAULT_WIKI: WikiConfig = { daily_cap_usd: 1, monthly_cap_usd: 10, model: "" };

export const CONFIG_TEMPLATE = `[providers.anthropic]
enabled = true
quota_usd = 100          # 帳戶額度
period = "utc-month"     # 或 "total"
stop_ratio = 0.95
warn_ratio = 0.80
daily_cap_usd = 10
prior_spend_usd = 0      # period = "total" 時，tars 以外已用掉的金額

[providers.gemini]
enabled = false
quota_usd = 1000
period = "total"
stop_ratio = 0.95
warn_ratio = 0.80
daily_cap_usd = 10
prior_spend_usd = 0      # 這把金鑰在 tars 以外已經用掉的金額，從帳單頁抄

[providers.openrouter]
enabled = false
quota_usd = 10           # 和 OpenRouter 上這把金鑰的額度上限一致
period = "total"
stop_ratio = 0.95
warn_ratio = 0.80
daily_cap_usd = 10
prior_spend_usd = 0

[limits]
turn_cap_usd = 1
max_requests_per_turn = 20
max_output_tokens = 16000
max_input_tokens = 200000
tool_result_bytes = 16384
approval_timeout_s = 600
price_warn_days = 30
price_refuse_days = 90
context_warn_ratio = 0.60
context_compact_ratio = 0.75
context_stop_ratio = 0.85
auto_compact = true
compact_keep_recent_tokens = 20000
compact_max_output_tokens = 4096
cache_ttl = "5m"         # 或 "1h"

[chat]
effort = "medium"        # low | medium | high | xhigh | max
provider = "anthropic"   # 不帶 --model 時用哪一家

[wiki]
daily_cap_usd = 1        # 同步的每日上限（UTC 日）
monthly_cap_usd = 10     # 同步的每月上限（UTC 月）
model = ""               # 空字串：Anthropic 在 models.json 的預設模型。或 "<provider>/<id>"

# 遠端入口（tars serve）。拿掉每行開頭的 # 再填值；還有 < > 的值 tars serve 不接受。
# [link]
# url = "wss://link.<OWNER_DOMAIN>/link"
# access_team_domain = "<TEAM>.cloudflareaccess.com"
# access_aud = "<ACCESS_AUD>"
# owner_email = "<OWNER_EMAIL>"

# [notify]
# script = ""                                    # 入庫腳本的名稱；空字串是不通知
# args = ["--title", "{title}", "--body", "{body}"]
# on_connect = true                              # 新的瀏覽器連線通過驗證時也推播
`;

/** Reads config.toml from disk on every call; a turn picks up the owner's edits. */
export async function loadConfig(
  paths: TarsPaths,
): Promise<{ config: TarsConfig; warnings: string[] }> {
  const text = await readFile(paths.configFile, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT")
      throw new TarsError(`${paths.configFile} does not exist; create it with: tars config init`);
    throw err;
  });
  let toml: unknown;
  try {
    toml = Bun.TOML.parse(text);
  } catch (err) {
    throw new TarsError(`${paths.configFile} is not valid TOML: ${(err as Error).message}`);
  }
  const result = parseConfig(toml);
  if (result.problems.length > 0)
    throw new TarsError(
      `${paths.configFile} has problems:\n${result.problems.map((p) => `  ${p}`).join("\n")}`,
    );
  return { config: result.config, warnings: result.warnings };
}

export function parseConfig(toml: unknown): {
  config: TarsConfig;
  warnings: string[];
  problems: string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];
  const top = isRecord(toml) ? toml : {};
  for (const key of Object.keys(top))
    if (!["providers", "limits", "chat", "wiki", "link", "notify"].includes(key))
      problems.push(`unknown section [${key}]`);

  const providers: Partial<Record<Provider, ProviderConfig>> = {};
  const providerTables = section(top, "providers", problems);
  for (const [name, table] of Object.entries(providerTables)) {
    if (!PROVIDERS.includes(name as Provider)) {
      warnings.push(`[providers.${name}] is ignored; this tars knows ${PROVIDERS.join(", ")}`);
      continue;
    }
    if (!isRecord(table)) {
      problems.push(`[providers.${name}] must be a table`);
      continue;
    }
    providers[name as Provider] = parseProvider(name, table, problems);
  }
  const limits = parseLimits(section(top, "limits", problems), problems);
  const chatTable = section(top, "chat", problems);
  const fields = new Fields("chat", chatTable, problems);
  // Only that it names a provider: whether it is enabled is checked by tars chat, the one
  // command that uses it, so tars cost and tars models still run.
  const chat: ChatConfig = {
    effort: fields.oneOf("effort", EFFORTS, DEFAULT_CHAT.effort),
    provider: fields.oneOf("provider", PROVIDERS, DEFAULT_CHAT.provider),
  };
  fields.rejectUnknown();
  const wiki = parseWiki(section(top, "wiki", problems), problems);
  const link =
    top.link === undefined ? undefined : parseLink(section(top, "link", problems), problems);
  const notify =
    top.notify === undefined ? undefined : parseNotify(section(top, "notify", problems), problems);
  return {
    config: {
      providers,
      limits,
      chat,
      wiki,
      ...(link === undefined ? {} : { link }),
      ...(notify === undefined ? {} : { notify }),
    },
    warnings,
    problems,
  };
}

function parseLink(table: Record<string, unknown>, problems: string[]): LinkConfig {
  const f = new Fields("link", table, problems);
  const link: Record<string, string> = {};
  for (const key of LINK_KEYS) {
    const value = f.optionalText(
      key,
      key === "url" ? (v) => v.startsWith("wss://") : () => true,
      key === "url" ? "a wss:// URL" : "a string",
    );
    if (value !== undefined) link[key] = value;
  }
  f.rejectUnknown();
  return link;
}

const isNotifyArg = (a: unknown) =>
  typeof a === "string" &&
  ((NOTIFY_PLACEHOLDERS as readonly string[]).includes(a) || !/[{}]/.test(a));

function parseNotify(table: Record<string, unknown>, problems: string[]): NotifyConfig {
  const f = new Fields("notify", table, problems);
  const d = DEFAULT_NOTIFY;
  const notify: NotifyConfig = {
    script: f.text("script", d.script, (v) => v === "" || SLUG.test(v), `"" or a script's name`),
    args: f.list(
      "args",
      d.args,
      isNotifyArg,
      "strings, with {title} and {body} only as a whole argument",
    ),
    on_connect: f.bool("on_connect", d.on_connect),
  };
  f.rejectUnknown();
  return notify;
}

/** A model reference checked without throwing, so the rest of the file is still checked. */
const isModelRef = (v: string) => {
  const slash = v.indexOf("/");
  return (
    v === "" ||
    (slash > 0 &&
      PROVIDERS.includes(v.slice(0, slash) as Provider) &&
      v.slice(slash + 1).trim() !== "")
  );
};

/**
 * The OpenRouter reconcile compares the key's figure with the chat books only, and an adjustment
 * covers wiki requests by time: wiki requests on OpenRouter would drop out of the books.
 */
export const WIKI_NO_OPENROUTER =
  "[wiki] model 不能是 openrouter/…：OpenRouter 的自動校正與 wiki 的帳尚未合併，wiki 暫不支援 OpenRouter 的模型。Gemini 與 Anthropic 不受影響";

function parseWiki(table: Record<string, unknown>, problems: string[]): WikiConfig {
  const before = problems.length;
  const f = new Fields("wiki", table, problems);
  const d = DEFAULT_WIKI;
  const wiki: WikiConfig = {
    daily_cap_usd: f.positive("daily_cap_usd", d.daily_cap_usd),
    monthly_cap_usd: f.positive("monthly_cap_usd", d.monthly_cap_usd),
    model: f.text("model", d.model, isModelRef, `"" or "<provider>/<id>"`),
  };
  f.rejectUnknown();
  if (wiki.model.startsWith("openrouter/")) problems.push(WIKI_NO_OPENROUTER);
  if (problems.length === before && wiki.daily_cap_usd > wiki.monthly_cap_usd)
    problems.push("[wiki] needs daily_cap_usd ≤ monthly_cap_usd");
  return wiki;
}

function section(top: Record<string, unknown>, key: string, problems: string[]) {
  const value = top[key];
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  problems.push(`[${key}] must be a table`);
  return {};
}

function parseProvider(
  name: string,
  table: Record<string, unknown>,
  problems: string[],
): ProviderConfig {
  const before = problems.length;
  const f = new Fields(`providers.${name}`, table, problems);
  const cfg: ProviderConfig = {
    enabled: f.bool("enabled"),
    quota_usd: f.positive("quota_usd"),
    period: f.oneOf("period", ["utc-month", "total"] as const),
    stop_ratio: f.ratio("stop_ratio"),
    warn_ratio: f.ratio("warn_ratio"),
    daily_cap_usd: f.positive("daily_cap_usd"),
    prior_spend_usd: f.nonNegative("prior_spend_usd", 0),
  };
  f.rejectUnknown();
  if (problems.length === before && cfg.warn_ratio > cfg.stop_ratio)
    problems.push(`[providers.${name}] needs 0 < warn_ratio ≤ stop_ratio ≤ 1`);
  return cfg;
}

function parseLimits(table: Record<string, unknown>, problems: string[]): Limits {
  const before = problems.length;
  const f = new Fields("limits", table, problems);
  const d = DEFAULT_LIMITS;
  const limits: Limits = {
    turn_cap_usd: f.positive("turn_cap_usd", d.turn_cap_usd),
    max_requests_per_turn: f.int("max_requests_per_turn", 1, 100, d.max_requests_per_turn),
    max_output_tokens: f.int("max_output_tokens", 1024, 200000, d.max_output_tokens),
    max_input_tokens: f.int("max_input_tokens", 10000, Number.MAX_SAFE_INTEGER, d.max_input_tokens),
    tool_result_bytes: f.int("tool_result_bytes", 1024, 1048576, d.tool_result_bytes),
    approval_timeout_s: f.int("approval_timeout_s", 10, 86400, d.approval_timeout_s),
    price_warn_days: f.int("price_warn_days", 1, Number.MAX_SAFE_INTEGER, d.price_warn_days),
    price_refuse_days: f.int("price_refuse_days", 1, Number.MAX_SAFE_INTEGER, d.price_refuse_days),
    context_warn_ratio: f.ratio("context_warn_ratio", d.context_warn_ratio),
    context_compact_ratio: f.ratio("context_compact_ratio", d.context_compact_ratio),
    context_stop_ratio: f.ratio("context_stop_ratio", d.context_stop_ratio),
    auto_compact: f.bool("auto_compact", d.auto_compact),
    compact_keep_recent_tokens: f.int(
      "compact_keep_recent_tokens",
      1000,
      200000,
      d.compact_keep_recent_tokens,
    ),
    compact_max_output_tokens: f.int(
      "compact_max_output_tokens",
      1024,
      32000,
      d.compact_max_output_tokens,
    ),
    cache_ttl: f.oneOf("cache_ttl", ["5m", "1h"] as const, d.cache_ttl),
  };
  f.rejectUnknown();
  if (problems.length > before) return limits;
  if (limits.price_warn_days > limits.price_refuse_days)
    problems.push("[limits] needs 1 ≤ price_warn_days ≤ price_refuse_days");
  if (
    limits.context_warn_ratio > limits.context_compact_ratio ||
    limits.context_compact_ratio > limits.context_stop_ratio
  )
    problems.push(
      "[limits] needs 0 < context_warn_ratio ≤ context_compact_ratio ≤ context_stop_ratio ≤ 1",
    );
  return limits;
}

/**
 * Reads one table's keys, each with its rule. A key without a default is required. A bad value
 * becomes a problem and a stand-in, so every problem in the file is collected in one pass.
 */
class Fields {
  private readonly seen = new Set<string>();

  constructor(
    private readonly name: string,
    private readonly table: Record<string, unknown>,
    private readonly problems: string[],
  ) {}

  private read<T>(
    key: string,
    fallback: T | undefined,
    standIn: T,
    rule: string,
    accept: (v: unknown) => boolean,
  ): T {
    this.seen.add(key);
    const value = this.table[key];
    if (value === undefined && fallback !== undefined) return fallback;
    if (value !== undefined && accept(value)) return value as T;
    this.problems.push(`[${this.name}] ${key} must be ${rule}`);
    return fallback ?? standIn;
  }

  bool(key: string, fallback?: boolean): boolean {
    return this.read(key, fallback, false, "true or false", (v) => typeof v === "boolean");
  }

  positive(key: string, fallback?: number): number {
    return this.read(key, fallback, 1, "a number above 0", (v) => isFiniteNumber(v) && v > 0);
  }

  nonNegative(key: string, fallback?: number): number {
    return this.read(key, fallback, 0, "a number, 0 or more", (v) => isFiniteNumber(v) && v >= 0);
  }

  ratio(key: string, fallback?: number): number {
    return this.read(
      key,
      fallback,
      1,
      "above 0 and at most 1",
      (v) => isFiniteNumber(v) && v > 0 && v <= 1,
    );
  }

  int(key: string, min: number, max: number, fallback?: number): number {
    const rule =
      max === Number.MAX_SAFE_INTEGER
        ? `a whole number, ${min} or more`
        : `a whole number from ${min} to ${max}`;
    return this.read(
      key,
      fallback,
      min,
      rule,
      (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max,
    );
  }

  oneOf<const T extends string>(key: string, values: readonly [T, ...T[]], fallback?: T): T {
    return this.read(key, fallback, values[0], `one of ${values.join(", ")}`, (v) =>
      values.includes(v as T),
    );
  }

  text(key: string, fallback: string, accept: (v: string) => boolean, rule: string): string {
    return this.read(key, fallback, fallback, rule, (v) => typeof v === "string" && accept(v));
  }

  optionalText(key: string, accept: (v: string) => boolean, rule: string): string | undefined {
    this.seen.add(key);
    const value = this.table[key];
    if (value === undefined || (typeof value === "string" && accept(value))) return value;
    this.problems.push(`[${this.name}] ${key} must be ${rule}`);
    return undefined;
  }

  list(
    key: string,
    fallback: readonly string[],
    accept: (v: unknown) => boolean,
    rule: string,
  ): readonly string[] {
    return this.read(key, fallback, fallback, rule, (v) => Array.isArray(v) && v.every(accept));
  }

  rejectUnknown(): void {
    for (const key of Object.keys(this.table))
      if (!this.seen.has(key)) this.problems.push(`[${this.name}] has unknown key ${key}`);
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
