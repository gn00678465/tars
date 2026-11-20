import { InvalidArgumentError, type Command } from "commander";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { TarsError } from "../../core/exit.ts";
import { resolvePaths, type TarsPaths } from "../../core/paths.ts";
import type { Provider } from "../../core/secrets.ts";
import { confirmOnTty, parseProvider, refuseInSession, type AgentCommandContext } from "./cli.ts";
import { wikiSpend, type WikiSpend } from "../wiki/db.ts";
import { loadConfig, type TarsConfig, type WikiConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { adjust, recentRequests, status, type BudgetStatus, type RecentRequest } from "./ledger.ts";
import { REASON_TEXT } from "./request.ts";

const RECENT = 20;

export const usd = (n: number) => n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2);

export function statusLine(s: BudgetStatus): string {
  return `${s.provider}: 本期已用 ${usd(s.spentUsd)} / 額度 ${usd(s.quotaUsd)} USD（提醒 ${usd(s.warnUsd)}，停用 ${usd(s.stopUsd)}）；今日 ${usd(s.todayUsd)} / ${usd(s.dailyCapUsd)}；${s.state}`;
}

export function wikiLine(w: WikiSpend, caps: WikiConfig): string {
  return `  其中 wiki 同步：本期 ${usd(w.period)}；今日 ${usd(w.rawToday)} / ${usd(caps.daily_cap_usd)}；本月 ${usd(w.rawMonth)} / ${usd(caps.monthly_cap_usd)}`;
}

export interface ProviderBudget extends BudgetStatus {
  /** Sync's share, already in the sums above; null without a wiki.db. */
  readonly wiki: WikiSpend | null;
}

/**
 * Every configured provider's budget, wiki sync's spend included; with no database yet, all
 * zero. Throws when wiki.db cannot be read, since the totals would then be short.
 */
export function budgetStatuses(
  config: TarsConfig,
  db: Parameters<typeof status>[0],
  now: Date,
  paths: TarsPaths,
): ProviderBudget[] {
  const hasWiki = existsSync(paths.wikiDb);
  return Object.entries(config.providers).map(([name, cfg]) => {
    const provider = name as Provider;
    const wiki = wikiSpend(paths, db, provider, cfg, now);
    if (wiki === undefined) throw new TarsError(REASON_TEXT.budget_unreadable);
    return { ...status(db, provider, cfg, now, wiki), wiki: hasWiki ? wiki : null };
  });
}

function recentLine(r: RecentRequest): string {
  return [
    new Date(r.at).toISOString(),
    r.model,
    `in ${r.uncachedInputTokens}`,
    `cr ${r.cacheReadTokens}`,
    `cw ${r.cacheWriteTokens}`,
    `out ${r.outputTokens}`,
    `think ${r.thinkingTokens}`,
    `${usd(r.costUsd)} USD`,
    r.state,
    r.costSource,
  ].join("\t");
}

export function registerCostCommands(program: Command, ctx: AgentCommandContext): void {
  const cost = program
    .command("cost")
    .description("What tars chat has spent per provider, and its latest model requests.")
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Read-only; works while tars chat runs. state: ok, warn (past warn_ratio), stopped (past
stop_ratio: tars chat sends nothing more this period).

Exit codes: 0 done, 1 no config.toml, or a wiki.db this tars cannot read.

Examples:
  tars cost
  tars cost --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      const paths = resolvePaths(ctx.env);
      const { config } = await loadConfig(paths);
      withReadDb(paths, (db) => {
        const providers = budgetStatuses(config, db, ctx.now(), paths);
        const recent = recentRequests(db, RECENT);
        if (opts.json) return ctx.io.out(JSON.stringify({ providers, recent }));
        for (const s of providers) {
          ctx.io.out(statusLine(s));
          if (s.wiki !== null) ctx.io.out(wikiLine(s.wiki, config.wiki));
        }
        if (recent.length > 0) ctx.io.out("\n最近的模型請求：");
        for (const r of recent) ctx.io.out(recentLine(r));
      });
    });

  cost
    .command("adjust")
    .description("Set this period's spend from the provider's bill, after you confirm.")
    .argument("<provider>", "anthropic", parseProvider)
    .requiredOption("--spent <usd>", "this period's spend so far, in USD", parseAmount)
    .option("--note <text>", "where the figure came from")
    .addHelpText(
      "after",
      `
From now on the period's spend is this figure plus the requests made after it. Asks on
/dev/tty; does not need tars chat to stop.

Exit codes: 0 recorded, 1 not confirmed, no terminal or inside a tars session, 2 usage error.

Examples:
  tars cost adjust anthropic --spent 12.40 --note "console 2026-11-19"`,
    )
    .action(async (provider: Provider, opts: { spent: number; note?: string }) => {
      refuseInSession(ctx.env);
      const paths = resolvePaths(ctx.env);
      const { config } = await loadConfig(paths);
      const cfg = config.providers[provider];
      if (cfg === undefined) throw new TarsError(`config.toml 沒有 [providers.${provider}]`);
      const current = withReadDb(paths, (db) => {
        const wiki = wikiSpend(paths, db, provider, cfg, ctx.now());
        if (wiki === undefined) throw new TarsError(REASON_TEXT.budget_unreadable);
        return status(db, provider, cfg, ctx.now(), wiki).spentUsd;
      });
      const lines = [
        `${provider} 本機帳的本期已用：${usd(current)} USD`,
        `改成：${usd(opts.spent)} USD`,
      ];
      if (!(await confirmOnTty(ctx.openTerminal, lines))) throw new TarsError("沒有確認，帳不變");
      // Opened for writing only now, so a "no" leaves nothing on disk. The adjustment is placed
      // at confirmation: requests made while the question was open are part of what it covers.
      const db = await openDb(paths);
      try {
        adjust(db, provider, opts.spent, opts.note, ctx.now());
        ctx.io.out(`adjusted ${provider}: ${usd(opts.spent)} USD`);
      } finally {
        db.close();
      }
    });
}

/** Runs `read` on a read-only connection, or on undefined when there is no database yet. */
export function withReadDb<T>(paths: TarsPaths, read: (db: Database | undefined) => T): T {
  const db = openDb(paths, { readonly: true });
  try {
    return read(db);
  } finally {
    db?.close();
  }
}

function parseAmount(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0)
    throw new InvalidArgumentError("use an amount in USD, 0 or more.");
  return n;
}
