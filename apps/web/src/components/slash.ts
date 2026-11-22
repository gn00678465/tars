import { skillInvocationText, type WireStatus } from "@tars/protocol";

export type Skill = NonNullable<WireStatus["skills"]>[number];

/**
 * The terminal's built-ins that have a page here. /model, /effort, /compact and /wiki have no
 * message to the local end yet, so they are not offered at all.
 */
export const BUILTINS = [
  { name: "new", description: "開新對話" },
  { name: "cost", description: "看花費、連線與待核准（狀態面板）" },
  { name: "help", description: "列出這裡能用的指令與 skills" },
] as const;

export type Builtin = (typeof BUILTINS)[number]["name"];

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
export function menuFor(text: string, skills: readonly Skill[] | undefined): Option[] | undefined {
  if (!text.startsWith("/") || text.startsWith("//") || /\s/.test(text)) return undefined;
  const query = text.slice(1);
  const all: Option[] = [
    ...BUILTINS.map((b) => ({ group: "內建指令" as const, ...b, enabled: true, builtin: true })),
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
  | { readonly kind: "builtin"; readonly name: Builtin }
  | { readonly kind: "refused"; readonly text: string };

/**
 * What a line the owner sends does, as the terminal's tars chat: `//` sends the rest with one
 * slash, `/<skill> [content]` sends the same wording the terminal sends, a local-only skill or
 * an unknown name sends nothing. Without a skill list (a local end older than it) a slash line
 * is a plain message, as before.
 */
export function slashOf(line: string, skills: readonly Skill[] | undefined): Slash {
  if (line.startsWith("//")) return { kind: "message", text: line.slice(1) };
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(line);
  if (m === null) return { kind: "message", text: line };
  const name = m[1] as string;
  const content = (m[2] ?? "").trim();
  const builtin = BUILTINS.find((b) => b.name === name);
  if (builtin !== undefined) return { kind: "builtin", name: builtin.name };
  if (skills === undefined) return { kind: "message", text: line };
  const skill = skills.find((s) => s.name === name);
  if (skill === undefined)
    return { kind: "refused", text: `不認得的指令 /${name}。輸入 /help 看可用的指令` };
  if (skill.localOnly)
    return { kind: "refused", text: `${name} 要在 tars claude 裡用，這裡不送出` };
  return { kind: "message", text: skillInvocationText(name, content) };
}
