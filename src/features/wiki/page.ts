import { frontMatter } from "../agent/prompt.ts";
import { isRecord } from "../script/metadata.ts";

export const CATEGORIES = [
  "people",
  "projects",
  "topics",
  "life",
  "learning",
  "investment",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Q7: lowercase ASCII only; a Chinese name goes in title and aliases. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `<category>/<slug>` with the slug's ASCII letters lowercased, or undefined when it breaks a rule. */
export function parsePagePath(raw: string): string | undefined {
  const slash = raw.indexOf("/");
  if (slash < 0) return undefined;
  const category = raw.slice(0, slash);
  const slug = raw.slice(slash + 1).replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (!CATEGORIES.includes(category as Category) || !SLUG.test(slug)) return undefined;
  return `${category}/${slug}`;
}

export const categoryOf = (path: string) => path.slice(0, path.indexOf("/")) as Category;

/** `<conversation>/<turn>`, the last 8 characters of each id. */
export const SOURCE_REF = /^[0-9a-f]{8}\/[0-9a-f]{8}$/;
const SOURCE_LINK = /\[\[source:([^\]]*)\]\]/g;
const sourceLink = (ref: string) => `[[source:${ref}]]`;

export const ASSISTANT_MARK = "（助理的說法）";

export const LIMITS = {
  titleChars: 80,
  aliasChars: 40,
  aliases: 10,
  summaryChars: 3000,
  entryChars: 300,
  entries: 20,
  related: 20,
  changeLog: 50,
} as const;

export const chars = (s: string) => [...s].length;

// --- What the read commands accept; the tars tool checks argv with the same rules.

export const SEARCH = {
  termChars: 100,
  also: 6,
  limit: 50,
  defaultLimit: 10,
} as const;

/** A term as typed: 1 to 100 characters, not blank. */
export const minuteText = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;

export const okTerm = (s: string) => s.trim() !== "" && chars(s) <= SEARCH.termChars;

/** YYYY-MM-DD that names a real UTC day, or undefined. */
export function parseDay(s: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : undefined;
}

export const parseLimit = (s: string) =>
  /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= SEARCH.limit ? Number(s) : undefined;

/** `<conversation>/<turn>` as typed: a tail of 4 or more characters of each id. */
export const SOURCE_ARG = /^[0-9a-f-]{4,36}\/[0-9a-f-]{4,36}$/;

// oxlint-disable-next-line no-control-regex -- matching them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A title or an alias: one line, and nothing that could end a link, a tag or an index cell. */
const NAME_FORBIDDEN = /[[\]<｜]/;
const okName = (s: string, max: number) =>
  s.trim() !== "" && chars(s) <= max && !CONTROL.test(s) && !NAME_FORBIDDEN.test(s);
export const okTitle = (s: string) => okName(s, LIMITS.titleChars);
export const okAlias = (s: string) => okName(s, LIMITS.aliasChars);
/** An entry's text: one line, and no link or entry number that would read as structure. */
export const okEntryText = (s: string) =>
  s.trim() !== "" &&
  chars(s) <= LIMITS.entryChars &&
  !CONTROL.test(s) &&
  !s.includes("[[") &&
  !/\[i\d/.test(s);

/**
 * A key, a token or a private key block. This backs up the prompt's rule; it is no guarantee.
 * A long run counts only with a digit or + / =, so a long all-letter identifier passes.
 */
export function looksSecret(text: string): boolean {
  if (text.includes("-----BEGIN")) return true;
  if (/(?:sk-|ghp_|AKIA|AIza|xox[bp]-)[A-Za-z0-9]{16,}/.test(text)) return true;
  for (const run of text.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? [])
    if (/[0-9+/=]/.test(run)) return true;
  return false;
}

export interface Entry {
  readonly id: number;
  /** Without the assistant mark and the sources. */
  readonly text: string;
  readonly sources: readonly string[];
  /** Every source is the assistant's: the text carries ASSISTANT_MARK. */
  readonly assistant: boolean;
  /** A line the owner added without a number; the number is written on the next write. */
  readonly temp: boolean;
}

export interface Page {
  readonly path: string;
  readonly type: Category;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly created: string;
  readonly updated: string;
  /** As written, its [[source:…]] links included. */
  readonly summary: string;
  readonly facts: readonly Entry[];
  readonly open: readonly Entry[];
  readonly related: readonly string[];
  /** Newest first, without the leading "- ". */
  readonly changeLog: readonly string[];
  /** The next [iN]; above every number on the page, temporary ones included. */
  readonly nextItem: number;
}

export const summarySources = (summary: string) =>
  unique([...summary.matchAll(SOURCE_LINK)].map((m) => m[1] as string));

const unique = <T>(xs: readonly T[]) => [...new Set(xs)];

export function newPage(path: string, title: string, today: string): Page {
  return {
    path,
    type: categoryOf(path),
    title,
    aliases: [],
    created: today,
    updated: today,
    summary: "",
    facts: [],
    open: [],
    related: [],
    changeLog: [],
    nextItem: 1,
  };
}

const SECTIONS = ["摘要", "事實", "未決", "相關", "Change Log"] as const;
type SectionName = (typeof SECTIONS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOf = (v: unknown) =>
  v instanceof Date && !Number.isNaN(v.getTime())
    ? v.toISOString().slice(0, 10)
    : typeof v === "string" && DATE.test(v)
      ? v
      : undefined;

const FRONT = /^---\n[\s\S]*?\n---(?:\n|$)/;
const NUMBERED = /^- \[i(\d+)\] (.*)$/;
const RELATED = /^- \[\[([^\]]+)\]\]$/;

export type ParseResult =
  | { readonly ok: true; readonly page: Page }
  | { readonly ok: false; readonly error: string };

/**
 * One page file. `nextItem` is pages.next_item: lines without a number get temporary numbers
 * from there up, in the order they appear, and the page never reuses a number.
 */
export function parsePage(text: string, path: string, nextItem = 1): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error });
  const src = text.replaceAll("\r\n", "\n");
  const meta = frontMatter(src);
  if (meta === undefined) return fail("沒有 frontmatter");
  const type = categoryOf(path);
  for (const key of ["title", "type", "created", "updated"])
    if (meta[key] === undefined) return fail(`frontmatter 缺少 ${key}`);
  if (meta.type !== type) return fail(`type 是 ${String(meta.type)}，但檔案在 ${type}`);
  const title = meta.title;
  if (typeof title !== "string" || !okTitle(title)) return fail("title 不合規則");
  const rawAliases = meta.aliases ?? [];
  if (!Array.isArray(rawAliases)) return fail("aliases 不是陣列");
  if (rawAliases.length > LIMITS.aliases) return fail(`aliases 超過 ${LIMITS.aliases} 個`);
  if (!rawAliases.every((a): a is string => typeof a === "string" && okAlias(a)))
    return fail("aliases 有不合規則的項目");
  const created = dateOf(meta.created);
  const updated = dateOf(meta.updated);
  if (created === undefined || updated === undefined)
    return fail("created 或 updated 不是 YYYY-MM-DD");

  const body = src.replace(FRONT, "");
  const sections = new Map<SectionName, string[]>();
  let current: string[] | undefined;
  let order = -1;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      const name = line.slice(3).trim();
      const at = SECTIONS.indexOf(name as SectionName);
      if (at < 0) return fail(`多出不認得的區段「${name}」`);
      if (at <= order) return fail(`區段「${name}」重複或順序不對`);
      order = at;
      current = [];
      sections.set(name as SectionName, current);
    } else if (current === undefined) {
      if (line.trim() !== "") return fail("第一個區段之前有文字");
    } else current.push(line);
  }
  const lines = (name: SectionName) => (sections.get(name) ?? []).filter((l) => l.trim() !== "");

  const summary = lines("摘要").join("\n").trim();
  if (chars(summary) > LIMITS.summaryChars) return fail("摘要超過 3000 字");

  const numbered = (name: "事實" | "未決") =>
    lines(name)
      .map((l) => NUMBERED.exec(l)?.[1])
      .filter((n) => n !== undefined)
      .map(Number);
  const maxId = Math.max(0, ...numbered("事實"), ...numbered("未決"));
  let next = Math.max(nextItem, maxId + 1);
  const seen = new Set<number>();
  const entries = (name: "事實" | "未決"): Entry[] | string => {
    const out: Entry[] = [];
    for (const line of lines(name)) {
      if (!line.startsWith("- ")) return `「${name}」有一行不是條目`;
      const m = NUMBERED.exec(line);
      const id = m === null ? next++ : Number(m[1]);
      if (seen.has(id)) return `[i${id}] 重複`;
      seen.add(id);
      const entry = parseEntry(m === null ? line.slice(2) : (m[2] as string), id, m === null);
      if (entry === undefined) return `「${name}」的 [i${id}] 不合條目的規則`;
      out.push(entry);
    }
    return out;
  };
  const facts = entries("事實");
  if (typeof facts === "string") return fail(facts);
  const open = entries("未決");
  if (typeof open === "string") return fail(open);

  const related: string[] = [];
  for (const line of lines("相關")) {
    const target = parsePagePath(RELATED.exec(line)?.[1] ?? "");
    if (target === undefined) return fail("「相關」有一行不是 [[<分類>/<名稱>]]");
    related.push(target);
  }
  if (related.length > LIMITS.related) return fail(`「相關」超過 ${LIMITS.related} 條`);

  const changeLog = lines("Change Log").map((l) => l.replace(/^- /, ""));
  return {
    ok: true,
    page: {
      path,
      type,
      title,
      aliases: rawAliases,
      created,
      updated,
      summary,
      facts,
      open,
      related: unique(related),
      changeLog,
      nextItem: next,
    },
  };
}

function parseEntry(rest: string, id: number, temp: boolean): Entry | undefined {
  const sources: string[] = [];
  let text = rest;
  for (;;) {
    const m = /\s*\[\[source:([^\]]*)\]\]\s*$/.exec(text);
    if (m === null) break;
    sources.unshift(m[1] as string);
    text = text.slice(0, m.index);
  }
  text = text.trim();
  const assistant = text.endsWith(ASSISTANT_MARK);
  if (assistant) text = text.slice(0, -ASSISTANT_MARK.length).trimEnd();
  if (!okEntryText(text) || !sources.every((s) => SOURCE_REF.test(s))) return undefined;
  return { id, text, sources: unique(sources), assistant, temp };
}

export const entryLine = (e: Entry) =>
  `- [i${e.id}] ${e.text}${e.assistant ? ASSISTANT_MARK : ""}${e.sources
    .map((s) => ` ${sourceLink(s)}`)
    .join("")}`;

/** The file's bytes; parsePage of this gives the same page back. */
export function renderPage(page: Page): string {
  const out = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `type: ${page.type}`,
    `aliases: ${JSON.stringify(page.aliases)}`,
    `created: ${page.created}`,
    `updated: ${page.updated}`,
    "---",
    "## 摘要",
    ...(page.summary === "" ? [] : [page.summary]),
    "## 事實",
    ...page.facts.map(entryLine),
    "## 未決",
    ...page.open.map(entryLine),
    "## 相關",
    ...page.related.map((r) => `- [[${r}]]`),
    "## Change Log",
    ...page.changeLog.slice(0, LIMITS.changeLog).map((l) => `- ${l}`),
  ];
  return `${out.join("\n")}\n`;
}

// --- The model's changes.

export interface Removed {
  readonly source: string;
  readonly reason: string;
}
export type Op =
  | { readonly op: "add"; readonly text: string; readonly from: readonly string[] }
  | {
      readonly op: "update";
      readonly id: string;
      readonly text: string;
      readonly from: readonly string[];
      readonly removed_sources?: readonly Removed[];
    }
  | {
      readonly op: "retract";
      readonly id: string;
      readonly reason: string;
      readonly from: readonly string[];
    }
  | {
      readonly op: "merge";
      readonly ids: readonly string[];
      readonly text: string;
      /** Required in facts (check 5); it only shows the owner spoke, and adds no source. */
      readonly from?: readonly string[];
    };
export type SummaryPatch =
  | { readonly keep: true }
  | {
      readonly keep: false;
      readonly text: string;
      readonly reason: string;
      readonly from: readonly string[];
      readonly removed_sources?: readonly Removed[];
    };
export interface Patch {
  readonly summary: SummaryPatch;
  readonly facts: readonly Op[];
  readonly open: readonly Op[];
  readonly related?: readonly string[];
  readonly aliases?: readonly string[];
  readonly dropped?: readonly { readonly candidate: string; readonly reason: string }[];
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const onlyKeys = (o: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => k in o) &&
  Object.keys(o).every((k) => [...required, ...optional].includes(k));
const isRemoved = (v: unknown): v is Removed[] =>
  Array.isArray(v) &&
  v.every(
    (r) =>
      isRecord(r) && onlyKeys(r, ["source", "reason"]) && isString(r.source) && isString(r.reason),
  );

function isOp(v: unknown): v is Op {
  if (!isRecord(v)) return false;
  switch (v.op) {
    case "add":
      return onlyKeys(v, ["op", "text", "from"]) && isString(v.text) && isStrings(v.from);
    case "update":
      return (
        onlyKeys(v, ["op", "id", "text", "from"], ["removed_sources"]) &&
        isString(v.id) &&
        isString(v.text) &&
        isStrings(v.from) &&
        (v.removed_sources === undefined || isRemoved(v.removed_sources))
      );
    case "retract":
      return (
        onlyKeys(v, ["op", "id", "reason", "from"]) &&
        isString(v.id) &&
        isString(v.reason) &&
        isStrings(v.from)
      );
    case "merge":
      return (
        onlyKeys(v, ["op", "ids", "text"], ["from"]) &&
        isStrings(v.ids) &&
        isString(v.text) &&
        (v.from === undefined || isStrings(v.from))
      );
    default:
      return false;
  }
}

function isSummary(v: unknown): v is SummaryPatch {
  if (!isRecord(v)) return false;
  if (v.keep === true) return onlyKeys(v, ["keep"]);
  return (
    v.keep === false &&
    onlyKeys(v, ["keep", "text", "reason", "from"], ["removed_sources"]) &&
    isString(v.text) &&
    isString(v.reason) &&
    isStrings(v.from) &&
    (v.removed_sources === undefined || isRemoved(v.removed_sources))
  );
}

/** The response's shape (check 1); undefined is bad_shape. */
export function parsePatch(v: unknown): Patch | undefined {
  if (!isRecord(v) || !onlyKeys(v, ["summary", "facts", "open"], ["related", "aliases", "dropped"]))
    return undefined;
  const ok =
    isSummary(v.summary) &&
    Array.isArray(v.facts) &&
    v.facts.every(isOp) &&
    Array.isArray(v.open) &&
    v.open.every(isOp) &&
    (v.related === undefined || isStrings(v.related)) &&
    (v.aliases === undefined || isStrings(v.aliases)) &&
    (v.dropped === undefined ||
      (Array.isArray(v.dropped) &&
        v.dropped.every(
          (d) =>
            isRecord(d) &&
            onlyKeys(d, ["candidate", "reason"]) &&
            isString(d.candidate) &&
            isString(d.reason),
        )));
  return ok ? (v as unknown as Patch) : undefined;
}

export type PatchReason =
  | "bad_json"
  | "bad_shape"
  | "bad_id"
  | "bad_from"
  | "assistant_only"
  | "no_from"
  | "source_lost"
  | "bad_merge"
  | "no_such_turn"
  | "too_long"
  | "secret";

export interface BatchCandidate {
  /** "c<candidates.id>" */
  readonly key: string;
  readonly speaker: "owner" | "assistant";
  readonly source: string;
}

export interface ApplyContext {
  readonly candidates: readonly BatchCandidate[];
  readonly today: string;
  /** Check 9: the turn a new source names is in agent.db. */
  turnExists(ref: string): boolean;
  /** A related page must exist, or be one this sync is about to write. */
  pageKnown(path: string): boolean;
  /** pages.external_change: the file changed outside sync since the last write. */
  readonly externalChange: boolean;
  readonly isNew: boolean;
}

export type ApplyResult =
  | {
      readonly ok: true;
      readonly page: Page;
      /** false: nothing to write; every candidate was dropped. */
      readonly write: boolean;
      readonly applied: readonly string[];
      readonly dropped: readonly { readonly candidate: string; readonly reason: string }[];
      readonly added: number;
      readonly updated: number;
    }
  | { readonly ok: false; readonly reason: PatchReason };

const ID = /^i(\d+)$/;
/** A reason the model gave, as one Change Log phrase. */
const oneLine = (s: string, max: number) =>
  [...s.split(CONTROL).join(" ").trim()].slice(0, max).join("");
const stripMark = (s: string) => s.replaceAll(ASSISTANT_MARK, "").trim();

/**
 * Checks a patch against the page and the batch, then applies it. Any failed check leaves the
 * page untouched; the checks run in the order of the design's table, except that an empty
 * "from" is no_from before Q6 looks at who is in it.
 */
export function applyPatch(page: Page, patch: Patch, ctx: ApplyContext): ApplyResult {
  const fail = (reason: PatchReason): ApplyResult => ({ ok: false, reason });
  const byKey = new Map(ctx.candidates.map((c) => [c.key, c]));

  // 11 first, whatever else is wrong: reasons reach the Change Log and wiki.db too.
  const s = patch.summary;
  const modelText = [
    ...[...patch.facts, ...patch.open].flatMap((op) => [
      ...("text" in op ? [op.text] : []),
      ...(op.op === "retract" ? [op.reason] : []),
      ...(op.op === "update" ? (op.removed_sources ?? []).map((r) => r.reason) : []),
    ]),
    ...(s.keep ? [] : [s.text, s.reason, ...(s.removed_sources ?? []).map((r) => r.reason)]),
    ...(patch.dropped ?? []).map((d) => d.reason),
  ];
  if (modelText.some(looksSecret)) return fail("secret");
  const sections = { facts: page.facts, open: page.open } as const;

  // 2: entry numbers exist in their section, each used by one operation.
  const used = new Set<number>();
  for (const name of ["facts", "open"] as const) {
    const ids = new Set(sections[name].map((e) => e.id));
    for (const op of patch[name]) {
      const refs = op.op === "merge" ? op.ids : op.op === "add" ? [] : [op.id];
      for (const ref of refs) {
        const n = Number(ID.exec(ref)?.[1] ?? Number.NaN);
        if (!ids.has(n) || used.has(n)) return fail("bad_id");
        used.add(n);
      }
    }
  }

  // 3: every candidate has one destination; a summary rewrite may share one with an operation.
  const ops = [
    ...patch.facts.map((op) => ["facts", op] as const),
    ...patch.open.map((op) => ["open", op] as const),
  ];
  const inOps = new Set<string>();
  for (const [, op] of ops)
    for (const key of op.op === "merge" ? [] : op.from) {
      if (!byKey.has(key) || inOps.has(key)) return fail("bad_from");
      inOps.add(key);
    }
  // A merge's "from" may repeat a key another operation uses, and is no destination of its own.
  const mergeFrom = ops.flatMap(([, op]) => (op.op === "merge" ? (op.from ?? []) : []));
  for (const [, op] of ops) {
    const from = op.op === "merge" ? (op.from ?? []) : [];
    if (from.some((k) => !byKey.has(k)) || new Set(from).size !== from.length)
      return fail("bad_from");
  }
  const summaryFrom = patch.summary.keep ? [] : patch.summary.from;
  if (summaryFrom.some((k) => !byKey.has(k)) || new Set(summaryFrom).size !== summaryFrom.length)
    return fail("bad_from");
  const dropped = patch.dropped ?? [];
  const droppedKeys = new Set(dropped.map((d) => d.candidate));
  if (droppedKeys.size !== dropped.length) return fail("bad_from");
  for (const key of droppedKeys)
    if (!byKey.has(key) || inOps.has(key) || summaryFrom.includes(key) || mergeFrom.includes(key))
      return fail("bad_from");
  for (const c of ctx.candidates)
    if (!inOps.has(c.key) && !summaryFrom.includes(c.key) && !droppedKeys.has(c.key))
      return fail("bad_from");

  // 5, then 4 (Q6): who backs each change.
  const speakers = (keys: readonly string[]) =>
    keys.map((k) => (byKey.get(k) as BatchCandidate).speaker);
  for (const [name, op] of ops) {
    if (op.op === "merge") {
      if (name === "open") continue;
      const from = op.from ?? [];
      if (from.length === 0) return fail("no_from");
      if (speakers(from).some((s) => s !== "owner")) return fail("assistant_only");
      continue;
    }
    if (op.from.length === 0) return fail("no_from");
    if (name === "facts" && !speakers(op.from).includes("owner")) return fail("assistant_only");
  }
  if (!patch.summary.keep) {
    if (summaryFrom.length === 0) return fail("no_from");
    if (speakers(summaryFrom).some((s) => s !== "owner")) return fail("assistant_only");
  }

  // 6: an update removes only sources its entry had, each with a reason.
  for (const [name, op] of ops) {
    if (op.op !== "update") continue;
    const entry = sections[name].find((e) => `i${e.id}` === op.id) as Entry;
    for (const r of op.removed_sources ?? [])
      if (!entry.sources.includes(r.source) || r.reason.trim() === "") return fail("source_lost");
  }

  // 7: a merge takes the section's lowest-numbered entries.
  for (const [name, op] of ops) {
    if (op.op !== "merge") continue;
    const lowest = sections[name]
      .map((e) => e.id)
      .toSorted((a, b) => a - b)
      .slice(0, op.ids.length)
      .map((n) => `i${n}`);
    if (op.ids.length < 2 || [...op.ids].toSorted().join() !== lowest.toSorted().join())
      return fail("bad_merge");
  }

  // 8: a rewritten summary cites only known sources and keeps or explains every old one.
  const sourcesOf = (keys: readonly string[]) =>
    unique(keys.map((k) => (byKey.get(k) as BatchCandidate).source));
  let newSummary = page.summary;
  if (!patch.summary.keep) {
    const s = patch.summary;
    if (s.reason.trim() === "") return fail("source_lost");
    const old = summarySources(page.summary);
    const allowed = new Set([...old, ...sourcesOf(s.from)]);
    const cited = [...s.text.matchAll(/\[\[source:/g)].length;
    const refs = summarySources(s.text);
    if (
      cited !== [...s.text.matchAll(SOURCE_LINK)].length ||
      refs.some((r) => !SOURCE_REF.test(r) || !allowed.has(r))
    )
      return fail("source_lost");
    const removed = s.removed_sources ?? [];
    if (removed.some((r) => !old.includes(r.source) || r.reason.trim() === ""))
      return fail("source_lost");
    if (old.some((o) => !refs.includes(o) && !removed.some((r) => r.source === o)))
      return fail("source_lost");
    newSummary = s.text.trim();
  }

  // 9: every source this patch brings in names a turn that exists.
  const brought = unique([
    ...sourcesOf([...inOps]),
    ...(patch.summary.keep ? [] : summarySources(newSummary)),
  ]);
  if (brought.some((r) => !ctx.turnExists(r))) return fail("no_such_turn");

  // Apply to copies; 10 and 11 are checked on the result.
  let next = page.nextItem;
  const log: Record<"facts" | "open", string[]> = { facts: [], open: [] };
  let added = 0;
  let updatedCount = 0;
  const out = { facts: [...page.facts], open: [...page.open] };
  for (const [name, op] of ops) {
    const list = out[name];
    const assistantOnly = (keys: readonly string[]) =>
      speakers(keys).every((s) => s === "assistant");
    if (op.op === "add") {
      const text = stripMark(op.text);
      list.push({
        id: next,
        text,
        sources: sourcesOf(op.from),
        assistant: assistantOnly(op.from),
        temp: false,
      });
      log[name].push(`新增 i${next}`);
      next++;
      added++;
    } else if (op.op === "update") {
      const at = list.findIndex((e) => `i${e.id}` === op.id);
      const old = list[at] as Entry;
      const removed = new Set((op.removed_sources ?? []).map((r) => r.source));
      const text = stripMark(op.text);
      list[at] = {
        id: old.id,
        text,
        sources: unique([...old.sources.filter((s) => !removed.has(s)), ...sourcesOf(op.from)]),
        assistant: old.assistant && assistantOnly(op.from),
        temp: false,
      };
      log[name].push(`更新 ${op.id}`);
      updatedCount++;
    } else if (op.op === "retract") {
      out[name] = list.filter((e) => `i${e.id}` !== op.id);
      log[name].push(`撤回 ${op.id}（${oneLine(op.reason, 80)}）`);
    } else {
      const merged = list.filter((e) => op.ids.includes(`i${e.id}`));
      const at = list.findIndex((e) => op.ids.includes(`i${e.id}`));
      const text = stripMark(op.text);
      const entry: Entry = {
        id: next,
        text,
        sources: unique(merged.flatMap((e) => e.sources)),
        assistant: merged.some((e) => e.assistant),
        temp: false,
      };
      // The merged entry takes the place of the first one it replaces.
      out[name] = [
        ...list.slice(0, at),
        entry,
        ...list.slice(at).filter((e) => !merged.includes(e)),
      ];
      log[name].push(`合併 ${op.ids.join("、")} 成 i${next}`);
      next++;
    }
  }

  // 10: lengths and the entry rule, after applying.
  if (
    chars(newSummary) > LIMITS.summaryChars ||
    /^#/m.test(newSummary) ||
    /^---$/m.test(newSummary)
  )
    return fail("too_long");
  for (const name of ["facts", "open"] as const)
    if (out[name].length > LIMITS.entries || !out[name].every((e) => okEntryText(e.text)))
      return fail("too_long");

  // related and aliases only grow; an entry that breaks a rule is dropped, not the patch.
  const related = [...page.related];
  for (const raw of patch.related ?? []) {
    const p = parsePagePath(raw);
    if (p === undefined || p === page.path || related.includes(p) || !ctx.pageKnown(p)) continue;
    if (related.length < LIMITS.related) related.push(p);
  }
  const aliases = [...page.aliases];
  for (const a of patch.aliases ?? []) {
    if (!okAlias(a) || a === page.title || aliases.includes(a) || looksSecret(a)) continue;
    if (aliases.length < LIMITS.aliases) aliases.push(a);
  }

  const applied = ctx.candidates
    .filter((c) => inOps.has(c.key) || summaryFrom.includes(c.key))
    .map((c) => c.key);
  const changed =
    ops.length > 0 ||
    !patch.summary.keep ||
    related.length > page.related.length ||
    aliases.length > page.aliases.length;
  const parts = [
    ...(log.facts.length > 0 ? [`事實：${log.facts.join("；")}。`] : []),
    ...(log.open.length > 0 ? [`未決：${log.open.join("；")}。`] : []),
    ...(patch.summary.keep ? [] : [`摘要：改寫（${oneLine(patch.summary.reason, 80)}）。`]),
  ];
  const changeLog = [
    ...(changed && parts.length > 0
      ? [`${ctx.today} ${ctx.isNew ? "建立。" : ""}${parts.join("")}`]
      : []),
    ...(ctx.externalChange ? [`${ctx.today} 檔案在同步之外有變動，以檔案為準。`] : []),
    ...page.changeLog,
  ].slice(0, LIMITS.changeLog);
  const permanent = (e: Entry): Entry => (e.temp ? { ...e, temp: false } : e);
  return {
    ok: true,
    page: {
      ...page,
      aliases,
      related,
      summary: newSummary,
      facts: out.facts.map(permanent),
      open: out.open.map(permanent),
      updated: changed || ctx.externalChange ? ctx.today : page.updated,
      changeLog,
      nextItem: next,
    },
    write: changed || ctx.externalChange,
    applied,
    dropped,
    added,
    updated: updatedCount,
  };
}
