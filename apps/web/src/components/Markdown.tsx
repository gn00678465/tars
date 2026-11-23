import {
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useState,
} from "react";

/**
 * The model's Markdown as React nodes: headings, emphasis, code, lists, quotes, links, simple
 * tables. Every piece of its text becomes a text node; nothing is ever read as HTML. Line
 * breaks inside a paragraph stay (as in the terminal), so a reply asked for "three lines" shows
 * three lines.
 */
export function Markdown({ text, id }: { text: string; id?: string }) {
  return <>{blocks(text.split("\n"), { id, tables: 0 })}</>;
}

/**
 * Where a reply's tables keep the order the owner picked, by the reply's id and the table's
 * place in it: a streaming reply and the item it becomes are drawn by different trees, so the
 * table's own state would start over when the reply ends. Absent, a table keeps its own.
 */
export const TableSorts = createContext<Map<string, Sort> | undefined>(undefined);

/** The reply being drawn (its id, if it has one) and how many tables came before. */
type Ctx = { id: string | undefined; tables: number };

const FENCE = /^ {0,3}(```|~~~)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const startsBlock = (line: string, next: string | undefined) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  ITEM.test(line) ||
  isTable(line, next);

const isTable = (line: string, next: string | undefined) =>
  line.includes("|") && next !== undefined && next.includes("-") && TABLE_RULE.test(next);

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function blocks(lines: readonly string[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const key = out.length;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      i += 1;
      // An unclosed fence (a reply still streaming) runs to the end.
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(fence[1] as string))
        body.push(lines[i++] as string);
      i += 1;
      out.push(
        <pre key={key} className="tool-code-box">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      // The page's own headings come first: a reply's # is a level below them.
      const level = Math.min(6, (heading[1] as string).length + 2);
      const Tag = `h${level}` as "h3";
      out.push(
        <Tag key={key} className="md-heading">
          {inline(heading[2] as string)}
        </Tag>,
      );
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={key} className="md-rule" />);
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string))
        inner.push((lines[i++] as string).replace(QUOTE, ""));
      out.push(<blockquote key={key}>{blocks(inner, ctx)}</blockquote>);
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      const [node, next] = list(lines, i, ctx);
      out.push(<Fragment key={key}>{node}</Fragment>);
      i = next;
      continue;
    }
    if (isTable(line, lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim())
        rows.push(cells(lines[i++] as string));
      const n = ctx.tables++;
      out.push(
        <Table
          key={key}
          head={head}
          rows={rows}
          {...(ctx.id === undefined ? {} : { id: `${ctx.id}#${n}` })}
        />,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== "" &&
      (para.length === 0 || !startsBlock(lines[i] as string, lines[i + 1]))
    )
      para.push(lines[i++] as string);
    out.push(<p key={key}>{inline(para.join("\n"))}</p>);
  }
  return out;
}

const EMPTY = new Set(["", "-", "—"]);
/** Plain decimals only: no exponent, hex or Infinity, which read as text in a table. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const collator = new Intl.Collator("zh-Hant", { numeric: true });

/** A cell as a number: thousands commas and a percent sign dropped; anything else is not one. */
function numeric(cell: string): number | undefined {
  const t = cell.replaceAll(",", "").replace(/%$/, "").replace(/^−/, "-");
  if (!NUMBER.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export type Sort = { col: number; dir: 1 | -1 };

const hasLink = (nodes: ReactNode): boolean =>
  Array.isArray(nodes)
    ? nodes.some(hasLink)
    : isValidElement<{ children?: ReactNode }>(nodes) &&
      (nodes.type === "a" || hasLink(nodes.props.children));

/** The text the nodes show, as a cell's sort key. */
function shown(nodes: ReactNode): string {
  if (typeof nodes === "string" || typeof nodes === "number") return String(nodes);
  if (Array.isArray(nodes)) return nodes.map(shown).join("");
  return isValidElement<{ children?: ReactNode }>(nodes) ? shown(nodes.props.children) : "";
}

/**
 * The rows' indexes in the order of one column, its type guessed from the text each cell shows
 * (a link's label, **12** as 12): a column whose filled cells are all numbers sorts by value,
 * any other by the zh-Hant collator. Empty cells go last either way; equal ones keep their
 * order (the index is the last key, not the engine's sort).
 */
export function sortOrder(rows: readonly string[][], sort: Sort): number[] {
  const text = rows.map((r) => shown(inline(r[sort.col] ?? "")).trim());
  const filled = text.filter((t) => !EMPTY.has(t));
  const byValue = filled.length > 0 && filled.every((t) => numeric(t) !== undefined);
  const order = rows.map((_, k) => k);
  order.sort((a, b) => {
    const ea = EMPTY.has(text[a] as string);
    const eb = EMPTY.has(text[b] as string);
    if (ea !== eb) return ea ? 1 : -1;
    const c = ea
      ? 0
      : byValue
        ? (numeric(text[a] as string) as number) - (numeric(text[b] as string) as number)
        : collator.compare(text[a] as string, text[b] as string);
    return c * sort.dir || a - b;
  });
  return order;
}

/**
 * A Markdown table whose headings sort it, on this page only: nothing is saved or sent, so a
 * reload shows the reply's order. A table whose heading row is all empty has nothing to click.
 */
function Table({
  head,
  rows,
  id,
}: {
  head: readonly string[];
  rows: readonly string[][];
  id?: string;
}) {
  const kept = useContext(TableSorts);
  const [sort, setSort] = useState(() => (id === undefined ? undefined : kept?.get(id)));
  const sortable = head.some((c) => c !== "");
  const order = sort === undefined ? rows.map((_, k) => k) : sortOrder(rows, sort);
  const click = (col: number) => {
    const next: Sort = sort?.col === col ? { col, dir: sort.dir === 1 ? -1 : 1 } : { col, dir: 1 };
    if (id !== undefined) kept?.set(id, next);
    setSort(next);
  };
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            {head.map((c, j) => {
              if (!sortable) return <th key={j}>{inline(c)}</th>;
              const dir = sort?.col === j ? sort.dir : undefined;
              const label = inline(c);
              // A link is not put in the button (no control inside a control); an empty heading
              // has no text: either way the button is named for its column.
              const linked = hasLink(label);
              const name = c === "" ? `第 ${j + 1} 欄` : shown(label);
              return (
                <th
                  key={j}
                  scope="col"
                  className={linked ? "md-sort-linked" : undefined}
                  {...(dir === undefined
                    ? {}
                    : { "aria-sort": dir === 1 ? "ascending" : "descending" })}
                >
                  {linked ? label : null}
                  <button
                    type="button"
                    className="md-sort"
                    onClick={() => click(j)}
                    {...(linked || c === "" ? { "aria-label": name } : {})}
                  >
                    {linked ? null : label}
                    <span className="md-sort-mark" aria-hidden="true" />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {order.map((k) => (
            <tr key={k}>
              {head.map((_, j) => (
                <td key={j}>{inline(rows[k]?.[j] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A list from line `start`: its items, each with the lines indented under it (nested lists). */
function list(lines: readonly string[], start: number, ctx: Ctx): [ReactNode, number] {
  const first = ITEM.exec(lines[start] as string) as RegExpExecArray;
  const indent = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as string;
    const m = ITEM.exec(line);
    if (m !== null && (m[1] as string).length === indent && /\d/.test(m[2] as string) === ordered) {
      items.push([m[3] as string]);
      i += 1;
      continue;
    }
    // Indented under the item (a nested list, a second line), or a blank line inside the list.
    const deeper = line.trim() !== "" && line.length - line.trimStart().length > indent;
    const blankInside =
      line.trim() === "" &&
      i + 1 < lines.length &&
      ((lines[i + 1] as string).length - (lines[i + 1] as string).trimStart().length > indent ||
        ITEM.exec(lines[i + 1] as string)?.[1]?.length === indent);
    if (!deeper && !blankInside) break;
    items.at(-1)?.push(line.slice(Math.min(line.length - line.trimStart().length, indent + 2)));
    i += 1;
  }
  const body = items.map((it, k) => {
    // A one-line item is its text; one with more is blocks of its own.
    const content = it.length === 1 ? inline(it[0] as string) : blocks(it, ctx);
    return <li key={k}>{content}</li>;
  });
  const n = Number.parseInt(first[2] as string, 10);
  return [ordered ? <ol start={n === 1 ? undefined : n}>{body}</ol> : <ul>{body}</ul>, i];
}

/** Only these open: a javascript: or data: link stays the text it was written as. */
function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const link = (href: string, children: ReactNode, key: number) => (
  <a key={key} href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

/** Each kind of span, tried at every position; the earliest match wins, then the listed order. */
const SPANS: readonly [RegExp, (m: RegExpExecArray, key: number) => ReactNode][] = [
  [/`([^`\n]+)`/, (m, k) => <code key={k}>{m[1]}</code>],
  [
    /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    (m, k) => {
      const href = safeHref(m[2] as string);
      return href === undefined ? m[0] : link(href, inline(m[1] as string), k);
    },
  ],
  [/\*\*(?=\S)(.+?)\*\*/, (m, k) => <strong key={k}>{inline(m[1] as string)}</strong>],
  [/__(?=\S)(.+?)__/, (m, k) => <strong key={k}>{inline(m[1] as string)}</strong>],
  [/~~(?=\S)(.+?)~~/, (m, k) => <del key={k}>{inline(m[1] as string)}</del>],
  [/\*(?=\S)([^*\n]+?)\*/, (m, k) => <em key={k}>{inline(m[1] as string)}</em>],
  // Not inside a word: snake_case names stay as written.
  [
    /(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+?)_(?![\p{L}\p{N}_])/u,
    (m, k) => <em key={k}>{inline(m[1] as string)}</em>,
  ],
  [
    /https?:\/\/[^\s<>()「」（）]+[^\s<>()「」（）.,;:!?'"。，、；：！？]/,
    (m, k) => {
      const href = safeHref(m[0]);
      return href === undefined ? m[0] : link(href, m[0], k);
    },
  ],
];

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  while (rest !== "") {
    let best: [RegExpExecArray, (typeof SPANS)[number][1]] | undefined;
    for (const [re, make] of SPANS) {
      const m = re.exec(rest);
      if (m !== null && (best === undefined || m.index < best[0].index)) best = [m, make];
    }
    if (best === undefined) {
      out.push(rest);
      break;
    }
    const [m, make] = best;
    if (m.index > 0) out.push(rest.slice(0, m.index));
    out.push(make(m, out.length));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
