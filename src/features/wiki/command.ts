import type { Database } from "bun:sqlite";
import type { Command } from "commander";
import { TarsError } from "../../core/exit.ts";
import { resolvePaths, type TarsPaths } from "../../core/paths.ts";
import type { AgentCommandContext } from "../agent/cli.ts";
import { loadConfig } from "../agent/config.ts";
import { usd } from "../agent/cost-command.ts";
import { openDb } from "../agent/db.ts";
import { sleepAbortable } from "../agent/engine.ts";
import { visible } from "../agent/tty-frontend.ts";
import { NEWER_WIKI_DB, openWikiDb, rawSpend } from "./db.ts";
import { sourceRef } from "./evidence.ts";
import { CATEGORIES } from "./page.ts";
import { minuteText, reasonLabel, runSync } from "./sync.ts";

type Signal = "SIGINT" | "SIGTERM";

export interface WikiCommandContext extends AgentCommandContext {
  /** Where SIGINT and SIGTERM arrive: the process, or a test's emitter. */
  readonly signals: {
    on(signal: Signal, handler: () => void): unknown;
    off(signal: Signal, handler: () => void): unknown;
  };
}

const EXIT_SIGTERM = 143;

/** wiki.db for a reader: undefined when there is none yet; a newer one is exit 1. */
export function readWikiDb(paths: TarsPaths): Database | undefined {
  const db = openWikiDb(paths, { readonly: true });
  if (db === "newer") throw new TarsError(NEWER_WIKI_DB);
  return db;
}

export function registerWikiCommands(
  program: Command,
  ctx: WikiCommandContext,
  exitWith: (code: number) => void,
): void {
  const wiki = program
    .command("wiki")
    .description("The owner's knowledge base, built from tars chat conversations.");

  wiki
    .command("sync")
    .description("Read new conversation turns into the knowledge base pages, within its budget.")
    .option("--reindex", "rebuild both search indexes and index.md, without any model request")
    .addHelpText(
      "after",
      `
Writes wiki.db and <data>/wiki; works while tars chat runs, never two syncs at once. Reaching
a cap stops it with exit 0: the progress is saved and the next run goes on. Refused inside a
tars session: its requests spend the API key.

Exit codes: 0 done, or stopped at a cap; 1 config, key, model or lock problem, <data>/wiki is a
symlink, or SIGINT; 2 usage error; 143 SIGTERM.

Examples:
  tars wiki sync
  tars wiki sync --reindex`,
    )
    .action(async (opts: { reindex?: boolean }) => {
      const controller = new AbortController();
      let terminated = false;
      const onInt = () => controller.abort();
      const onTerm = () => {
        terminated = true;
        controller.abort();
      };
      ctx.signals.on("SIGINT", onInt);
      ctx.signals.on("SIGTERM", onTerm);
      try {
        const r = await runSync(
          {
            paths: resolvePaths(ctx.env),
            env: ctx.env,
            secrets: ctx.secrets,
            adapterFor: ctx.adapterFor,
            now: () => ctx.now(),
            sleep: sleepAbortable,
            io: ctx.io,
          },
          { reindex: opts.reindex === true },
          controller.signal,
        );
        exitWith(
          terminated ? EXIT_SIGTERM : r.state === "completed" || r.state === "stopped" ? 0 : 1,
        );
      } finally {
        ctx.signals.off("SIGINT", onInt);
        ctx.signals.off("SIGTERM", onTerm);
      }
    });

  wiki
    .command("status")
    .description("Where sync stands: pages, what waits, what failed, and its spend.")
    .addHelpText(
      "after",
      `
Read-only; takes no lock.

Exit codes: 0 done; 1 no config.toml, or a wiki.db made by a newer tars.

Examples:
  tars wiki status`,
    )
    .action(async () => {
      const paths = resolvePaths(ctx.env);
      const { config } = await loadConfig(paths);
      const db = readWikiDb(paths);
      if (db === undefined) return ctx.io.out("還沒有同步過");
      try {
        const agent = openDb(paths, { readonly: true });
        try {
          for (const line of statusLines(db, agent, ctx.now(), config.wiki)) ctx.io.out(line);
        } finally {
          agent?.close();
        }
      } finally {
        db.close();
      }
    });
}

const count = (db: Database, sql: string, ...params: (string | number)[]) =>
  (db.query(sql).get(...params) as { n: number }).n;

/** Chat turns agent.db has past the scan cursor. */
export function unindexedTurns(db: Database, agent: Database | undefined): number {
  if (agent === undefined) return 0;
  const cursor =
    (db.query("SELECT value FROM cursors WHERE name = 'scan'").get() as { value: number } | null)
      ?.value ?? 0;
  return count(agent, "SELECT COUNT(*) AS n FROM turns WHERE rowid > ? AND kind = 'chat'", cursor);
}

function statusLines(
  db: Database,
  agent: Database | undefined,
  now: Date,
  caps: { daily_cap_usd: number; monthly_cap_usd: number },
): string[] {
  const out: string[] = [];
  const byCategory = new Map(
    (
      db
        .query(
          "SELECT substr(path, 1, instr(path, '/') - 1) AS c, COUNT(*) AS n FROM pages GROUP BY c",
        )
        .all() as { c: string; n: number }[]
    ).map((r) => [r.c, r.n]),
  );
  out.push(`頁面：${CATEGORIES.map((c) => `${c} ${byCategory.get(c) ?? 0}`).join("、")}`);
  const scanned = db.query("SELECT value FROM meta WHERE key = 'scanned_at'").get() as {
    value: string;
  } | null;
  out.push(
    scanned === null
      ? "還沒有掃描過"
      : `頁面索引到 ${minuteText(Number(scanned.value))}；原始紀錄索引到 ${minuteText(Number(scanned.value))}，之後有 ${unindexedTurns(db, agent)} 個回合還沒進索引`,
  );
  out.push(
    `待抽取的回合：${count(db, "SELECT COUNT(*) AS n FROM sources WHERE state = 'pending'")}；待整併的候選：${count(db, "SELECT COUNT(*) AS n FROM candidates WHERE state = 'pending'")}；等待中的回合（還在執行）：${count(db, "SELECT COUNT(*) AS n FROM waiting_turns")}`,
  );
  const failedSources = db
    .query(
      "SELECT turn_id AS turnId, conv_id AS convId, attempts, last_error AS error FROM sources WHERE state = 'failed' ORDER BY turn_rowid",
    )
    .all() as { turnId: string; convId: string; attempts: number; error: string | null }[];
  const failedCandidates = db
    .query(
      "SELECT id, page, attempts, last_error AS error FROM candidates WHERE state = 'failed' ORDER BY id",
    )
    .all() as { id: number; page: string; attempts: number; error: string | null }[];
  out.push(`失敗：來源回合 ${failedSources.length}、候選 ${failedCandidates.length}`);
  for (const f of failedSources)
    out.push(
      `  ${sourceRef(f.convId, f.turnId)}：${reasonLabel(f.error ?? "")}（${f.attempts} 次）`,
    );
  for (const f of failedCandidates)
    out.push(visible(`  c${f.id} ${f.page}：${reasonLabel(f.error ?? "")}（${f.attempts} 次）`));
  const blocked = db
    .query("SELECT path, last_error AS error FROM pages WHERE state = 'blocked' ORDER BY path")
    .all() as { path: string; error: string | null }[];
  out.push(`解析不了的頁面：${blocked.length}`);
  for (const b of blocked) out.push(visible(`  ${b.path}：${b.error ?? ""}`).replace(/\n/g, " "));
  out.push(
    `內容被裁掉中段的回合：${count(db, "SELECT COUNT(*) AS n FROM sources WHERE clipped = 1")}`,
  );
  const last = db
    .query(
      "SELECT state, stop_reason AS reason, started_at AS at FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { state: string; reason: string | null; at: number } | null;
  out.push(
    last === null
      ? "上次同步：沒有"
      : `上次同步：${minuteText(last.at)}，${last.state}${last.reason === null ? "" : `（${visible(reasonLabel(last.reason))}）`}`,
  );
  const raw = rawSpend(db, now);
  out.push(
    `同步的花費：今日 ${usd(raw.today)} / ${usd(caps.daily_cap_usd)}，本月 ${usd(raw.month)} / ${usd(caps.monthly_cap_usd)} USD`,
  );
  return out;
}
