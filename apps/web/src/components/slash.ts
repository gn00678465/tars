import { skillInvocationText, type WireStatus } from "@tars/protocol";

export type Skill = NonNullable<WireStatus["skills"]>[number];

/**
 * The terminal's built-ins that have a page here, in the prototype's order and words. /effort has
 * no message to the local end yet, so it is not offered at all. /compact and /wiki take words
 * after a space (what to keep, the keywords), so picking one from the menu leaves it in the box.
 */
export const BUILTINS = [
  { name: "compact", description: "壓縮早期對話前綴，保留近期原文（送出一次模型請求）" },
  { name: "wiki", description: "唯讀瀏覽個人知識庫與雙軌搜尋原始對話" },
  { name: "model", description: "以另一個模型接續目前對話（開新對話）" },
  { name: "new", description: "開啟新對話（模型與推理強度在輸入框選）" },
  { name: "cost", description: "檢視三家 Provider 花費與模型清單狀態" },
  { name: "help", description: "列出這裡能用的指令與 skills" },
] as const;

export type Builtin = (typeof BUILTINS)[number]["name"];

export const TAKES_ARG: ReadonlySet<Builtin> = new Set(["compact", "wiki"]);

/**
 * /wiki only once the local end answered wiki.status, /compact once it sent conv.context: an
 * older one can do neither.
 */
const ALL: readonly Builtin[] = BUILTINS.map((b) => b.name).filter(
  (n) => n !== "wiki" && n !== "compact",
);

export interface Option {
  readonly group: "內建指令" | "Skills" | "僅限本機（tars claude）";
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly builtin: boolean;
}

/** Every letter of the query, in order, somewhere in the name or description (the prototype's). */
function matches(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const c of t) if (c === q[i]) i += 1;
  return i === q.length;
}

/** The menu while a command name is being typed: `/` and no space yet; `//` is a message. */
export function menuFor(
  text: string,
  skills: readonly Skill[] | undefined,
  offered: readonly Builtin[] = ALL,
): Option[] | undefined {
  if (!text.startsWith("/") || text.startsWith("//") || /\s/.test(text)) return undefined;
  const query = text.slice(1);
  const all: Option[] = [
    ...BUILTINS.filter((b) => offered.includes(b.name)).map((b) => ({
      group: "內建指令" as const,
      ...b,
      enabled: true,
      builtin: true,
    })),
    ...(skills ?? [])
      .filter((s) => !s.localOnly)
      .map((s) => ({ group: "Skills" as const, ...s, enabled: true, builtin: false })),
    ...(skills ?? [])
      .filter((s) => s.localOnly)
      .map((s) => ({
        group: "僅限本機（tars claude）" as const,
        name: s.name,
        description: s.description,
        enabled: false,
        builtin: false,
      })),
  ];
  return all.filter((o) => matches(query, o.name) || matches(query, o.description));
}

export type Slash =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "builtin"; readonly name: Builtin; readonly arg: string }
  | { readonly kind: "refused"; readonly text: string };

/**
 * What a line the owner sends does, as the terminal's tars chat: `//` sends the rest with one
 * slash, `/<skill> [content]` sends the same wording the terminal sends, a local-only skill or
 * an unknown name sends nothing. Without a skill list (a local end older than it) a slash line
 * is a plain message, as before.
 */
export function slashOf(
  line: string,
  skills: readonly Skill[] | undefined,
  offered: readonly Builtin[] = ALL,
): Slash {
  if (line.startsWith("//")) return { kind: "message", text: line.slice(1) };
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(line);
  if (m === null) return { kind: "message", text: line };
  const name = m[1] as string;
  const content = (m[2] ?? "").trim();
  const builtin = BUILTINS.find((b) => b.name === name && offered.includes(b.name));
  if (builtin !== undefined) return { kind: "builtin", name: builtin.name, arg: content };
  if (skills === undefined) return { kind: "message", text: line };
  const skill = skills.find((s) => s.name === name);
  if (skill === undefined)
    return {
      kind: "refused",
      text: `不認得的指令「/${name}」。輸入 / 查看可用指令與 skills，或以 // 開頭送出一般文字。`,
    };
  if (skill.localOnly)
    return { kind: "refused", text: `/${name} 僅限在本機終端 tars claude 執行。` };
  return { kind: "message", text: skillInvocationText(name, content) };
}
