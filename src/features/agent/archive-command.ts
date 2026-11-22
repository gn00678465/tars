import type { Database } from "bun:sqlite";
import { EXIT, TarsError } from "../../core/exit.ts";
import { confirmOnTty } from "./cli.ts";
import type { ChatContext } from "./chat.ts";
import { withReadDb } from "./cost-command.ts";
import { acquireLock, openDb, type LockHandle } from "./db.ts";
import * as store from "./store.ts";

const DAY_MS = 86_400_000;

export interface ArchiveOptions {
  readonly list?: boolean;
  readonly archived?: boolean;
  readonly archive?: string;
  readonly unarchive?: string;
  readonly archiveOlderThan?: number;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

/** Whether the options ask for archive work, which takes no conversation of its own. */
export const isArchiveCommand = (o: ArchiveOptions) =>
  o.archive !== undefined ||
  o.unarchive !== undefined ||
  o.archiveOlderThan !== undefined ||
  o.archived === true;

const FLAGS = ["archive", "unarchive", "archiveOlderThan"] as const;

/** Refuses combinations the work cannot mean; the caller adds the chat options it conflicts with. */
export function assertArchiveUsage(o: ArchiveOptions): void {
  const asked = FLAGS.filter((f) => o[f] !== undefined);
  if (asked.length > 1)
    throw new TarsError("--archive、--unarchive、--archive-older-than 一次只能用一個", EXIT.usage);
  if (o.archived === true && (o.list !== true || asked.length > 0))
    throw new TarsError("--archived 只能和 --list 一起用", EXIT.usage);
  if ((o.yes === true || o.dryRun === true) && o.archiveOlderThan === undefined)
    throw new TarsError("--yes 與 --dry-run 只能和 --archive-older-than 一起用", EXIT.usage);
  if (o.yes === true && o.dryRun === true)
    throw new TarsError("--yes 與 --dry-run 不能一起用：一個執行，一個只預覽", EXIT.usage);
}

/** The listing's lines: id, title, model, effort, updated, continued-from; and when archived. */
function listLines(db: Database | undefined, archived: boolean): string[] {
  return (db === undefined ? [] : store.listConversations(db, { archived })).map((c) =>
    [
      c.id,
      c.title,
      `${c.provider}/${c.model}`,
      c.effort,
      new Date(c.updatedAt).toISOString(),
      c.parentId === undefined ? "" : store.shortId(c.parentId),
      ...(archived ? [new Date(c.archivedAt as number).toISOString()] : []),
    ].join("\t"),
  );
}

/** The single writer lock; held by tars serve, the refusal says what to do. */
async function lockForWrite(
  ctx: ChatContext,
  paths: Parameters<typeof acquireLock>[0],
  flag: string,
) {
  try {
    return await acquireLock(paths, ctx.now());
  } catch (err) {
    if (err instanceof TarsError && err.message.includes("tars serve"))
      throw new TarsError(
        `${err.message}。要 ${flag}，請先停止 tars serve（Ctrl-C），做完再啟動。` +
          "手誤剛在網頁封存的，網頁有 60 秒內的「復原」。--list --archived 不受影響。",
      );
    throw err;
  }
}

const BLOCKED_TEXT: Record<store.ArchiveBlock, string> = {
  running: "有進行中的回合",
  approval: "有待核准項目",
};

async function withWriteDb<T>(
  ctx: ChatContext,
  paths: Parameters<typeof acquireLock>[0],
  flag: string,
  work: (db: Database) => Promise<T> | T,
): Promise<T> {
  const lock: LockHandle = await lockForWrite(ctx, paths, flag);
  let db: Database | undefined;
  try {
    db = await openDb(paths);
    return await work(db);
  } finally {
    db?.close();
    lock.release();
  }
}

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const line = (c: store.Conversation) =>
  `  ${store.shortId(c.id)}  ${c.title}  ${dateOf(c.updatedAt)}`;

export async function archiveCommand(
  o: ArchiveOptions,
  ctx: ChatContext,
  paths: Parameters<typeof acquireLock>[0],
): Promise<number> {
  if (o.list === true) {
    withReadDb(paths, (db) => listLines(db, o.archived === true).forEach((l) => ctx.io.out(l)));
    return EXIT.ok;
  }
  if (o.archive !== undefined) {
    const id = o.archive;
    return withWriteDb(ctx, paths, "--archive", (db) => {
      const conv = store.findConversation(db, id);
      const result = store.archiveConversation(db, conv.id, ctx.now().getTime());
      if (result === "already") {
        ctx.io.out(`對話 ${store.shortId(conv.id)} 已經封存`);
        return EXIT.ok;
      }
      if (result !== "archived")
        throw new TarsError(
          `對話 ${store.shortId(conv.id)} ${BLOCKED_TEXT[result]}，不能封存；等它結束後再封存`,
        );
      ctx.io.out(`已封存 ${store.shortId(conv.id)}  ${conv.title}`);
      ctx.io.out(`取消：tars chat --unarchive ${store.shortId(conv.id)}`);
      return EXIT.ok;
    });
  }
  if (o.unarchive !== undefined) {
    const id = o.unarchive;
    return withWriteDb(ctx, paths, "--unarchive", (db) => {
      const conv = store.findConversation(db, id);
      if (!store.unarchiveConversation(db, conv.id)) {
        ctx.io.out(`對話 ${store.shortId(conv.id)} 沒有封存`);
        return EXIT.ok;
      }
      ctx.io.out(`已取消封存 ${store.shortId(conv.id)}  ${conv.title}，回到進行中的列表`);
      return EXIT.ok;
    });
  }
  return archiveOlder(o, ctx, paths);
}

/** What `--archive-older-than` would do now: the conversations to archive and those it skips. */
function plan(db: Database, days: number, now: number) {
  const cutoff = now - days * DAY_MS;
  const older = store.listConversations(db).filter((c) => c.updatedAt < cutoff);
  const take: store.Conversation[] = [];
  const skip: { conv: store.Conversation; why: store.ArchiveBlock }[] = [];
  for (const conv of older) {
    const why = store.archiveBlocker(db, conv.id);
    if (why === undefined) take.push(conv);
    else skip.push({ conv, why });
  }
  return { take, skip };
}

function previewLines(days: number, p: ReturnType<typeof plan>): string[] {
  const lines = [
    `將封存 ${p.take.length} 個對話（最後更新早於 ${days} 天前）：`,
    ...p.take.map(line),
  ];
  if (p.skip.length > 0)
    lines.push(
      `略過 ${p.skip.length} 個：`,
      ...p.skip.map((s) => `${line(s.conv)}（${BLOCKED_TEXT[s.why]}）`),
    );
  lines.push("這只會做標記，不刪任何資料；取消：tars chat --unarchive <編號>");
  return lines;
}

async function archiveOlder(
  o: ArchiveOptions,
  ctx: ChatContext,
  paths: Parameters<typeof acquireLock>[0],
): Promise<number> {
  const days = o.archiveOlderThan as number;
  const planned = (db: Database | undefined) => {
    const p = db === undefined ? { take: [], skip: [] } : plan(db, days, ctx.now().getTime());
    if (p.take.length > 0 || p.skip.length > 0) return p;
    ctx.io.out(`沒有最後更新早於 ${days} 天前的對話`);
    return undefined;
  };
  // A preview only reads: it works while tars serve runs.
  if (o.dryRun === true) {
    const p = withReadDb(paths, planned);
    if (p !== undefined) previewLines(days, p).forEach((l) => ctx.io.out(l));
    return EXIT.ok;
  }
  // The lock comes before the question, so a refusal does not wait for a yes.
  return withWriteDb(ctx, paths, "--archive-older-than", async (db) => {
    const p = planned(db);
    if (p === undefined) return EXIT.ok;
    const lines = previewLines(days, p);
    if (p.take.length === 0) {
      lines.forEach((l) => ctx.io.out(l));
      return EXIT.ok;
    }
    if (o.yes === true) lines.forEach((l) => ctx.io.out(l));
    else if (!(await confirmArchive(ctx, lines))) throw new TarsError("沒有確認，對話都沒有封存");
    const results = store.archiveConversations(
      db,
      p.take.map((c) => c.id),
      ctx.now().getTime(),
    );
    ctx.io.out(`封存了 ${results.filter((r) => r === "archived").length} 個對話`);
    return EXIT.ok;
  });
}

async function confirmArchive(ctx: ChatContext, lines: readonly string[]): Promise<boolean> {
  try {
    return await confirmOnTty(ctx.openTerminal, lines);
  } catch (err) {
    // No controlling terminal to ask on.
    if (err instanceof TarsError)
      throw new TarsError(`${err.message}。先用 --dry-run 預覽，確定後加 --yes 執行`);
    throw err;
  }
}
