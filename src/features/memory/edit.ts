import { renderBlock, type Block, type MemoryDocument, type MemoryEntry } from "./document.ts";

export const SOURCES = ["user", "inferred"] as const;
export type Source = (typeof SOURCES)[number];

export type MemoryOp =
  | {
      readonly kind: "remember";
      readonly id: string;
      readonly section: string;
      readonly text: string;
      readonly date: string;
      readonly source: Source;
    }
  | { readonly kind: "forget-id"; readonly id: string }
  | { readonly kind: "forget-match"; readonly match: string };

export type EditResult = "added" | "replaced" | "forgotten" | "unchanged";

export type EditError =
  | { readonly kind: "section-mismatch"; readonly id: string; readonly section: string }
  | { readonly kind: "id-not-found"; readonly id: string }
  | { readonly kind: "no-match"; readonly match: string }
  | {
      readonly kind: "ambiguous-match";
      readonly match: string;
      readonly candidates: readonly MemoryEntry[];
    };

export type EditOutcome =
  | {
      readonly ok: true;
      readonly result: EditResult;
      readonly entry: MemoryEntry;
      readonly doc: MemoryDocument;
    }
  | { readonly ok: false; readonly error: EditError };

export function applyMemoryOp(doc: MemoryDocument, op: MemoryOp): EditOutcome {
  switch (op.kind) {
    case "remember":
      return remember(doc, op);
    case "forget-id":
      return forgetById(doc, op.id);
    case "forget-match":
      return forgetByMatch(doc, op.match);
  }
}

function remember(doc: MemoryDocument, op: Extract<MemoryOp, { kind: "remember" }>): EditOutcome {
  const blocks = [...doc.blocks];
  const fresh: MemoryEntry = {
    id: op.id,
    section: op.section,
    status: "active",
    date: op.date,
    source: op.source,
    body: `- ${op.text}\n`,
  };
  const sameId = entryIndexes(blocks, (e) => e.id === op.id);
  const activeIndex = sameId.find((i) => entryAt(blocks, i).status === "active");
  const anchorIndex = activeIndex ?? sameId.at(-1);

  if (anchorIndex === undefined) {
    insertIntoSection(blocks, fresh);
    return { ok: true, result: "added", entry: fresh, doc: { blocks } };
  }
  const anchor = entryAt(blocks, anchorIndex);
  if (anchor.section !== op.section) {
    return { ok: false, error: { kind: "section-mismatch", id: op.id, section: anchor.section } };
  }
  if (activeIndex !== undefined) {
    if (anchor.body.replace(/\n$/, "") === `- ${op.text}`)
      return { ok: true, result: "unchanged", entry: anchor, doc };
    blocks[activeIndex] = { kind: "entry", entry: { ...anchor, status: "superseded" } };
  }
  insertEntry(blocks, anchorIndex + 1, fresh);
  return {
    ok: true,
    result: activeIndex === undefined ? "added" : "replaced",
    entry: fresh,
    doc: { blocks },
  };
}

function forgetById(doc: MemoryDocument, id: string): EditOutcome {
  const sameId = entryIndexes(doc.blocks, (e) => e.id === id);
  const activeIndex = sameId.find((i) => entryAt(doc.blocks, i).status === "active");
  if (activeIndex !== undefined) return supersede(doc, activeIndex);
  const last = sameId.at(-1);
  if (last === undefined) return { ok: false, error: { kind: "id-not-found", id } };
  return { ok: true, result: "unchanged", entry: entryAt(doc.blocks, last), doc };
}

function forgetByMatch(doc: MemoryDocument, match: string): EditOutcome {
  const needle = match.toLowerCase();
  const hits = entryIndexes(
    doc.blocks,
    (e) => e.status === "active" && e.body.toLowerCase().includes(needle),
  );
  const [only] = hits;
  if (only === undefined) return { ok: false, error: { kind: "no-match", match } };
  if (hits.length > 1) {
    const candidates = hits.map((i) => entryAt(doc.blocks, i));
    return { ok: false, error: { kind: "ambiguous-match", match, candidates } };
  }
  return supersede(doc, only);
}

function supersede(doc: MemoryDocument, index: number): EditOutcome {
  const entry: MemoryEntry = { ...entryAt(doc.blocks, index), status: "superseded" };
  const blocks = [...doc.blocks];
  blocks[index] = { kind: "entry", entry };
  return { ok: true, result: "forgotten", entry, doc: { blocks } };
}

function entryIndexes(blocks: readonly Block[], keep: (entry: MemoryEntry) => boolean): number[] {
  return blocks.flatMap((b, i) => (b.kind === "entry" && keep(b.entry) ? [i] : []));
}

function entryAt(blocks: readonly Block[], index: number): MemoryEntry {
  const block = blocks[index];
  if (block?.kind !== "entry") throw new Error(`block ${index} is not an entry`);
  return block.entry;
}

/** New entries go to the end of their section; a missing section is appended to the file. */
function insertIntoSection(blocks: Block[], entry: MemoryEntry): void {
  const heading = blocks.findIndex((b) => b.kind === "heading" && b.section === entry.section);
  if (heading === -1) {
    const last = blocks.at(-1);
    const lead = blankLineAfter(last ? renderBlock(last) : "");
    if (lead) blocks.push({ kind: "text", raw: lead });
    blocks.push({ kind: "heading", section: entry.section, raw: `## ${entry.section}\n` });
    insertEntry(blocks, blocks.length, entry);
    return;
  }
  const nextHeading = blocks.findIndex((b, i) => i > heading && b.kind === "heading");
  const end = nextHeading === -1 ? blocks.length : nextHeading;
  const lastEntry = entryIndexes(blocks, () => true)
    .filter((i) => i > heading && i < end)
    .at(-1);
  insertEntry(blocks, (lastEntry ?? heading) + 1, entry);
}

/** Keeps a blank line on both sides so the new entry's body cannot run into its neighbours. */
function insertEntry(blocks: Block[], index: number, entry: MemoryEntry): void {
  const prev = blocks[index - 1];
  const after = blocks[index];
  const inserted: Block[] = [];
  const lead = blankLineAfter(prev ? renderBlock(prev) : "");
  if (lead) inserted.push({ kind: "text", raw: lead });
  inserted.push({ kind: "entry", entry });
  if (after && !renderBlock(after).startsWith("\n")) inserted.push({ kind: "text", raw: "\n" });
  blocks.splice(index, 0, ...inserted);
}

function blankLineAfter(raw: string): string {
  if (raw === "" || raw.endsWith("\n\n")) return "";
  return raw.endsWith("\n") ? "\n" : "\n\n";
}
