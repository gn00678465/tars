import type { Database } from "bun:sqlite";
import { InvalidArgumentError, Option, type Command } from "commander";
import { TarsError } from "../../core/exit.ts";
import { inSession, resolvePaths, type TarsPaths } from "../../core/paths.ts";
import type { Provider } from "../../core/secrets.ts";
import type { Terminal } from "../../core/terminal.ts";
import { SLUG } from "../script/metadata.ts";
import { wikiSpend } from "../wiki/db.ts";
import { activeModels, defaultModel, findModel, loadCatalog, resolve } from "./catalog.ts";
import { parseModelRef, type AgentCommandContext, type ModelRef } from "./cli.ts";
import { loadConfig, type TarsConfig } from "./config.ts";
import { budgetStatuses, statusLine, wikiLine, withReadDb } from "./cost-command.ts";
import { acquireLock, openDb } from "./db.ts";
import { assertSelectable, EFFORTS, parseEffort } from "./effort.ts";
import { createEngine, sleepAbortable, type Engine, type TurnOutcome } from "./engine.ts";
import { usageCost } from "./ledger.ts";
import { createLog } from "./log.ts";
import {
  LOCAL_ONLY_SKILLS,
  loadSkillIndex,
  skillInvocationText,
  type SkillEntry,
} from "./prompt.ts";
import { reconcile, reconcileSummary } from "./reconcile.ts";
import * as store from "./store.ts";
import { TtyFrontend } from "./tty-frontend.ts";
import type { Effort, Item } from "./types.ts";

type Signal = "SIGINT" | "SIGTERM";

export interface ChatContext extends AgentCommandContext {
  readonly selfCommand: readonly string[];
  approveCommand(name: string): string;
  /** Where SIGINT and SIGTERM arrive: the process, or a test's emitter. */
  readonly signals: {
    on(signal: Signal, handler: () => void): unknown;
    off(signal: Signal, handler: () => void): unknown;
  };
}

interface ChatOptions {
  model?: ModelRef;
  effort?: Effort;
  resume?: string;
  list?: boolean;
  message?: string;
}

const EXIT_SIGTERM = 143;
const RESUME_ITEMS = 10;
const LINE_CHARS = 80;

export const BUILTINS = ["new", "effort", "compact", "model", "cost", "quit", "help"] as const;
type Builtin = (typeof BUILTINS)[number];

export type Slash =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "builtin"; readonly name: Builtin; readonly arg: string }
  | { readonly kind: "skill"; readonly skill: SkillEntry; readonly content: string }
  | { readonly kind: "local_only"; readonly skill: SkillEntry }
  | { readonly kind: "unknown"; readonly name: string };

/** A line typed at the prompt: a message, or a command that is not sent to the model. */
export function parseSlash(line: string, skills: readonly SkillEntry[]): Slash {
  if (!line.startsWith("/")) return { kind: "message", text: line };
  if (line.startsWith("//")) return { kind: "message", text: line.slice(1) };
  const [, name = "", rest = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(line) ?? [];
  const arg = rest.trim();
  if ((BUILTINS as readonly string[]).includes(name))
    return { kind: "builtin", name: name as Builtin, arg };
  const skill = SLUG.test(name) ? skills.find((s) => s.name === name) : undefined;
  if (skill === undefined) return { kind: "unknown", name };
  return skill.localOnly ? { kind: "local_only", skill } : { kind: "skill", skill, content: arg };
}

const parseEffortArg = (value: string): Effort => {
  const effort = parseEffort(value);
  if (effort === undefined) throw new InvalidArgumentError(`use one of ${EFFORTS.join(", ")}.`);
  return effort;
};

export function registerChat(
  program: Command,
  ctx: ChatContext,
  exitWith: (code: number) => void,
): void {
  program
    .command("chat")
    .description("Talk with tars through its own loop and the provider's API.")
    .addOption(
      new Option("--model <provider/id>", "model for a new conversation")
        .argParser(parseModelRef)
        .conflicts("resume"),
    )
    .addOption(
      new Option("--effort <level>", `reasoning effort: ${EFFORTS.join(" | ")}`).argParser(
        parseEffortArg,
      ),
    )
    .option("--resume <id>", "continue a conversation: its full id, or a tail of 4+ characters")
    .addOption(
      new Option("--list", "list conversations and exit (read-only)").conflicts([
        "model",
        "effort",
        "resume",
        "message",
      ]),
    )
    .option("--message <text>", "send this one message, print the reply on stdout, and exit")
    .addHelpText(
      "after",
      `
Without --message it is interactive: type a message, or a command (/help lists them; //text
sends text that starts with "/"). Ctrl-C stops the running turn; Ctrl-D or /quit leaves.
The API key is only for your own terminal: refused inside a tars session.

Exit codes: 0 done; 1 config, key, lock or model problem, or a --message turn that did not
complete; 2 usage error; 143 SIGTERM.

Examples:
  tars chat
  tars chat --model anthropic/<id> --effort high
  tars chat --resume 3f2a9c1d
  tars chat --list
  tars chat --message "今天有什麼行程？" > reply.txt`,
    )
    .action(async (opts: ChatOptions) => exitWith(await chat(opts, ctx)));
}

async function chat(opts: ChatOptions, ctx: ChatContext): Promise<number> {
  // r63: the key pays for requests; a session's agent must not be able to spend it.
  if (inSession(ctx.env)) throw new TarsError("這把 API 金鑰只給你自己終端的 tars chat 用");
  const paths = resolvePaths(ctx.env);
  if (opts.list === true) return listConversations(paths, ctx);
  const { config, warnings } = await loadConfig(paths);
  warnings.forEach((w) => ctx.io.err(`warning: ${w}`));
  const start = await startingPoint(opts, config, paths, ctx);

  const lock = await acquireLock(paths, ctx.now());
  let db: Database | undefined;
  try {
    db = await openDb(paths);
    const summary = reconcileSummary(reconcile(db, ctx.now()));
    if (summary !== undefined) ctx.io.err(summary);
    if (start.conv !== undefined) {
      if (opts.effort !== undefined) store.setConversationEffort(db, start.conv.id, start.effort);
      printRecent(db, { ...start, conv: start.conv }, ctx);
    }
    const session = new ChatSession(ctx, paths, db, start);
    try {
      return opts.message === undefined
        ? await session.interactive()
        : await session.once(opts.message);
    } finally {
      session.dispose();
    }
  } finally {
    db?.close();
    lock.release();
  }
}

function listConversations(paths: TarsPaths, ctx: ChatContext): number {
  withReadDb(paths, (db) => {
    for (const c of db === undefined ? [] : store.listConversations(db))
      ctx.io.out(
        [
          c.id,
          c.title,
          `${c.provider}/${c.model}`,
          c.effort,
          new Date(c.updatedAt).toISOString(),
        ].join("\t"),
      );
  });
  return 0;
}

interface Start {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly conv?: store.Conversation;
}

/** Config, key, then the model; all checked before the lock and the database are touched. */
async function startingPoint(
  opts: ChatOptions,
  config: TarsConfig,
  paths: TarsPaths,
  ctx: ChatContext,
): Promise<Start> {
  const conv =
    opts.resume === undefined
      ? undefined
      : withReadDb(paths, (db) => {
          if (db === undefined) throw new TarsError("還沒有任何對話；列出：tars chat --list");
          return store.findConversation(db, opts.resume as string);
        });
  const provider = conv?.provider ?? opts.model?.provider ?? enabledProvider(config);
  if (config.providers[provider]?.enabled !== true)
    throw new TarsError(
      `${provider} 沒有啟用：在 config.toml 的 [providers.${provider}] 設 enabled = true`,
    );
  const key = await ctx.secrets.get(`llm:${provider}`);
  if (key === null || key === "")
    throw new TarsError(`沒有 ${provider} 的 API 金鑰。設定：tars llm key set ${provider}`);
  const catalog = await loadCatalog(paths);
  const model = conv?.model ?? opts.model?.id ?? defaultModel(catalog, provider)?.id;
  if (model === undefined) {
    const active = activeModels(catalog, provider).map((m) => `  ${provider}/${m.id}`);
    throw new TarsError(
      `${provider} 沒有預設模型。${active.length === 0 ? "清單上沒有 active 的模型；先執行 tars models refresh" : `active 的模型：\n${active.join("\n")}`}\n設定預設：tars models default ${provider}/<id>`,
    );
  }
  const r = resolve(catalog, provider, model, config.limits, ctx.now());
  if (!r.ok) throw new TarsError(r.message);
  if (opts.effort !== undefined) assertSelectable(r.model, opts.effort);
  const effort = opts.effort ?? conv?.effort ?? config.chat.effort;
  return { provider, model, effort, ...(conv === undefined ? {} : { conv }) };
}

/** S1 has one provider; the first enabled one in config.toml. */
function enabledProvider(config: TarsConfig): Provider {
  const found = Object.entries(config.providers).find(([, p]) => p?.enabled === true);
  if (found === undefined) throw new TarsError("config.toml 沒有 enabled = true 的 provider");
  return found[0] as Provider;
}

const firstLine = (text: string) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line;
};

function itemLine(item: Item): string | undefined {
  switch (item.kind) {
    case "user":
      return `你：${firstLine(item.body.text)}`;
    case "assistant":
      return item.body.text === "" ? undefined : `tars：${firstLine(item.body.text)}`;
    case "tool_call":
      return `→ ${item.body.name}`;
    case "tool_result":
      return `← ${item.body.status}`;
    case "error":
      return `錯誤：${item.body.message}`;
    case "compaction":
      return "（這之前的內容已壓縮成摘要）";
    case "usage":
    case "wiki_index":
      return undefined;
  }
}

function printRecent(
  db: Database,
  start: Start & { conv: store.Conversation },
  ctx: ChatContext,
): void {
  const { conv } = start;
  const lines = store.readItems(db, conv.id).flatMap((i) => itemLine(i) ?? []);
  ctx.io.err(
    `接續對話 ${conv.id}（${conv.title}），${conv.provider}/${conv.model}，推理強度 ${start.effort}`,
  );
  for (const line of lines.slice(-RESUME_ITEMS)) ctx.io.err(line);
}

/**
 * One tars chat process: the conversation it is on, the signals, and the commands typed at the
 * prompt. SIGINT stops what runs (a turn, a compaction, or the prompt); SIGTERM does the same
 * and then ends the process.
 */
class ChatSession {
  private readonly engine: Engine;
  private readonly frontend: TtyFrontend;
  private convId: string | undefined;
  private effort: Effort;
  private controller = new AbortController();
  private terminated = false;
  private terminal: Terminal | undefined;
  private readonly onInt = () => this.controller.abort();
  private readonly onTerm = () => {
    this.terminated = true;
    this.controller.abort();
  };

  constructor(
    private readonly ctx: ChatContext,
    private readonly paths: TarsPaths,
    private readonly db: Database,
    private readonly start: Start,
  ) {
    this.convId = start.conv?.id;
    this.effort = start.effort;
    this.engine = createEngine({
      db,
      paths,
      env: ctx.env,
      secrets: ctx.secrets,
      adapterFor: ctx.adapterFor,
      selfCommand: ctx.selfCommand,
      approveCommand: (name) => ctx.approveCommand(name),
      now: () => ctx.now(),
      sleep: sleepAbortable,
      log: createLog(paths.agentLog, () => ctx.now()),
      warn: (w) => ctx.io.err(`warning: ${w}`),
      otherSpend: (provider, cfg, now) => wikiSpend(paths, db, provider, cfg, now),
    });
    // The prompt and the approval card share one terminal once interactive mode opened it.
    this.frontend = new TtyFrontend(
      ctx.io,
      () => this.terminal ?? ctx.openTerminal(),
      (id) => usageCost(db, id),
    );
    ctx.signals.on("SIGINT", this.onInt);
    ctx.signals.on("SIGTERM", this.onTerm);
  }

  dispose(): void {
    this.ctx.signals.off("SIGINT", this.onInt);
    this.ctx.signals.off("SIGTERM", this.onTerm);
    // In interactive mode the frontend borrowed this terminal; otherwise it may have its own.
    if (this.terminal === undefined) this.frontend.close();
    else this.terminal.close();
  }

  /** A fresh signal for the next thing that can be stopped; SIGTERM keeps stopping everything. */
  private begin(): AbortSignal {
    this.controller = new AbortController();
    if (this.terminated) this.controller.abort();
    return this.controller.signal;
  }

  async once(text: string): Promise<number> {
    const out = await this.send(text);
    if (this.terminated) return EXIT_SIGTERM;
    return out.kind === "ended" && out.state === "completed" ? 0 : 1;
  }

  async interactive(): Promise<number> {
    this.terminal = this.ctx.openTerminal();
    for (;;) {
      let line: string | undefined;
      try {
        line = await this.terminal.askAbortable("> ", this.begin());
      } catch (err) {
        if (err instanceof TarsError && err.message === "cancelled")
          return this.terminated ? EXIT_SIGTERM : 0;
        throw err;
      }
      if (line === undefined) return 0;
      if (line.trim() === "") continue;
      if ((await this.handle(line)) === "quit") return 0;
      if (this.terminated) return EXIT_SIGTERM;
    }
  }

  private async handle(line: string): Promise<"quit" | undefined> {
    const { skills } = await loadSkillIndex(this.paths);
    const slash = parseSlash(line, skills);
    const { io } = this.ctx;
    switch (slash.kind) {
      case "message":
        await this.send(slash.text);
        return undefined;
      case "unknown":
        io.err(`不認得的指令 /${slash.name}。輸入 /help 看可用的指令`);
        return undefined;
      case "local_only":
        io.err(
          `${slash.skill.name} 要在 tars claude 裡用（${LOCAL_ONLY_SKILLS[slash.skill.name]}），這裡不送出`,
        );
        return undefined;
      case "skill":
        io.err(`使用 skill：${slash.skill.name} — ${slash.skill.description}`);
        await this.send(skillInvocationText(slash.skill.name, slash.content));
        return undefined;
      case "builtin":
        return this.builtin(slash.name, slash.arg, skills);
    }
  }

  private async send(text: string): Promise<TurnOutcome> {
    const out = await this.engine.runTurn(
      {
        ...(this.convId === undefined ? {} : { convId: this.convId }),
        provider: this.start.provider,
        model: this.start.model,
        effort: this.effort,
        text,
      },
      this.frontend,
      this.begin(),
    );
    if (out.kind === "rejected") this.ctx.io.err(`沒有送出：${out.message}`);
    else this.convId = out.convId;
    return out;
  }

  private async builtin(
    name: Builtin,
    arg: string,
    skills: readonly SkillEntry[],
  ): Promise<"quit" | undefined> {
    const { io } = this.ctx;
    switch (name) {
      case "quit":
        return "quit";
      case "new":
        this.convId = undefined;
        io.err("下一則訊息開新對話");
        return undefined;
      case "effort":
        await this.setEffort(arg);
        return undefined;
      case "compact":
        await this.compact(arg);
        return undefined;
      case "model":
        await this.showModel();
        return undefined;
      case "cost": {
        const { config } = await loadConfig(this.paths);
        try {
          for (const s of budgetStatuses(config, this.db, this.ctx.now(), this.paths)) {
            io.err(statusLine(s));
            if (s.wiki !== null) io.err(wikiLine(s.wiki, config.wiki));
          }
        } catch (err) {
          if (!(err instanceof TarsError)) throw err;
          io.err(err.message);
        }
        return undefined;
      }
      case "help":
        io.err(HELP);
        io.err(`skills：${skills.map((s) => s.name).join("、") || "（沒有）"}`);
        return undefined;
    }
  }

  private async currentEntry() {
    return findModel(await loadCatalog(this.paths), this.start.provider, this.start.model);
  }

  private async setEffort(arg: string): Promise<void> {
    const { io } = this.ctx;
    const entry = await this.currentEntry();
    if (arg === "") {
      const levels = entry?.effortLevels ?? [];
      io.err(
        `推理強度：${this.effort}；這個模型支援：${levels.length === 0 ? "（不支援）" : levels.join(", ")}`,
      );
      return;
    }
    const effort = parseEffort(arg);
    if (effort === undefined) return io.err(`推理強度是 ${EFFORTS.join(" | ")} 之一`);
    try {
      assertSelectable(entry ?? { id: this.start.model }, effort);
    } catch (err) {
      return io.err((err as Error).message);
    }
    this.effort = effort;
    if (this.convId !== undefined) store.setConversationEffort(this.db, this.convId, effort);
    io.err(`推理強度改成 ${effort}，下一則訊息起生效`);
  }

  private async compact(focus: string): Promise<void> {
    const { io } = this.ctx;
    if (this.convId === undefined) return io.err("還沒有對話");
    const r = await this.engine.compact(
      this.convId,
      { trigger: "manual", ...(focus === "" ? {} : { focus }) },
      this.frontend,
      this.begin(),
    );
    // A compaction that happened was already shown by the frontend's compaction item.
    if (r.kind === "skipped") io.err("上下文太短，沒有可以壓縮的部分");
    if (r.kind === "aborted") io.err("已取消");
    if (r.kind === "failed")
      io.err(`壓縮失敗：${r.message}${r.detail === undefined ? "" : `\n${r.detail}`}`);
  }

  private async showModel(): Promise<void> {
    const catalog = await loadCatalog(this.paths);
    const active = activeModels(catalog).map((m) => `  ${m.provider}/${m.id}  ${m.label}`);
    this.ctx.io.err(
      [
        `目前的模型：${this.start.provider}/${this.start.model}`,
        "清單上 active 的模型：",
        ...(active.length === 0 ? ["  （沒有）"] : active),
        "換模型：/quit 後執行 tars chat --model <provider>/<id> 開新對話",
      ].join("\n"),
    );
  }
}

const HELP = `指令：
  /new                 下一則訊息開新對話
  /effort [等級]       看或改推理強度
  /compact [焦點指示]  把較早的對話壓縮成摘要
  /model               目前的模型與可用的模型
  /cost                本期與今日的花費
  /<skill> [內容]      用一個 skill 處理內容
  /help                這份清單與可用的 skills
  /quit                結束
  //文字               送出以 / 開頭的文字`;
