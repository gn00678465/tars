import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { TarsPaths } from "../../core/paths.ts";
import { isRecord, OUTPUT_LIMIT, SLUG } from "../script/metadata.ts";
import { within } from "../script/out-dir.ts";
import { cutUtf8, utf8Bytes } from "./bytes.ts";
import type { SkillEntry } from "./prompt.ts";
import type { ToolCallEndState } from "./types.ts";

export interface ToolOutcome {
  readonly status: Extract<ToolCallEndState, "done" | "failed">;
  readonly text: string;
  readonly truncated: boolean;
  readonly exit?: number;
}

const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 2000;
/** Room for the header line inside the tool result limit. */
const HEADER_ROOM = 200;

const failed = (text: string): ToolOutcome => ({ status: "failed", text, truncated: false });

export interface ReadToolContext {
  readonly paths: TarsPaths;
  readonly skills: readonly SkillEntry[];
  readonly toolResultBytes: number;
}

/** skill_load and file_read; the tars tool has its own path through classify and runSelf. */
export async function runTool(
  name: "skill_load" | "file_read",
  input: unknown,
  ctx: ReadToolContext,
): Promise<ToolOutcome> {
  const page = parsePage(input);
  if (typeof page === "string") return failed(page);
  if (name === "skill_load") {
    const skill = isRecord(input) ? input.name : undefined;
    if (typeof skill !== "string" || !SLUG.test(skill))
      return failed("name 必須是 skills 索引裡的名稱");
    if (!ctx.skills.some((s) => s.name === skill))
      return failed(`沒有 skill ${skill}。可用的：${ctx.skills.map((s) => s.name).join(", ")}`);
    return readPaged(join(ctx.paths.skills, skill, "SKILL.md"), ctx, page);
  }
  const path = isRecord(input) ? input.path : undefined;
  if (typeof path !== "string" || path === "" || path.includes("\0"))
    return failed("path 必須是非空的字串");
  return readPaged(readPath(path, ctx.paths), ctx, page);
}

/** A relative path whose first part is exactly "wiki" is under <data>; any other, skills. */
function readPath(path: string, paths: TarsPaths): string {
  if (isAbsolute(path)) return path;
  const clean = normalize(path);
  return clean.split(sep)[0] === "wiki" ? resolve(paths.data, clean) : resolve(paths.skills, clean);
}

interface Page {
  readonly offset: number;
  readonly limit: number;
}

function parsePage(input: unknown): Page | string {
  const value = (key: string, fallback: number, max: number) => {
    const v = isRecord(input) ? input[key] : undefined;
    if (v === undefined) return fallback;
    return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max
      ? (v as number)
      : undefined;
  };
  const offset = value("offset", 1, Number.MAX_SAFE_INTEGER);
  const limit = value("limit", DEFAULT_LIMIT, MAX_LIMIT);
  if (offset === undefined) return "offset 必須是 1 以上的整數";
  if (limit === undefined) return `limit 必須是 1 到 ${MAX_LIMIT} 的整數`;
  return { offset, limit };
}

/**
 * The roots the read tools may reach, resolved through symlinks. <data>/wiki counts only as a
 * real directory: as a link it could make anything readable.
 */
async function realRoots(paths: TarsPaths): Promise<string[]> {
  const wiki = await lstat(paths.wiki).catch(() => undefined);
  const roots = [
    paths.skills,
    paths.playbooks,
    paths.outRoot,
    ...(wiki?.isDirectory() === true ? [paths.wiki] : []),
  ];
  const real = await Promise.all(roots.map((r) => realpath(r).catch(() => undefined)));
  return real.filter((r): r is string => r !== undefined);
}

/**
 * Whole lines from `offset`, at most `limit` of them and at most tool_result_bytes − 200 bytes,
 * under a header saying where the page is and where the next one starts.
 */
export async function readPaged(
  path: string,
  ctx: ReadToolContext,
  page: Page,
): Promise<ToolOutcome> {
  const real = await realpath(path).catch(() => undefined);
  if (real === undefined) return failed(`${path} 不存在`);
  const roots = await realRoots(ctx.paths);
  if (!roots.some((root) => within(real, root)))
    return failed(`${path} 不在可讀的範圍：skills、playbooks、workspace/out、wiki`);
  const info = await stat(real);
  if (!info.isFile()) return failed(`${path} 不是一般檔案`);
  if (info.size > OUTPUT_LIMIT)
    return failed(`${path} 有 ${info.size} 位元組，超過 ${OUTPUT_LIMIT}`);
  const bytes = await readFile(real);
  if (bytes.includes(0)) return failed(`${path} 是二進位檔`);
  const text = bytes.toString("utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const total = text === "" ? 0 : lines.length;
  if (page.offset > Math.max(total, 1))
    return failed(`${path} 共 ${total} 行，offset ${page.offset} 超過了`);
  const budget = ctx.toolResultBytes - HEADER_ROOM;
  const taken: string[] = [];
  let used = 0;
  let cut = false;
  for (let i = page.offset - 1; i < total && taken.length < page.limit; i++) {
    const line = lines[i] as string;
    const size = utf8Bytes(line) + 1;
    if (used + size > budget) {
      if (taken.length === 0) {
        taken.push(cutUtf8(line, budget - 1));
        cut = true;
      }
      break;
    }
    taken.push(line);
    used += size;
  }
  const first = page.offset;
  const last = first + taken.length - 1;
  const more = last < total;
  const header =
    `${path} 第 ${first}–${last} 行，共 ${total} 行` +
    (cut ? `；第 ${first} 行太長，只有前段` : "") +
    (more ? `；下一頁 offset=${last + 1}` : "");
  return { status: "done", text: `${header}\n${taken.join("\n")}`, truncated: cut };
}
