export type EntryStatus = "active" | "superseded";

export interface MemoryEntry {
  readonly id: string;
  readonly section: string;
  readonly status: EntryStatus;
  readonly date: string;
  readonly source: string | null;
  /** The lines under the id comment, byte-for-byte, line terminators included. */
  readonly body: string;
}

export type Block =
  | { readonly kind: "text"; readonly raw: string }
  | { readonly kind: "heading"; readonly section: string; readonly raw: string }
  | { readonly kind: "entry"; readonly entry: MemoryEntry };

/** Every byte of the file lives in exactly one block, in file order. */
export interface MemoryDocument {
  readonly blocks: readonly Block[];
}

export class MemoryParseError extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(`line ${line}: ${detail}`);
  }
}

// Only the canonical form counts as an entry, so parse then render returns the same bytes.
const ENTRY_HEADER =
  /^<!-- id: ([^\s|]+) \| observed: (\d{4}-\d{2}-\d{2}) \| status: (active|superseded)(?: \| source: ([^\s|]+))? -->\n$/;
const HEADING = /^## (.*\S)\s*$/;

export function parseMemory(source: string): MemoryDocument {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks: Block[] = [];
  const activeIds = new Set<string>();
  let section = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const heading = HEADING.exec(line);
    if (heading) {
      section = heading[1] ?? "";
      blocks.push({ kind: "heading", section, raw: line });
      i += 1;
      continue;
    }
    if (!line.startsWith("<!-- id:")) {
      const last = blocks.at(-1);
      if (last?.kind === "text") blocks[blocks.length - 1] = { kind: "text", raw: last.raw + line };
      else blocks.push({ kind: "text", raw: line });
      i += 1;
      continue;
    }

    const header = ENTRY_HEADER.exec(line);
    if (!header) {
      throw new MemoryParseError(
        i + 1,
        "id comment must look like `<!-- id: <id> | observed: YYYY-MM-DD | status: active|superseded -->`",
      );
    }
    const [, id = "", date = "", status, source] = header;
    let body = "";
    let next = i + 1;
    while (next < lines.length && isBodyLine(lines[next] ?? "")) {
      body += lines[next];
      next += 1;
    }
    if (body === "") throw new MemoryParseError(i + 1, `entry ${id} has no text`);
    if (status === "active") {
      if (activeIds.has(id)) throw new MemoryParseError(i + 1, `id ${id} has two active entries`);
      activeIds.add(id);
    }
    blocks.push({
      kind: "entry",
      entry: {
        id,
        section,
        status: status === "active" ? "active" : "superseded",
        date,
        source: source ?? null,
        body,
      },
    });
    i = next;
  }
  return { blocks };
}

function isBodyLine(line: string): boolean {
  return line.trim() !== "" && !line.startsWith("<!--") && !HEADING.test(line);
}

export function renderBlock(block: Block): string {
  if (block.kind !== "entry") return block.raw;
  const { id, date, status, source, body } = block.entry;
  const sourceField = source === null ? "" : ` | source: ${source}`;
  return `<!-- id: ${id} | observed: ${date} | status: ${status}${sourceField} -->\n${body}`;
}

export function renderMemory(doc: MemoryDocument): string {
  return doc.blocks.map(renderBlock).join("");
}
