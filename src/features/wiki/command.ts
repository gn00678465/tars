import type { Database } from "bun:sqlite";
import { InvalidArgumentError, type Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, TarsError } from "../../core/exit.ts";
import { resolvePaths, type TarsPaths } from "../../core/paths.ts";
import type { AgentCommandContext } from "../agent/cli.ts";
import { loadConfig } from "../agent/config.ts";
import { usd } from "../agent/cost-command.ts";
import { openDb } from "../agent/db.ts";
import { sleepAbortable } from "../agent/engine.ts";
import { findConversation, findTurn } from "../agent/store.ts";
import { visible } from "../agent/tty-frontend.ts";
import { NEWER_WIKI_DB, openWikiDb, rawSpend } from "./db.ts";
import { readTurnParts, sourceRef, toolLine } from "./evidence.ts";
import { byUpdated } from "./index-file.ts";
import {
  CATEGORIES,
  minuteText,
  okTerm,
  parseDay,
  parseLimit,
  parsePage,
  parsePagePath,
  SEARCH,
  SOURCE_ARG,
  summarySources,
  type Category,
} from "./page.ts";
import { formatResults, searchTerms, searchWiki, unindexedTurns } from "./search.ts";
import { reasonLabel, runSync } from "./sync.ts";
import { matchQuery } from "./tokenize.ts";

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

  registerReadCommands(wiki, ctx);
}

const usage = (message: string) => new InvalidArgumentError(message);

function collectAlso(value: string, prev: string[] = []): string[] {
  if (value.startsWith("-")) throw usage("--also 的值不能以 - 開頭。");
  if (!okTerm(value)) throw usage(`每個詞 1 到 ${SEARCH.termChars} 個字。`);
  if (prev.length >= SEARCH.also) throw usage(`--also 最多 ${SEARCH.also} 個。`);
  return [...prev, value];
}

function dayArg(value: string): string {
  const day = parseDay(value);
  if (day === undefined) throw usage("寫成 YYYY-MM-DD，而且是真的日期（UTC）。");
  return day;
}

function limitArg(value: string): number {
  const n = parseLimit(value);
  if (n === undefined) throw usage(`1 到 ${SEARCH.limit} 的整數。`);
  return n;
}

function categoryArg(value: string): Category {
  if (!CATEGORIES.includes(value as Category))
    throw usage(`分類是 ${CATEGORIES.join("、")} 其中之一。`);
  return value as Category;
}

function pagePathArg(value: string): string {
  const path = parsePagePath(value);
  if (path === undefined) throw usage("寫成 <分類>/<slug>，slug 是小寫英數與連字號。");
  return path;
}

function sourceArg(value: string): string {
  if (!SOURCE_ARG.test(value)) throw usage("寫成 <對話>/<回合>，各 4 碼以上的編號結尾。");
  return value;
}

/** Runs `read` with both databases open for reading; either may not exist yet. */
function withDbs<T>(
  paths: TarsPaths,
  read: (wiki: Database | undefined, agent: Database | undefined) => T,
): T {
  const wiki = readWikiDb(paths);
  try {
    const agent = openDb(paths, { readonly: true });
    try {
      return read(wiki, agent);
    } finally {
      agent?.close();
    }
  } finally {
    wiki?.close();
  }
}

interface PageListRow {
  path: string;
  title: string;
  aliases: string;
  created: string;
  updated: string;
  state: "ok" | "blocked";
  next_item: number;
  last_error: string | null;
}

function registerReadCommands(wiki: Command, ctx: WikiCommandContext): void {
  const out = (line: string) => ctx.io.out(line);

  wiki
    .command("search")
    .description("Search the wiki pages and the raw conversation records, ranked apart.")
    .argument("<query>", "what to look for, 1 to 100 characters")
    .option("--also <word>", "another way to say it; up to 6", collectAlso)
    .option("--since <date>", "favour results on or after this UTC day (YYYY-MM-DD)", dayArg)
    .option("--until <date>", "favour results on or before this UTC day (YYYY-MM-DD)", dayArg)
    .option(
      "--limit <n>",
      `results per group, 1 to ${SEARCH.limit}; ${SEARCH.defaultLimit} by default`,
      limitArg,
    )
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Read-only; takes no lock. A date range only moves results up: the rest stay listed.

Exit codes: 0 done, with or without results; 1 a wiki.db made by a newer tars; 2 usage error.

Examples:
  tars wiki search 王小明 --also 小明 --also Ming
  tars wiki search 台積電 --since 2026-11-01 --limit 5
  tars wiki search -- "-5% 的那天" --json`,
    )
    .action(
      (
        query: string,
        opts: { also?: string[]; since?: string; until?: string; limit?: number; json?: boolean },
      ) => {
        if (!okTerm(query)) throw new TarsError(`查詢要 1 到 ${SEARCH.termChars} 個字`, EXIT.usage);
        if (opts.since !== undefined && opts.until !== undefined && opts.since > opts.until)
          throw new TarsError("--since 不能晚於 --until", EXIT.usage);
        const q = {
          query,
          also: opts.also ?? [],
          ...(opts.since === undefined ? {} : { since: opts.since }),
          ...(opts.until === undefined ? {} : { until: opts.until }),
          limit: opts.limit ?? SEARCH.defaultLimit,
        };
        withDbs(resolvePaths(ctx.env), (w, agent) => {
          const r = searchWiki({ wiki: w, agent }, q);
          if (opts.json === true) return out(JSON.stringify(r));
          formatResults(r).forEach(out);
          if (searchTerms(q).every((t) => matchQuery(t) === undefined))
            out("查詢裡沒有可以搜尋的字");
        });
      },
    );

  wiki
    .command("list")
    .description("List the wiki pages, newest first within each category.")
    .argument("[category]", CATEGORIES.join(" | "), categoryArg)
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Read-only; takes no lock.

Exit codes: 0 done; 1 a wiki.db made by a newer tars; 2 unknown category.

Examples:
  tars wiki list
  tars wiki list people --json`,
    )
    .action((category: Category | undefined, opts: { json?: boolean }) => {
      const db = readWikiDb(resolvePaths(ctx.env));
      try {
        const rows = (db?.query("SELECT * FROM pages").all() ?? []) as PageListRow[];
        const pages = CATEGORIES.filter((c) => category === undefined || c === category).flatMap(
          (c) =>
            rows
              .filter((r) => r.path.startsWith(`${c}/`))
              .map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[], type: c }))
              .toSorted(byUpdated),
        );
        if (opts.json === true) {
          const counts = Object.fromEntries(
            CATEGORIES.map((c) => [c, rows.filter((r) => r.path.startsWith(`${c}/`)).length]),
          );
          return out(
            JSON.stringify({
              counts,
              pages: pages.map((p) => ({
                path: p.path,
                title: p.title,
                aliases: p.aliases,
                type: p.type,
                created: p.created,
                updated: p.updated,
                state: p.state,
              })),
            }),
          );
        }
        if (db === undefined) return out("還沒有同步過");
        for (const p of pages)
          out(
            visible(
              `${p.path}｜${p.title}｜${p.aliases.join("、")}｜${p.updated}${p.state === "blocked" ? "｜解析不了" : ""}`,
            ).replace(/\n/g, " "),
          );
      } finally {
        db?.close();
      }
    });

  wiki
    .command("show")
    .description("Print one wiki page: its file as it is now.")
    .argument("<path>", "<category>/<slug>", pagePathArg)
    .option("--json", "print the page, parsed, as JSON")
    .addHelpText(
      "after",
      `
Read-only; takes no lock.

Exit codes: 0 done; 1 no such page; 2 a path that breaks the rules.

Examples:
  tars wiki show people/wang-xiaoming
  tars wiki show projects/moving --json`,
    )
    .action(async (path: string, opts: { json?: boolean }) => {
      const paths = resolvePaths(ctx.env);
      const markdown = await readFile(join(paths.wiki, `${path}.md`), "utf8").catch(
        () => undefined,
      );
      if (markdown === undefined) throw new TarsError(`沒有這一頁：${path}`);
      const db = readWikiDb(paths);
      let row: PageListRow | null;
      try {
        row = (db?.query("SELECT * FROM pages WHERE path = ?").get(path) ??
          null) as PageListRow | null;
      } finally {
        db?.close();
      }
      const parsed = parsePage(markdown, path, row?.next_item ?? 1);
      const page = parsed.ok ? parsed.page : undefined;
      const error = parsed.ok ? null : parsed.error;
      const updated = page?.updated ?? row?.updated ?? "";
      if (opts.json === true) {
        const entries = (list: NonNullable<typeof page>["facts"]) =>
          list.map((e) => ({ id: `i${e.id}`, text: e.text, sources: [...e.sources] }));
        return out(
          JSON.stringify({
            path,
            title: page?.title ?? row?.title ?? path.slice(path.indexOf("/") + 1),
            type: path.slice(0, path.indexOf("/")),
            aliases: page?.aliases ?? (row === null ? [] : (JSON.parse(row.aliases) as string[])),
            created: page?.created ?? row?.created ?? "",
            updated,
            state: page === undefined ? "blocked" : "ok",
            error,
            summary:
              page === undefined
                ? null
                : { text: page.summary, sources: summarySources(page.summary) },
            facts: page === undefined ? null : entries(page.facts),
            open: page === undefined ? null : entries(page.open),
            related: page === undefined ? null : page.related,
            markdown,
          }),
        );
      }
      out(visible(`${path}｜更新 ${updated}${error === null ? "" : `｜解析不了：${error}`}`));
      out("");
      out(visible(markdown.replace(/\n$/, "")));
    });

  wiki
    .command("source")
    .description("Print one conversation turn: what the owner and tars said, and the tools it ran.")
    .argument("<ref>", "<conversation>/<turn>, each a tail of 4 or more characters", sourceArg)
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Read-only; takes no lock. Tool results are not printed.

Exit codes: 0 done; 1 no such turn, or a short id that names more than one; 2 usage error.

Examples:
  tars wiki source a1b2c3d4/9f8e7d6c
  tars wiki source a1b2c3d4/9f8e7d6c --json`,
    )
    .action((ref: string, opts: { json?: boolean }) => {
      const agent = openDb(resolvePaths(ctx.env), { readonly: true });
      if (agent === undefined) throw new TarsError("還沒有對話");
      try {
        const [c, t] = ref.split("/") as [string, string];
        const conv = findConversation(agent, c);
        const turn = findTurn(agent, conv.id, t);
        const parts = readTurnParts(agent, turn);
        const source = sourceRef(conv.id, turn.id);
        const model = `${conv.provider}/${conv.model}`;
        if (opts.json === true)
          return out(
            JSON.stringify({
              source,
              conv: conv.id,
              turn: turn.id,
              startedAt: turn.startedAt,
              model,
              state: turn.state,
              owner: parts.owner,
              assistant: parts.assistant,
              tools: parts.tools,
            }),
          );
        out(visible(`${source}｜${minuteText(turn.startedAt)}｜${model}｜${turn.state}`));
        out("擁有者：");
        out(visible(parts.owner));
        out("tars：");
        out(visible(parts.assistant.join("\n")));
        for (const tool of parts.tools) out(visible(`工具：${toolLine(tool)}`).replace(/\n/g, " "));
      } finally {
        agent.close();
      }
    });
}

const count = (db: Database, sql: string, ...params: (string | number)[]) =>
  (db.query(sql).get(...params) as { n: number }).n;

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
