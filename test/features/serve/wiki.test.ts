import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  MESSAGE_BYTES,
  parseServer,
  PROTOCOL_VERSION,
  WIKI_ALIAS,
  WIKI_ALIASES,
  WIKI_CATEGORIES,
  WIKI_CHANGELOG,
  WIKI_ENTRIES,
  WIKI_ENTRY,
  WIKI_PATH,
  WIKI_QUERY,
  WIKI_RELATED,
  WIKI_RESULTS,
  WIKI_SOURCE_REF,
  WIKI_SUMMARY,
  WIKI_TITLE,
} from "@tars/protocol";
import { adapterFor } from "../../../src/features/agent/provider.ts";
import { answerWiki, type WikiRequest } from "../../../src/features/serve/wiki.ts";
import { openWikiDb } from "../../../src/features/wiki/db.ts";
import { sourceRef } from "../../../src/features/wiki/evidence.ts";
import {
  CATEGORIES,
  LIMITS,
  parsePagePath,
  SEARCH,
  SOURCE_REF,
} from "../../../src/features/wiki/page.ts";
import { run } from "../../../src/main.ts";
import { text } from "../../fakes/anthropic.ts";
import { testDeps } from "../../helpers.ts";
import { engineHarness, type EngineHarness } from "../agent/engine-fixture.ts";
import { chatTurn } from "../wiki/wiki-fixture.ts";

const harnesses: EngineHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
});

const json = (v: unknown) => text(JSON.stringify(v));
const PAGE = "people/wang-xiaoming";

async function setup() {
  const h = await engineHarness();
  harnesses.push(h);
  return h;
}

/** One conversation turn, and a sync that wrote PAGE from it with a checked quote. */
async function synced() {
  const h = await setup();
  const t = chatTurn(h.db, {
    owner: "王小明上個月搬到台中西屯了",
    assistant: ["記下了"],
    now: h.clock.now(),
  });
  const ref = sourceRef(t.convId, t.turnId);
  h.fake.reply(
    json({
      candidates: [
        {
          source: ref,
          page: PAGE,
          title: "王小明",
          section: "facts",
          text: "搬到台中西屯。",
          speaker: "owner",
          quote: "搬到台中西屯",
        },
      ],
    }),
    json({
      summary: { keep: true },
      facts: [{ op: "add", text: "搬到台中西屯。", from: ["c1"] }],
      open: [],
    }),
  );
  const deps = testDeps({ env: h.env, secrets: h.secrets, adapterFor, now: () => h.clock.now() });
  expect(await run(["wiki", "sync"], deps)).toBe(0);
  return { h, t, ref };
}

let ids = 0;
function request(kind: WikiRequest["kind"], p: object = {}): WikiRequest {
  return { v: PROTOCOL_VERSION, id: `w-${++ids}`, kind, p } as WikiRequest;
}

/** The answer's p, after checking it parses as the local end would send it. */
async function ask(h: EngineHarness, kind: WikiRequest["kind"], p: object = {}) {
  const a = await answerWiki(h.paths, request(kind, p));
  if (a === "newer") throw new Error("newer");
  const m = { v: PROTOCOL_VERSION, id: "x", kind: a.kind, re: "y", p: a.p };
  const raw = JSON.stringify(m);
  expect(parseServer(raw).ok).toBe(true);
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MESSAGE_BYTES);
  expect(a.kind).toBe(`${kind}.result` as typeof a.kind);
  return a.p as Record<string, unknown> & { [k: string]: any };
}

const pageFile = (h: EngineHarness, path: string) => join(h.paths.wiki, `${path}.md`);
function writePage(h: EngineHarness, path: string, body: string) {
  mkdirSync(dirname(pageFile(h, path)), { recursive: true });
  writeFileSync(pageFile(h, path), body);
}
const front = (path: string, title: string) =>
  `---\ntitle: ${title}\ntype: ${path.slice(0, path.indexOf("/"))}\ncreated: 2026-11-01\nupdated: 2026-11-02\n---\n`;

describe("before any sync", () => {
  test("status says so; the rest answer empty, and a turn can still be looked up", async () => {
    const h = await setup();
    const t = chatTurn(h.db, { owner: "說了一件事", now: h.clock.now() });
    expect(await ask(h, "wiki.status")).toEqual({
      synced: false,
      counts: { people: 0, projects: 0, topics: 0, life: 0, learning: 0, investment: 0 },
      total: 0,
    });
    expect(await ask(h, "wiki.list")).toEqual({ pages: [], more: false });
    expect(await ask(h, "wiki.page", { path: PAGE })).toEqual({ state: "missing", path: PAGE });
    const s = await ask(h, "wiki.search", { query: "事情" });
    expect(s.pages.results).toEqual([]);
    expect(s.records.results).toEqual([]);
    const src = await ask(h, "wiki.source", { ref: sourceRef(t.convId, t.turnId) });
    expect(src).toMatchObject({ found: true, owner: "說了一件事", quotes: [], turnNo: 1 });
  });
});

describe("after a sync", () => {
  test("status: pages per category, when the sync ended, how far the indexes reach", async () => {
    const { h } = await synced();
    const s = await ask(h, "wiki.status");
    expect(s).toMatchObject({ synced: true, total: 1, counts: { people: 1, projects: 0 } });
    expect(s.lastSyncAt).toBe(h.clock.now().getTime());
    expect(typeof s.indexedAt).toBe("number");
  });

  test("list: what tars wiki list lists", async () => {
    const { h } = await synced();
    expect(await ask(h, "wiki.list")).toEqual({
      pages: [{ path: PAGE, title: "王小明", updated: expect.any(String), blocked: false }],
      more: false,
    });
  });

  test("page: entries with their numbers and sources, the Change Log split into date and text", async () => {
    const { h, ref } = await synced();
    const p = await ask(h, "wiki.page", { path: PAGE });
    expect(p).toMatchObject({ state: "ok", path: PAGE, title: "王小明", truncated: false });
    expect(p.facts).toEqual([
      { id: "i1", text: "搬到台中西屯。", assistant: false, verified: true, sources: [ref] },
    ]);
    expect(p.changeLog[0]).toEqual({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      text: expect.stringContaining("建立。"),
    });
  });

  test("an entry the owner added by hand, or with a source sync never applied, is not verified", async () => {
    const { h, ref } = await synced();
    const other = "deadbeef/deadbeef";
    writePage(
      h,
      PAGE,
      `${front(PAGE, "王小明")}## 事實\n- [i1] 搬到台中西屯。 [[source:${ref}]]\n- 手寫的一條 [[source:${ref}]]\n- [i7] 另一條 [[source:${other}]]\n`,
    );
    const p = await ask(h, "wiki.page", { path: PAGE });
    expect(p.facts.map((e: { text: string; verified: boolean }) => [e.text, e.verified])).toEqual([
      ["搬到台中西屯。", true],
      ["手寫的一條", false],
      ["另一條", false],
    ]);
  });

  test("search: both tracks, a record with its conversation's title and the turn's place", async () => {
    const { h, t } = await synced();
    const s = await ask(h, "wiki.search", { query: "西屯" });
    expect(s.query).toBe("西屯");
    expect(s.pages.results).toEqual([
      expect.objectContaining({ path: PAGE, title: "王小明", section: "facts", item: "i1" }),
    ]);
    expect(s.records.results[0]).toMatchObject({
      conv: t.convId,
      turnNo: 1,
      speaker: "owner",
      snippet: expect.stringContaining("西屯"),
    });
    expect(typeof s.records.results[0].convTitle).toBe("string");
  });

  test("source: the turn's words without its tools, and the quote the page took from it", async () => {
    const { h, t, ref } = await synced();
    const src = await ask(h, "wiki.source", { ref, page: PAGE });
    expect(src).toMatchObject({
      ref,
      found: true,
      conv: t.convId,
      turnNo: 1,
      owner: "王小明上個月搬到台中西屯了",
      assistant: "記下了",
      quotes: ["搬到台中西屯"],
    });
    expect((await ask(h, "wiki.source", { ref })).quotes).toEqual([]);
    expect(await ask(h, "wiki.source", { ref: "deadbeef/deadbeef" })).toEqual({
      ref: "deadbeef/deadbeef",
      found: false,
    });
  });
});

describe("pages that cannot be shown whole", () => {
  test("a file that breaks the page rules: blocked, with why and nothing of its text", async () => {
    const h = await setup();
    writePage(h, "topics/broken", "no front matter\nsecret text\n");
    const p = await ask(h, "wiki.page", { path: "topics/broken" });
    expect(p).toEqual({ state: "blocked", path: "topics/broken", error: "沒有 frontmatter" });
  });

  test("a symlink, a symlinked category, a directory under a page's name: missing", async () => {
    const h = await setup();
    const outside = join(dirname(h.paths.memory), "outside.md");
    writeFileSync(outside, `${front("people/x", "外面")}## 摘要\n不該送出\n`);
    mkdirSync(join(h.paths.wiki, "people"), { recursive: true });
    symlinkSync(outside, pageFile(h, "people/linked"));
    mkdirSync(join(dirname(h.paths.memory), "elsewhere"), { recursive: true });
    writeFileSync(join(dirname(h.paths.memory), "elsewhere", "x.md"), front("topics/x", "外面"));
    symlinkSync(join(dirname(h.paths.memory), "elsewhere"), join(h.paths.wiki, "topics"));
    mkdirSync(pageFile(h, "people/dir"), { recursive: true });
    for (const path of ["people/linked", "topics/x", "people/dir"])
      expect(await ask(h, "wiki.page", { path })).toEqual({ state: "missing", path });
  });

  test("more entries and Change Log lines than a message takes: cut, and marked", async () => {
    const h = await setup();
    const n = WIKI_ENTRIES + 5;
    const facts = Array.from({ length: n }, (_, i) => `- [i${i + 1}] 第 ${i + 1} 條`).join("\n");
    const log = Array.from({ length: WIKI_CHANGELOG + 5 }, () => "- 2026-11-02 改寫。").join("\n");
    writePage(
      h,
      "topics/long",
      `${front("topics/long", "長")}## 事實\n${facts}\n## Change Log\n${log}\n`,
    );
    const p = await ask(h, "wiki.page", { path: "topics/long" });
    expect(p.facts).toHaveLength(WIKI_ENTRIES);
    expect(p.changeLog).toHaveLength(WIKI_CHANGELOG);
    expect(p.truncated).toBe(true);
  });

  test("text of escaped control characters and wide entries, within every count, still fits", async () => {
    const h = await setup();
    const line = `- 2026-11-02 ${"\u0001".repeat(499)}`;
    const log = Array.from({ length: WIKI_CHANGELOG }, () => line).join("\n");
    const entries = (from: number) =>
      Array.from(
        { length: WIKI_ENTRIES },
        (_, i) => `- [i${from + i}] ${"😀".repeat(WIKI_ENTRY)}`,
      ).join("\n");
    writePage(
      h,
      "topics/heavy",
      `${front("topics/heavy", "重")}## 摘要\n${"\u0001".repeat(WIKI_SUMMARY)}\n## 事實\n${entries(1)}\n## 未決\n${entries(100)}\n## Change Log\n${log}\n`,
    );
    // ask() checks the bytes and the parse.
    const p = await ask(h, "wiki.page", { path: "topics/heavy" });
    expect(p.changeLog.length).toBeLessThan(WIKI_CHANGELOG);
    expect(p.facts).toHaveLength(WIKI_ENTRIES);
    expect(p.truncated).toBe(true);
  });
});

test('a wiki.db from a newer tars is "newer": the page hears to update the local end', async () => {
  const h = await setup();
  const db = await openWikiDb(h.paths);
  db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
  db.close();
  expect(await answerWiki(h.paths, request("wiki.status"))).toBe("newer");
});

describe("G4: the remote knowledge base writes nothing", () => {
  /** Every file under the data and state directories: its bytes and mtime; SQLite's shm aside. */
  function snapshot(h: EngineHarness): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) out.set(p, "link");
        else if (e.isDirectory()) walk(p);
        // shm is SQLite's shared index of the WAL: a reader's read marks live there.
        else if (!e.name.endsWith("-shm")) {
          const bytes = readFileSync(p);
          // A reader may find an empty WAL there or leave one behind: nothing written to it.
          if (e.name.endsWith("-wal") && bytes.length === 0) continue;
          const hash = createHash("sha256").update(bytes).digest("hex");
          out.set(p, `${hash} ${statSync(p).mtimeMs}`);
        }
      }
    };
    for (const dir of new Set([dirname(h.paths.memory), dirname(h.paths.wikiDb)])) walk(dir);
    return out;
  }

  test("every request, the good and the bad, leaves every file as it was", async () => {
    const { h, ref } = await synced();
    writeFileSync(h.paths.memory, "- 記住的事\n");
    writePage(h, "topics/broken", "no front matter\n");
    const before = snapshot(h);
    expect([...before.keys()].some((p) => p.endsWith("wiki.db"))).toBe(true);
    const requests: [WikiRequest["kind"], object][] = [
      ["wiki.status", {}],
      ["wiki.list", {}],
      ["wiki.page", { path: PAGE }],
      ["wiki.page", { path: "topics/broken" }],
      ["wiki.page", { path: "life/none" }],
      ["wiki.search", { query: "西屯" }],
      ["wiki.search", { query: "沒有這個詞", limit: 1 }],
      ["wiki.source", { ref, page: PAGE }],
      ["wiki.source", { ref: "deadbeef/deadbeef" }],
    ];
    for (const [kind, p] of requests) await ask(h, kind, p);
    expect(snapshot(h)).toEqual(before);
    // Nothing went to a model.
    expect(h.fake.messages()).toHaveLength(2);
  });

  test("serve/wiki.ts reads only: read-only opens, readIn, no SQL that writes", () => {
    const src = readFileSync(join(import.meta.dir, "../../../src/features/serve/wiki.ts"), "utf8");
    const imports = [...src.matchAll(/^import (?:type )?\{([^}]*)\} from "([^"]+)";$/gm)].map(
      (m) =>
        [
          m[2] as string,
          (m[1] as string)
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean),
        ] as const,
    );
    const local = Object.fromEntries(imports.filter(([from]) => from.startsWith(".")));
    // Each local import, by name: none of them can write.
    expect(local).toEqual({
      "../../core/exit.ts": ["TarsError"],
      "../../core/paths.ts": ["TarsPaths"],
      "../agent/compaction.ts": ["clipMiddle"],
      "../agent/db.ts": ["openDb"],
      "../wiki/db.ts": ["openWikiDb"],
      "../wiki/evidence.ts": ["readTurnParts", "resolveSource", "sourceRef"],
      "../wiki/page.ts": ["parsePage", "type Category", "type Entry"],
      "../wiki/read.ts": ["categoryCounts", "listPages"],
      "../wiki/search.ts": ["scannedAt", "searchWiki"],
      "../wiki/wiki-dir.ts": ["readIn", "withWikiDir"],
    });
    expect(imports.filter(([from]) => !from.startsWith(".")).map(([from]) => from)).toEqual([
      "bun:sqlite",
      "@tars/protocol",
    ]);
    // Opened only for reading, and the wiki directory never created.
    expect([...src.matchAll(/open(?:Wiki)?Db\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
      "paths, { readonly: true }",
      "paths, { readonly: true }",
    ]);
    expect(
      [...src.matchAll(/withWikiDir\(([^)]*)\)/g)].map((m) => m[1]?.split(",")[2]?.trim()),
    ).toEqual(["false"]);
    // Statements: queries only.
    expect(src).not.toMatch(/\.(run|prepare)\(|(wiki|agent|db)\??\.exec\(/);
    expect(src).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM)\b/,
    );
  });
});

describe("the protocol's copy of the page rules", () => {
  test("limits, categories and patterns are the local end's", () => {
    expect([...WIKI_CATEGORIES]).toEqual([...CATEGORIES]);
    expect([WIKI_TITLE, WIKI_ALIAS, WIKI_ALIASES, WIKI_SUMMARY, WIKI_ENTRY, WIKI_RELATED]).toEqual([
      LIMITS.titleChars,
      LIMITS.aliasChars,
      LIMITS.aliases,
      LIMITS.summaryChars,
      LIMITS.entryChars,
      LIMITS.related,
    ]);
    expect([WIKI_QUERY, WIKI_RESULTS]).toEqual([SEARCH.termChars, SEARCH.limit]);
    expect(WIKI_SOURCE_REF.source).toBe(SOURCE_REF.source);
    for (const path of [
      "people/a",
      "people/a-1",
      `topics/${"a".repeat(64)}`,
      `topics/${"a".repeat(65)}`,
      "people/-a",
      "notes/a",
      "people/A",
    ])
      expect(WIKI_PATH.test(path)).toBe(parsePagePath(path) === path);
  });
});
