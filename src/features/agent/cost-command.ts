import { InvalidArgumentError, type Command } from "commander";
import type { Database } from "bun:sqlite";
import { TarsError } from "../../core/exit.ts";
import { resolvePaths, type TarsPaths } from "../../core/paths.ts";
import type { Provider } from "../../core/secrets.ts";
import { confirmOnTty, parseProvider, refuseInSession, type AgentCommandContext } from "./cli.ts";
import { loadConfig, type TarsConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { adjust, recentRequests, status, type BudgetStatus, type RecentRequest } from "./ledger.ts";

const RECENT = 20;

export const usd = (n: number) => n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2);

export function statusLine(s: BudgetStatus): string {
  return `${s.provider}: 本期已用 ${usd(s.spentUsd)} / 額度 ${usd(s.quotaUsd)} USD（提醒 ${usd(s.warnUsd)}，停用 ${usd(s.stopUsd)}）；今日 ${usd(s.todayUsd)} / ${usd(s.dailyCapUsd)}；${s.state}`;
}

/** Every configured provider's budget; with no database yet, all zero. */
export function budgetStatuses(
  config: TarsConfig,
  db: Parameters<typeof status>[0],
  now: Date,
): BudgetStatus[] {
  return Object.entries(config.providers).map(([provider, cfg]) =>
    status(db, provider as Provider, cfg, now),
  );
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

Exit codes: 0 done, 1 no config.toml.

Examples:
  tars cost
  tars cost --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      const paths = resolvePaths(ctx.env);
      const { config } = await loadConfig(paths);
      withReadDb(paths, (db) => {
        const providers = budgetStatuses(config, db, ctx.now());
        const recent = recentRequests(db, RECENT);
        if (opts.json) return ctx.io.out(JSON.stringify({ providers, recent }));
        for (const s of providers) ctx.io.out(statusLine(s));
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
      const current = withReadDb(paths, (db) => status(db, provider, cfg, ctx.now()).spentUsd);
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
