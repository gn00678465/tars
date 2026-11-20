import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "../../../src/features/agent/provider.ts";
import { openWikiDb } from "../../../src/features/wiki/db.ts";
import { newPage, renderPage, type Entry, type Page } from "../../../src/features/wiki/page.ts";
import {
  rrf,
  searchTerms,
  searchWiki,
  snippet,
  type SearchQuery,
} from "../../../src/features/wiki/search.ts";
import { runSync } from "../../../src/features/wiki/sync.ts";
import { tokenize } from "../../../src/features/wiki/tokenize.ts";
import { run } from "../../../src/main.ts";
import { captureIo, testDeps } from "../../helpers.ts";
import { engineHarness, type EngineHarness } from "../agent/engine-fixture.ts";
import { chatTurn, type ChatTurnSpec } from "./wiki-fixture.ts";

const harnesses: EngineHarness[] = [];
const opened: Database[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) db.close();
  for (const h of harnesses.splice(0)) await h.stop();
});

const entry = (id: number, text: string): Entry => ({
  id,
  text,
  sources: [],
  assistant: false,
  temp: false,
});

function page(path: string, p: Omit<Partial<Page>, "facts"> & { facts?: string[] }): Page {
  const base = newPage(path, p.title ?? path, p.updated ?? "2026-11-01");
  return {
    ...base,
    ...p,
    facts: (p.facts ?? []).map((t, i) => entry(i + 1, t)),
    nextItem: (p.facts ?? []).length + 1,
  } as Page;
}

async function world() {
  const h = await engineHarness();
  harnesses.push(h);
  const put = (p: Page) => {
    mkdirSync(join(h.paths.wiki, p.type), { recursive: true });
    writeFileSync(join(h.paths.wiki, `${p.path}.md`), renderPage(p));
  };
  const turn = (spec: ChatTurnSpec) => chatTurn(h.db, { now: h.clock.now(), ...spec });
  const index = async () => {
    const r = await runSync(
      {
        paths: h.paths,
        env: h.env,
        secrets: h.secrets,
        adapterFor,
        now: () => h.clock.now(),
        sleep: async () => {},
        io: captureIo(),
      },
      { reindex: true },
      new AbortController().signal,
    );
    expect(r.state).toBe("completed");
    const w = await openWikiDb(h.paths);
    opened.push(w);
    return w;
  };
  const search = (w: Database | undefined, q: Partial<SearchQuery> & { query: string }) =>
    searchWiki({ wiki: w, agent: h.db }, { also: [], limit: 10, ...q });
  return { h, put, turn, index, search };
}

describe("rrf", () => {
  test("one list keeps its order; an item in two lists moves ahead", () => {
    expect([...rrf([{ main: ["a", "b", "c"] }]).keys()]).toEqual(["a", "b", "c"]);
    const two = rrf([{ main: ["a", "b", "c"] }, { main: ["c"] }]);
    expect([...two].toSorted((x, y) => y[1] - x[1])[0]?.[0]).toBe("c");
  });

  test("seven lists add up as by hand", () => {
    const lists = [
      { main: ["a", "b"] },
      { main: ["b", "a"] },
      { main: ["c"] },
      { main: ["a"] },
      { main: [] },
      { main: ["b", "c", "a"] },
      { main: ["c", "b"] },
    ];
    const s = rrf(lists);
    expect(s.get("a")).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 61 + 1 / 63, 12);
    expect(s.get("b")).toBeCloseTo(1 / 62 + 1 / 61 + 1 / 61 + 1 / 62, 12);
    expect(s.get("c")).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 61, 12);
  });

  test("an item only in a date-range list counts as rank 51", () => {
    const s = rrf([{ main: ["a"], extra: ["a", "z"] }]);
    expect(s.get("a")).toBeCloseTo(1 / 61, 12);
    expect(s.get("z")).toBeCloseTo(1 / 111, 12);
  });

  test("ties keep a fixed order: newer first, then by path", async () => {
    // Each page ranks first for one term and second for the other: equal scores.
    for (const [bUpdated, expected] of [
      ["2026-11-01", ["topics/a", "topics/b"]],
      ["2026-11-05", ["topics/b", "topics/a"]],
    ] as const) {
      const { put, index, search } = await world();
      put(page("topics/a", { title: "甲", updated: "2026-11-01", facts: ["蘋果蘋果 香蕉"] }));
      put(page("topics/b", { title: "乙", updated: bUpdated, facts: ["蘋果 香蕉香蕉"] }));
      const r = search(await index(), { query: "蘋果", also: ["香蕉"] });
      expect(r.pages.results[0]?.score).toBe(r.pages.results[1]?.score as number);
      expect(r.pages.results.map((p) => p.path)).toEqual([...expected]);
    }
  });
});

describe("searchWiki", () => {
  test("Chinese, English and mixed queries each give both groups; one character; nothing; punctuation", async () => {
    const { put, turn, index, search } = await world();
    put(
      page("investment/tsmc", {
        title: "台積電",
        aliases: ["TSMC"],
        facts: ["Q3財報的毛利率上升。"],
      }),
    );
    turn({ owner: "台積電的 Q3財報 出來了", assistant: ["TSMC 毛利率不錯"] });
    const w = await index();
    for (const query of ["台積電", "TSMC", "Q3財報", "電"]) {
      const r = search(w, { query });
      expect(r.pages.results.length).toBeGreaterThan(0);
      expect(r.records.results.length).toBeGreaterThan(0);
    }
    const none = search(w, { query: "颱風" });
    expect([none.pages.results, none.records.results]).toEqual([[], []]);
    const punct = search(w, { query: "，。！" });
    expect([punct.pages.results, punct.records.results]).toEqual([[], []]);
  });

  test("CUJ 3: an alias plus a word of the entry finds the page; the title alone hits the meta row", async () => {
    const { put, index, search } = await world();
    put(
      page("people/wang-xiaoming", {
        title: "王小明",
        aliases: ["小明"],
        facts: ["2026-12-14 搬家到台中西屯。"],
      }),
    );
    const w = await index();
    const r = search(w, { query: "小明 搬家" });
    expect(r.pages.results[0]).toMatchObject({
      path: "people/wang-xiaoming",
      section: "facts",
      item: "i1",
    });
    expect(search(w, { query: "王小明" }).pages.results[0]).toMatchObject({
      section: "meta",
      snippet: "王小明｜小明",
    });
  });

  test("a page with 60 hits does not push another page out", async () => {
    const { put, index, search } = await world();
    put(page("topics/other", { title: "其他", facts: ["香蕉"] }));
    put(page("topics/full", { title: "滿", facts: [] }));
    const w = await index();
    const meta = tokenize("滿");
    for (let i = 0; i < 60; i++) {
      const { id } = w
        .query(
          "INSERT INTO page_docs (path, section, item, text) VALUES ('topics/full', 'facts', ?, '香蕉香蕉香蕉') RETURNING id",
        )
        .get(`i${i + 1}`) as { id: number };
      w.run("INSERT INTO page_fts (rowid, meta_tokens, body_tokens) VALUES (?, ?, ?)", [
        id,
        meta,
        tokenize("香蕉香蕉香蕉"),
      ]);
    }
    const paths = search(w, { query: "香蕉" }).pages.results.map((p) => p.path);
    expect(paths).toContain("topics/other");
    expect(paths).toContain("topics/full");
  });

  test("five pages with 42 strong rows each do not push out a sixth that only matches its title", async () => {
    const { put, index, search } = await world();
    for (let n = 1; n <= 6; n++) put(page(`topics/t${n}`, { title: "台積電", facts: [] }));
    const w = await index();
    const meta = tokenize("台積電");
    const body = tokenize("台積電台積電台積電");
    for (let n = 1; n <= 5; n++)
      for (let i = 0; i < 42; i++) {
        const { id } = w
          .query(
            "INSERT INTO page_docs (path, section, item, text) VALUES (?, 'facts', ?, '台積電') RETURNING id",
          )
          .get(`topics/t${n}`, `i${i + 1}`) as { id: number };
        w.run("INSERT INTO page_fts (rowid, meta_tokens, body_tokens) VALUES (?, ?, ?)", [
          id,
          meta,
          body,
        ]);
      }
    const paths = search(w, { query: "台積電" }).pages.results.map((p) => p.path);
    expect(paths.toSorted()).toEqual([
      "topics/t1",
      "topics/t2",
      "topics/t3",
      "topics/t4",
      "topics/t5",
      "topics/t6",
    ]);
  });

  test("a date range moves results up, keeps the rest, and reaches past the top 50", async () => {
    const { h, turn, index, search } = await world();
    for (let i = 0; i < 55; i++) turn({ owner: "颱風颱風颱風 停班停課" });
    h.clock.advance(30 * 86_400_000);
    const late = turn({ owner: "颱風 這次好像比較小，可以出門" });
    const w = await index();
    const plain = search(w, { query: "颱風", limit: 50 });
    expect(plain.records.results.map((r) => r.turn)).not.toContain(late.turnId);
    const day = new Date(h.clock.now()).toISOString().slice(0, 10);
    const ranged = search(w, { query: "颱風", since: day, limit: 50 });
    expect(ranged.records.results[0]?.turn).toBe(late.turnId);
    expect(ranged.records.results.length).toBe(50);
  });

  test("TSMC, tsmc and the full-width form are one term", () => {
    expect(searchTerms({ query: "TSMC", also: ["tsmc", "ＴＳＭＣ", " "] })).toEqual(["tsmc"]);
  });

  test("the unindexed count includes turns still waiting to end", async () => {
    const { turn, index, search } = await world();
    turn({ owner: "還在跑", state: "running" });
    const w = await index();
    turn({ owner: "之後才有" });
    expect(search(w, { query: "x" }).records.unindexedTurns).toBe(2);
  });

  test("before any sync: both groups empty, and nothing indexed", async () => {
    const { search } = await world();
    const r = search(undefined, { query: "x" });
    expect(r.pages).toEqual({ indexedAt: null, results: [] });
    expect(r.records.results).toEqual([]);
  });
});

describe("snippet", () => {
  test("around the first hit; full-width text found by a half-width query; the start when nothing is found", () => {
    const long = `${"前".repeat(200)}重點在這裡${"後".repeat(200)}`;
    const s = snippet(long, ["重點"]);
    expect([...s].length).toBe(120);
    expect(s).toContain("重點在這裡");
    expect(snippet("在ＡＢＣ公司上班", ["abc"])).toBe("在abc公司上班");
    expect(snippet("開頭的文字", ["沒有"])).toBe("開頭的文字");
  });

  test("control characters are made visible", () => {
    expect(snippet("a\u001b[31mb", ["a"])).toBe("a\\u{1b}[31mb");
  });
});

describe("tars wiki search", () => {
  test("--json has the SearchJson shape", async () => {
    const { h, put, index } = await world();
    put(page("people/wang-xiaoming", { title: "王小明", facts: ["搬家到台中。"] }));
    chatTurn(h.db, { owner: "小明搬家了", now: h.clock.now() });
    await index();
    const deps = testDeps({ env: h.env, now: () => h.clock.now() });
    expect(await run(["wiki", "search", "搬家", "--json"], deps)).toBe(0);
    const out = JSON.parse(deps.io.stdout.join("\n"));
    expect(Object.keys(out).toSorted()).toEqual(["also", "pages", "query", "records"]);
    expect(Object.keys(out.pages.results[0]).toSorted()).toEqual(
      ["aliases", "item", "path", "score", "section", "snippet", "title", "updated"].toSorted(),
    );
    expect(Object.keys(out.records).toSorted()).toEqual(["indexedAt", "results", "unindexedTurns"]);
    expect(Object.keys(out.records.results[0]).toSorted()).toEqual(
      ["at", "conv", "score", "snippet", "source", "speaker", "turn"].toSorted(),
    );
  });

  test("the text form: both headers, and the punctuation-only note", async () => {
    const { h, index } = await world();
    await index();
    const deps = testDeps({ env: h.env, now: () => h.clock.now() });
    expect(await run(["wiki", "search", "，。"], deps)).toBe(0);
    expect(deps.io.stdout[0]).toStartWith("Wiki 頁面（0）｜頁面索引到 ");
    expect(deps.io.stdout).toContain("查詢裡沒有可以搜尋的字");
    expect(deps.io.stdout.some((l) => l.startsWith("原始對話紀錄（0）｜索引到 "))).toBe(true);
  });
});
