import { InvalidArgumentError, type Command } from "commander";
import { existsSync } from "node:fs";
import { EXIT, TarsError } from "../../core/exit.ts";
import { resolvePaths } from "../../core/paths.ts";
import { PROVIDERS, type Provider } from "../../core/secrets.ts";
import {
  activeModels,
  BASIC_PRICES,
  daysSince,
  findModel,
  loadCatalog,
  mergeListing,
  priceState,
  updateCatalog,
  utcDay,
  type ListingChange,
  type Catalog,
  type ModelEntry,
  type Price,
} from "./catalog.ts";
import {
  confirmOnTty,
  parseModelRef,
  parseProvider,
  refuseInSession,
  type AgentCommandContext,
  type ModelRef,
} from "./cli.ts";
import { DEFAULT_LIMITS, loadConfig, type Limits } from "./config.ts";
import { EFFORTS } from "./effort.ts";
import { ProviderError } from "./provider.ts";
import type { Effort, ListedModel } from "./types.ts";

const THINKING_TYPES = ["enabled", "disabled", "between_tools", "adaptive"];
const LIST_TIMEOUT_MS = 30_000;

/** The levels each endpoint can be sent: Gemini answers xhigh with a 400, neither has max. */
const PROVIDER_EFFORTS: Record<Provider, readonly Effort[]> = {
  anthropic: EFFORTS,
  gemini: ["low", "medium", "high"],
  openrouter: ["low", "medium", "high", "xhigh"],
};

interface RefreshOptions {
  provider: Provider;
  find?: string;
  add: string[];
}

interface SetOptions {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  contextWindow?: number;
  maxOutput?: number;
  effortLevels?: Effort[];
  thinkingTypes?: string[];
  label?: string;
  allowUnusualPrice?: boolean;
}

const PRICE_OPTIONS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;

export function registerModelsCommands(program: Command, ctx: AgentCommandContext): void {
  const paths = () => resolvePaths(ctx.env);
  const today = () => utcDay(ctx.now());
  /** Every write loads the list first: an invalid file is reported, never overwritten. */
  const update = async (change: (catalog: Catalog) => Catalog) => {
    refuseInSession(ctx.env);
    await updateCatalog(paths(), change);
  };
  const entry = (catalog: Catalog, ref: ModelRef): ModelEntry => {
    const found = findModel(catalog, ref.provider, ref.id);
    if (found === undefined)
      throw new TarsError(
        `${ref.provider}/${ref.id} 不在模型清單上；先執行 tars models refresh --provider ${ref.provider}`,
      );
    return found;
  };
  const replace = (catalog: Catalog, ref: ModelRef, next: (e: ModelEntry) => ModelEntry) => {
    const target = entry(catalog, ref);
    return { version: 1 as const, models: catalog.models.map((m) => (m === target ? next(m) : m)) };
  };

  const models = program
    .command("models")
    .description("The model list and prices in ~/.config/tars/models.json.");

  models
    .command("refresh")
    .description("Fetch a provider's model list and fold it into models.json.")
    .option("--provider <name>", PROVIDERS.join(" | "), parseProvider, "anthropic" as Provider)
    .option("--find <text>", "openrouter: list upstream models whose id or name has this text")
    .option(
      "--add <id>",
      "openrouter: add this upstream model as a candidate (repeatable)",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .addHelpText(
      "after",
      `
Anthropic and Gemini: new models join as candidate. OpenRouter lists hundreds, so only models
already in the list are updated; --find searches upstream without writing, --add adds one.
Models gone upstream become retired and lose default. OpenRouter's prices are filled in from
upstream; prices set by hand and active status are never changed here.

Exit codes: 0 done, 1 no key, an invalid list, an --add id not upstream, a provider error or
inside a tars session, 2 usage error.

Examples:
  tars models refresh
  tars models refresh --provider gemini
  tars models refresh --provider openrouter --find <text>
  tars models refresh --provider openrouter --add <vendor>/<id>`,
    )
    .action(async (opts: RefreshOptions) => {
      const { provider } = opts;
      if ((opts.find !== undefined || opts.add.length > 0) && provider !== "openrouter")
        throw new TarsError("--find 與 --add 只用在 --provider openrouter", EXIT.usage);
      if (opts.find !== undefined && opts.add.length > 0)
        throw new TarsError("--find 不寫檔，不能和 --add 一起用", EXIT.usage);
      refuseInSession(ctx.env);
      await loadCatalog(paths());
      const key = await ctx.secrets.get(`llm:${provider}`);
      if (key === null)
        throw new TarsError(`keyring 沒有 llm:${provider}；先執行 tars llm key set ${provider}`);
      const adapter = await ctx.adapterFor(provider, key, ctx.env, ctx.io.err);
      const listed = await adapter.listModels(AbortSignal.timeout(LIST_TIMEOUT_MS)).catch((err) => {
        if (err instanceof ProviderError) throw new TarsError(`無法取得模型清單：${err.message}`);
        throw err;
      });
      if (opts.find !== undefined) return printFound(listed, opts.find);
      const upstream = new Set(listed.map((m) => m.id));
      const unknown = opts.add.filter((id) => !upstream.has(id));
      if (unknown.length > 0)
        throw new TarsError(`上游清單沒有 ${unknown.join(", ")}；用 --find 找正確的 id`);
      // Merged into the list as it is after the fetch, so a `models set` made meanwhile stays.
      let changes: readonly ListingChange[] = [];
      let unlisted = 0;
      let added: ModelEntry[] = [];
      await update((latest) => {
        let listing = listed;
        if (provider === "openrouter") {
          const kept = new Set([
            ...latest.models.filter((m) => m.provider === provider).map((m) => m.id),
            ...opts.add,
          ]);
          listing = listed.filter((m) => kept.has(m.id));
          unlisted = listed.length - listing.length;
        }
        const merged = mergeListing(latest, provider, listing, today());
        changes = merged.changes;
        added = opts.add.flatMap((id) => findModel(merged.catalog, provider, id) ?? []);
        return merged.catalog;
      });
      for (const c of changes) {
        if (c.kind === "added") ctx.io.out(`added      ${provider}/${c.id} (candidate)`);
        if (c.kind === "updated") ctx.io.out(`updated    ${provider}/${c.id}`);
        if (c.kind === "retired") {
          ctx.io.out(`retired    ${provider}/${c.id}`);
          if (c.wasDefault) ctx.io.err(`warning: ${provider} 現在沒有預設模型`);
        }
        if (c.kind === "deprecated")
          ctx.io.err(
            `warning: ${provider}/${c.id} 已被標為 deprecated${c.retiresAt ? `，預定 ${c.retiresAt} 下架` : ""}`,
          );
      }
      ctx.io.out(`${listed.length} models from ${provider}`);
      if (unlisted > 0) ctx.io.out(`上游另有 ${unlisted} 個模型不在清單上，用 --find 找、--add 加`);
      for (const m of added) {
        const ref = `${m.provider}/${m.id}`;
        const missing = missingToEnable(m);
        if (missing.length > 0)
          ctx.io.err(
            `${ref} 缺 ${missing.join("、")}；執行 tars models set ${ref} ${missing.map((o) => `--${o} <n>`).join(" ")}`,
          );
        ctx.io.err(`${ref} 能關掉推理的話，加 --thinking-types disabled`);
      }
    });

  /** --find: id or name, any case; nothing is written. */
  const printFound = (listed: readonly ListedModel[], text: string) => {
    const needle = text.toLowerCase();
    const found = listed.filter(
      (m) => m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle),
    );
    if (found.length === 0) return ctx.io.err(`上游沒有 id 或名稱含「${text}」的模型`);
    for (const m of found) ctx.io.out(`${m.id}\t${m.label}`);
  };

  models
    .command("set")
    .description("Set a model's prices or abilities by hand.")
    .argument("<provider/id>", "the model, e.g. anthropic/<id>", parseModelRef)
    .option("--input <usd>", "input, USD per million tokens", parsePrice)
    .option("--output <usd>", "output, USD per million tokens", parsePrice)
    .option("--cache-read <usd>", "cache read, USD per million tokens", parsePrice)
    .option("--cache-write <usd>", "5-minute cache write, USD per million tokens", parsePrice)
    .option("--cache-write-1h <usd>", "1-hour cache write, USD per million tokens", parsePrice)
    .option("--context-window <tokens>", "context window", parsePositiveInt)
    .option("--max-output <tokens>", "output limit", parsePositiveInt)
    .option("--effort-levels <list>", `comma-separated ${EFFORTS.join(",")}, or none`, (v) =>
      parseList(v, EFFORTS),
    )
    .option(
      "--thinking-types <list>",
      `comma-separated ${THINKING_TYPES.join(",")}, or none`,
      (v) => parseList(v, THINKING_TYPES),
    )
    .option("--label <text>", "display name")
    .option("--allow-unusual-price", "accept a price below 0.01 or above 500")
    .addHelpText(
      "after",
      `
Prices are USD per million tokens, from the provider's console. The price date becomes today
only when --input, --output, --cache-read and --cache-write are all given at once.
A price below 0.01 or above 500 (other than 0) is refused without --allow-unusual-price:
it is usually a per-thousand or per-token figure.

Exit codes: 0 done, 1 not in the list, an unusual price or inside a tars session, 2 usage error.

Examples:
  tars models set anthropic/<id> --input 3 --output 15 --cache-read 0.3 --cache-write 3.75
  tars models set anthropic/<id> --effort-levels low,medium,high --thinking-types adaptive,disabled

Effort levels each provider takes: anthropic ${PROVIDER_EFFORTS.anthropic.join(",")}; gemini
${PROVIDER_EFFORTS.gemini.join(",")}; openrouter ${PROVIDER_EFFORTS.openrouter.join(",")}.`,
    )
    .action(async (ref: ModelRef, opts: SetOptions) => {
      const sendable = PROVIDER_EFFORTS[ref.provider];
      if (opts.effortLevels?.some((l) => !sendable.includes(l)))
        throw new TarsError(
          `${ref.provider} 的模型只接受 --effort-levels ${sendable.join(",")}`,
          EXIT.usage,
        );
      const unusual = PRICE_OPTIONS.filter((k) => {
        const v = opts[k];
        return v !== undefined && v !== 0 && (v < 0.01 || v > 500);
      });
      if (unusual.length > 0 && !opts.allowUnusualPrice)
        throw new TarsError(
          `單價看起來不是「每百萬 token」：${unusual.join(", ")}。確定的話加 --allow-unusual-price`,
        );
      const given = Object.fromEntries(
        PRICE_OPTIONS.flatMap((k) => (opts[k] === undefined ? [] : [[k, opts[k]]])),
      ) as Partial<Price>;
      const confirmed = BASIC_PRICES.every((k) => given[k] !== undefined);
      await update((catalog) =>
        replace(catalog, ref, (e) => ({
          ...e,
          ...(opts.label === undefined ? {} : { label: opts.label }),
          ...(opts.contextWindow === undefined ? {} : { contextWindow: opts.contextWindow }),
          ...(opts.maxOutput === undefined ? {} : { maxOutput: opts.maxOutput }),
          ...(opts.effortLevels === undefined ? {} : { effortLevels: opts.effortLevels }),
          ...(opts.thinkingTypes === undefined ? {} : { thinkingTypes: opts.thinkingTypes }),
          ...(Object.keys(given).length === 0
            ? {}
            : { price: { ...e.price, ...given }, priceSource: "manual" as const }),
          ...(confirmed ? { pricedAt: today() } : {}),
        })),
      );
      ctx.io.out(
        `updated ${ref.provider}/${ref.id}${confirmed ? `; prices dated ${today()}` : ""}`,
      );
    });

  models
    .command("confirm-prices")
    .description("Re-date a provider's active prices after checking them on your terminal.")
    .option("--provider <name>", PROVIDERS.join(" | "), parseProvider, "anthropic" as Provider)
    .addHelpText(
      "after",
      `
Shows each active model's prices on /dev/tty; typing yes dates them today. A price changed
by another command after it was shown is not dated, and the command exits 1 naming it.

Exit codes: 0 confirmed, 1 not confirmed (or some prices changed meanwhile), no terminal or
inside a tars session, 2 usage error.

Examples:
  tars models confirm-prices --provider anthropic`,
    )
    .action(async (opts: { provider: Provider }) => {
      refuseInSession(ctx.env);
      const catalog = await loadCatalog(paths());
      const active = activeModels(catalog, opts.provider);
      if (active.length === 0) throw new TarsError(`${opts.provider} 沒有 active 的模型`);
      const lines = [
        `${opts.provider} 的單價（USD／百萬 token）：`,
        ...active.map((m) => `  ${m.id}  ${priceText(m)}  價目日期 ${m.pricedAt ?? "-"}`),
        "和 Console 上的一致時輸入 yes，價目日期會改成今天。",
      ];
      if (!(await confirmOnTty(ctx.openTerminal, lines)))
        throw new TarsError("沒有確認，價目日期不變");
      const shown = new Map(active.map((m) => [m.id, m.price]));
      const changed: string[] = [];
      let confirmed = 0;
      await update((c) => ({
        version: 1,
        models: c.models.map((m) => {
          if (m.provider !== opts.provider || !shown.has(m.id)) return m;
          if (!samePrice(m.price, shown.get(m.id))) {
            changed.push(`${m.provider}/${m.id}`);
            return m;
          }
          confirmed++;
          return { ...m, pricedAt: today() };
        }),
      }));
      ctx.io.out(`confirmed ${confirmed} ${opts.provider} prices on ${today()}`);
      if (changed.length > 0)
        throw new TarsError(
          `這些模型的單價在顯示後被改過，沒有確認：${changed.join(", ")}；重新執行 tars models confirm-prices`,
        );
    });

  models
    .command("enable")
    .description("Make a model active, once its prices and limits are filled in.")
    .argument("<provider/id>", "the model, e.g. anthropic/<id>", parseModelRef)
    .addHelpText(
      "after",
      `
Needs the four basic prices, the context window and the output limit (tars models set).

Exit codes: 0 done, 1 something missing, retired or inside a tars session, 2 usage error.

Examples:
  tars models enable anthropic/<id>`,
    )
    .action(async (ref: ModelRef) => {
      await update((catalog) => {
        const e = entry(catalog, ref);
        if (e.status === "retired") throw new TarsError(`${ref.provider}/${ref.id} 已下架`);
        const missing = [
          ...BASIC_PRICES.filter((k) => e.price?.[k] === undefined).map((k) => `price.${k}`),
          ...(e.contextWindow === undefined ? ["contextWindow"] : []),
          ...(e.maxOutput === undefined ? ["maxOutput"] : []),
        ];
        if (missing.length > 0)
          throw new TarsError(
            `${ref.provider}/${ref.id} 缺 ${missing.join(", ")}；用 tars models set 補上`,
          );
        return replace(catalog, ref, (m) => ({ ...m, status: "active" }));
      });
      ctx.io.out(`enabled ${ref.provider}/${ref.id}`);
    });

  models
    .command("disable")
    .description("Stop using a model; it also stops being the default.")
    .argument("<provider/id>", "the model, e.g. anthropic/<id>", parseModelRef)
    .addHelpText(
      "after",
      `
Exit codes: 0 done, 1 not in the list or inside a tars session, 2 usage error.

Examples:
  tars models disable anthropic/<id>`,
    )
    .action(async (ref: ModelRef) => {
      await update((catalog) =>
        replace(catalog, ref, (m) => {
          const { default: _wasDefault, ...rest } = m;
          return { ...rest, status: "disabled" };
        }),
      );
      ctx.io.out(`disabled ${ref.provider}/${ref.id}`);
    });

  models
    .command("default")
    .description("Make an active model the provider's default for new conversations.")
    .argument("<provider/id>", "the model, e.g. anthropic/<id>", parseModelRef)
    .addHelpText(
      "after",
      `
Exit codes: 0 done, 1 not active or inside a tars session, 2 usage error.

Examples:
  tars models default anthropic/<id>`,
    )
    .action(async (ref: ModelRef) => {
      await update((catalog) => {
        if (entry(catalog, ref).status !== "active") {
          const active = activeModels(catalog, ref.provider).map((m) => `  ${m.provider}/${m.id}`);
          throw new TarsError(
            `${ref.provider}/${ref.id} 不是 active。${ref.provider} active 的模型：\n${active.join("\n") || "  （沒有）"}`,
          );
        }
        return {
          version: 1,
          models: catalog.models.map((m) => {
            if (m.provider !== ref.provider) return m;
            const { default: _, ...rest } = m;
            return m.id === ref.id ? { ...rest, default: true } : rest;
          }),
        };
      });
      ctx.io.out(`default for ${ref.provider}: ${ref.id}`);
    });

  models
    .command("list")
    .description("Show every model with its status, abilities, prices and price age.")
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Price state: ok; stale past price_warn_days; refused past price_refuse_days (tars chat will
not use the model); missing without a price date.

Exit codes: 0 done, 1 an invalid list.

Examples:
  tars models list
  tars models list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      const catalog = await loadCatalog(paths());
      const limits = await listLimits();
      const now = ctx.now();
      const rows = catalog.models.map((m) => ({
        ...m,
        priceAgeDays: m.pricedAt === undefined ? null : daysSince(m.pricedAt, now),
        priceState: priceState(m, limits, now),
      }));
      if (opts.json) return ctx.io.out(JSON.stringify({ models: rows }));
      if (rows.length === 0) return ctx.io.err("沒有模型；先執行 tars models refresh");
      for (const m of rows)
        ctx.io.out(
          [
            m.provider,
            m.id,
            m.status,
            m.default === true ? "default" : "-",
            m.contextWindow ?? "-",
            m.effortLevels === undefined
              ? "effort:?"
              : `effort:${m.effortLevels.join(",") || "none"}`,
            priceText(m),
            `source:${m.priceSource ?? "-"}`,
            m.pricedAt === undefined ? "priced:-" : `priced:${m.pricedAt} (${m.priceAgeDays}d)`,
            m.priceState,
          ].join("\t"),
        );
    });

  /** The price-age lines from config.toml; the defaults before `tars config init`. */
  const listLimits = async (): Promise<Limits> =>
    existsSync(paths().configFile) ? (await loadConfig(paths())).config.limits : DEFAULT_LIMITS;
}

const PRICE_KEYS = [...BASIC_PRICES, "cacheWrite1h"] as const;

const PRICE_FLAGS: Record<(typeof BASIC_PRICES)[number], string> = {
  input: "input",
  output: "output",
  cacheRead: "cache-read",
  cacheWrite: "cache-write",
};

/** The `tars models set` options an added model still needs before `enable` accepts it. */
function missingToEnable(e: ModelEntry): string[] {
  return [
    ...BASIC_PRICES.filter((k) => e.price?.[k] === undefined).map((k) => PRICE_FLAGS[k]),
    ...(e.contextWindow === undefined ? ["context-window"] : []),
    ...(e.maxOutput === undefined ? ["max-output"] : []),
  ];
}
const samePrice = (a: Partial<Price> | undefined, b: Partial<Price> | undefined) =>
  PRICE_KEYS.every((k) => a?.[k] === b?.[k]);

function priceText(m: ModelEntry): string {
  const p = m.price ?? {};
  const v = (x: number | undefined) => (x === undefined ? "-" : String(x));
  return `in ${v(p.input)} out ${v(p.output)} cr ${v(p.cacheRead)} cw ${v(p.cacheWrite)}${p.cacheWrite1h === undefined ? "" : ` cw1h ${p.cacheWrite1h}`}`;
}

function parsePrice(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0)
    throw new InvalidArgumentError("use a number, 0 or more (USD per million tokens).");
  return n;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n <= 0) throw new InvalidArgumentError("use a whole number above 0.");
  return n;
}

function parseList<T extends string>(value: string, allowed: readonly T[]): T[] {
  if (value === "none") return [];
  const items = value.split(",").map((s) => s.trim());
  const bad = items.filter((s) => !allowed.includes(s as T));
  if (bad.length > 0 || new Set(items).size !== items.length)
    throw new InvalidArgumentError(`use a comma-separated list of ${allowed.join(", ")}, or none.`);
  return items as T[];
}
