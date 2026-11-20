import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_TEMPLATE } from "../../../src/features/agent/config.ts";
import { adjust } from "../../../src/features/agent/ledger.ts";
import { adapterFor } from "../../../src/features/agent/provider.ts";
import { openWikiDb } from "../../../src/features/wiki/db.ts";
import { sourceRef } from "../../../src/features/wiki/evidence.ts";
import { renderPage, newPage } from "../../../src/features/wiki/page.ts";
import {
  renderWikiPages,
  runSync,
  type SyncDeps,
  type SyncOptions,
} from "../../../src/features/wiki/sync.ts";
import { text, type FakeReply } from "../../fakes/anthropic.ts";
import { captureIo } from "../../helpers.ts";
import { engineHarness, type EngineHarness, type HarnessOptions } from "../agent/engine-fixture.ts";
import { chatTurn, type ChatTurnSpec } from "./wiki-fixture.ts";

interface SyncHarness extends EngineHarness {
  readonly io: ReturnType<typeof captureIo>;
  sync(opts?: SyncOptions, signal?: AbortSignal): ReturnType<typeof runSync>;
  turn(spec: ChatTurnSpec): { convId: string; turnId: string; ref: string };
  /** A read connection to wiki.db; closed after the test. */
  wiki(): Database;
  page(path: string): string;
  writePage(path: string, content: string): void;
}

const harnesses: EngineHarness[] = [];
const opened: Database[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) db.close();
  for (const h of harnesses.splice(0)) await h.stop();
});

/** CONFIG_TEMPLATE with its [wiki] section replaced. */
const wikiConfig = (daily: number, monthly = 10) =>
  CONFIG_TEMPLATE.replace(
    /\[wiki\][\s\S]*$/,
    `[wiki]\ndaily_cap_usd = ${daily}\nmonthly_cap_usd = ${monthly}\nmodel = ""\n`,
  );

async function harness(opts: HarnessOptions = {}): Promise<SyncHarness> {
  const h = await engineHarness(opts);
  harnesses.push(h);
  const io = captureIo();
  const deps: SyncDeps = {
    paths: h.paths,
    env: h.env,
    secrets: h.secrets,
    adapterFor,
    now: () => h.clock.now(),
    sleep: async (ms) => void h.sleeps.push(ms),
    io,
  };
  // Unless a test queues replies, every extraction finds nothing.
  h.fake.handler = () => json({ candidates: [] });
  return Object.assign(h, {
    io,
    sync: (o: SyncOptions = {}, signal = new AbortController().signal) => runSync(deps, o, signal),
    turn: (spec: ChatTurnSpec) => {
      const t = chatTurn(h.db, { now: h.clock.now(), ...spec });
      return { ...t, ref: sourceRef(t.convId, t.turnId) };
    },
    wiki: () => {
      const db = openWikiDb(h.paths, { readonly: true });
      if (db === undefined || db === "newer") throw new Error("no wiki.db");
      opened.push(db);
      return db;
    },
    page: (path: string) => readFileSync(join(h.paths.wiki, `${path}.md`), "utf8"),
    writePage: (path: string, content: string) => {
      mkdirSync(join(h.paths.wiki, path.split("/")[0] as string), { recursive: true });
      writeFileSync(join(h.paths.wiki, `${path}.md`), content);
    },
  });
}

const json = (v: unknown): FakeReply => text(JSON.stringify(v));

const all = <T>(db: Database, sql: string, ...params: (string | number)[]) =>
  db.query(sql).all(...params) as T[];
const one = <T>(db: Database, sql: string, ...params: (string | number)[]) =>
  db.query(sql).get(...params) as T;

interface Cand {
  source: string;
  page?: string;
  title?: string;
  section?: string;
  text?: string;
  speaker?: string;
  quote: string;
}
const candidate = (c: Cand) => ({
  page: "people/wang-xiaoming",
  title: "王小明",
  section: "facts",
  text: "王小明搬到台中。",
  speaker: "owner",
  ...c,
});
const extracted = (...cs: Cand[]) => json({ candidates: cs.map(candidate) });

const OWNER = "王小明上個月搬到台中西屯了";
const keepAll = (adds: { from: string[]; text?: string }[]) => ({
  summary: { keep: true },
  facts: adds.map((a) => ({ op: "add", text: a.text ?? "搬到台中西屯。", from: a.from })),
  open: [],
});

/** Sends of a kind: the system prompt tells extraction from consolidation. */
const sent = (h: SyncHarness, kind: "extract" | "consolidate") =>
  h.fake
    .messages()
    .filter((m) =>
      JSON.stringify(m.body.system).includes(
        kind === "extract" ? "You build a personal" : "You maintain one page",
      ),
    );
const messageText = (m: { body: Record<string, unknown> }) =>
  JSON.stringify((m.body.messages as { content: unknown }[])[0]?.content);

/** One owner turn, extracted into one candidate, written as a new page. */
async function onePage(h: SyncHarness) {
  const t = h.turn({ owner: OWNER, assistant: ["好的"] });
  h.fake.reply(
    extracted({ source: t.ref, quote: "搬到台中西屯" }),
    json(keepAll([{ from: [`c1`] }])),
  );
  expect(await h.sync()).toEqual({ state: "completed" });
  return t;
}

describe("scanning turns", () => {
  test("a running turn waits without holding up later ones, and is taken once it ends", async () => {
    const h = await harness();
    const running = h.turn({ owner: "還在跑", state: "running" });
    const done = h.turn({ owner: "已經結束" });
    await h.sync();
    const w = h.wiki();
    expect(all(w, "SELECT turn_id FROM sources")).toEqual([{ turn_id: done.turnId }]);
    expect(one(w, "SELECT COUNT(*) AS n FROM waiting_turns")).toEqual({ n: 1 });
    h.db.run("UPDATE turns SET state = 'completed' WHERE id = ?", [running.turnId]);
    await h.sync();
    expect(all(w, "SELECT turn_id FROM sources ORDER BY turn_rowid").length).toBe(2);
    expect(one(w, "SELECT COUNT(*) AS n FROM waiting_turns")).toEqual({ n: 0 });
  });

  test("a compaction turn gives no source; an empty turn is skipped; a rerun adds nothing", async () => {
    const h = await harness();
    h.turn({ owner: "summary", kind: "compaction" });
    const empty = h.turn({ owner: "", assistant: [""] });
    const real = h.turn({ owner: "說了話", assistant: ["回了話"] });
    await h.sync();
    const w = h.wiki();
    const states = () =>
      all<{ turn_id: string; state: string }>(
        w,
        "SELECT turn_id, state FROM sources ORDER BY turn_rowid",
      );
    expect(states()).toEqual([
      { turn_id: empty.turnId, state: "skipped" },
      { turn_id: real.turnId, state: "extracted" },
    ]);
    expect(one(w, "SELECT COUNT(*) AS n FROM raw_docs")).toEqual({ n: 2 });
    await h.sync();
    expect(states()).toHaveLength(2);
    expect(one(w, "SELECT COUNT(*) AS n FROM raw_docs")).toEqual({ n: 2 });
  });
});

describe("scanning pages", () => {
  const good = (title: string) =>
    renderPage({
      ...newPage("people/someone", title, "2026-11-01"),
      changeLog: ["2026-11-01 建立。"],
    });

  test("new, changed, deleted, broken, and badly named files", async () => {
    const h = await harness();
    h.writePage("people/someone", good("某人"));
    h.writePage("people/Upper", good("大寫"));
    h.writePage("people/中文", good("中文"));
    await h.sync();
    const w = h.wiki();
    const row = () =>
      one<{ state: string; title: string; external_change: number } | null>(
        w,
        "SELECT state, title, external_change FROM pages WHERE path = 'people/someone'",
      );
    expect(row()).toEqual({ state: "ok", title: "某人", external_change: 1 });
    expect(all(w, "SELECT path FROM pages")).toEqual([{ path: "people/someone" }]);
    expect(h.io.stderr.join("\n")).toContain("略過 people/Upper.md");
    expect(h.io.stderr.join("\n")).toContain("略過 people/中文.md");

    h.writePage("people/someone", good("某人改名"));
    await h.sync();
    expect(row()).toEqual({ state: "ok", title: "某人改名", external_change: 1 });

    h.writePage("people/someone", `${good("某人改名")}## 筆記\n亂寫\n`);
    await h.sync();
    expect(row()?.state).toBe("blocked");
    expect(one(w, "SELECT COUNT(*) AS n FROM page_docs WHERE path = 'people/someone'")).toEqual({
      n: 1,
    });

    rmSync(join(h.paths.wiki, "people/someone.md"));
    await h.sync();
    expect(row()).toBeNull();
    expect(one(w, "SELECT COUNT(*) AS n FROM page_docs")).toEqual({ n: 0 });
  });
});

describe("--reindex", () => {
  test("the same rows again, progress untouched, a blocked page kept, index.md rewritten, no request", async () => {
    const h = await harness();
    await onePage(h);
    h.turn({ owner: "另一句話", assistant: ["回答"] });
    await h.sync();
    h.writePage("people/broken", "---\ntitle: x\n---\n## 奇怪\n");
    const w = h.wiki();
    const snapshot = () => ({
      raw: one(w, "SELECT COUNT(*) AS n FROM raw_docs"),
      sources: all(w, "SELECT * FROM sources ORDER BY turn_id"),
      candidates: all(w, "SELECT * FROM candidates ORDER BY id"),
      cursor: all(w, "SELECT * FROM cursors"),
    });
    await h.sync();
    const blockedDocs = one(w, "SELECT COUNT(*) AS n FROM page_docs WHERE path = 'people/broken'");
    const before = snapshot();
    const pageDocs = one(w, "SELECT COUNT(*) AS n FROM page_docs");
    rmSync(h.paths.wikiIndex);
    const requests = h.fake.messages().length;
    expect(await h.sync({ reindex: true })).toEqual({ state: "completed" });
    expect(snapshot()).toEqual(before);
    expect(one(w, "SELECT COUNT(*) AS n FROM page_docs")).toEqual(pageDocs);
    expect(one(w, "SELECT COUNT(*) AS n FROM page_docs WHERE path = 'people/broken'")).toEqual(
      blockedDocs,
    );
    expect(existsSync(h.paths.wikiIndex)).toBe(true);
    expect(h.fake.messages()).toHaveLength(requests);
  });
});

describe("<wiki-pages>", () => {
  test("pages newest first, this sync's new pages first and marked, cut from the end", async () => {
    const h = await harness();
    await h.sync();
    const db = await openWikiDb(h.paths);
    opened.push(db);
    const page = (path: string, title: string, updated: string) =>
      db.run(
        `INSERT INTO pages (path, title, aliases, created, updated, hash, next_item, state)
         VALUES (?, ?, '["別名"]', ?, ?, 'h', 1, 'ok')`,
        [path, title, updated, updated],
      );
    page("people/old", "舊的", "2026-01-01");
    page("people/new", "新的", "2026-11-01");
    db.run(
      "INSERT INTO sources (turn_id, conv_id, turn_rowid, day, state) VALUES ('t', 'c', 1, 'd', 'extracted')",
    );
    db.run(
      `INSERT INTO candidates (source_turn_id, page, title, section, text, speaker, quote, state, created_at)
       VALUES ('t', 'topics/japan-trip', '日本旅行', 'open', 'x', 'owner', 'q', 'pending', 0)`,
    );
    expect(renderWikiPages(db)).toBe(
      [
        "<wiki-pages>",
        "topics/japan-trip｜日本旅行｜（還沒寫入）",
        "people/new｜新的｜別名",
        "people/old｜舊的｜別名",
        "</wiki-pages>",
      ].join("\n"),
    );
    for (let i = 0; i < 300; i++)
      page(`topics/t-${String(i).padStart(3, "0")}`, "很長的標題".repeat(4), "2025-01-01");
    const cut = renderWikiPages(db);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(8000);
    expect(cut).toContain("people/old｜舊的");
    expect(cut).toEndWith("</wiki-pages>");
    expect(cut).not.toContain("topics/t-299");
  });
});

describe("extraction", () => {
  test("candidates pass; a fenced reply parses; a bad quote and a secret are refused one by one", async () => {
    const h = await harness();
    const t = h.turn({ owner: OWNER, assistant: ["記下了"] });
    const reply = JSON.stringify({
      candidates: [
        candidate({ source: t.ref, quote: "搬到台中西屯" }),
        candidate({ source: t.ref, quote: "搬到台北" }),
        candidate({ source: t.ref, quote: "搬到台中西屯", text: `金鑰 ${"sk-" + "a".repeat(20)}` }),
        candidate({ source: "00000000/00000000", quote: "搬到台中西屯" }),
      ],
    });
    h.fake.reply(text(`\`\`\`json\n${reply}\n\`\`\``), json(keepAll([{ from: ["c1"] }])));
    await h.sync();
    const w = h.wiki();
    expect(all(w, "SELECT state, last_error, text, quote FROM candidates ORDER BY id")).toEqual([
      { state: "applied", last_error: null, text: "王小明搬到台中。", quote: "搬到台中西屯" },
      { state: "rejected", last_error: "bad_quote", text: "王小明搬到台中。", quote: "搬到台北" },
      { state: "rejected", last_error: "secret", text: "", quote: "" },
    ]);
    expect(one(w, "SELECT state FROM sources")).toEqual({ state: "extracted" });
    expect(h.io.stdout).toContain(
      "抽取：送出 1 批，候選 1，退回 3（原文對不上 1、機密 1、來源不在這一批 1）",
    );
  });

  test("broken JSON and bad_request count against the batch; three tries and it is failed", async () => {
    const h = await harness();
    h.turn({ owner: OWNER });
    const attempts = () =>
      one<{ state: string; attempts: number; last_error: string }>(
        h.wiki(),
        "SELECT state, attempts, last_error FROM sources",
      );
    h.fake.reply(text("not json"));
    await h.sync();
    expect(attempts()).toEqual({ state: "pending", attempts: 1, last_error: "bad_json" });
    h.fake.reply({ kind: "http_error", status: 400, type: "invalid_request_error" });
    await h.sync();
    expect(attempts()).toEqual({ state: "pending", attempts: 2, last_error: "bad_request" });
    h.fake.reply(json({ candidates: "no" }));
    await h.sync();
    expect(attempts()).toEqual({ state: "failed", attempts: 3, last_error: "bad_json" });
    const before = h.fake.messages().length;
    await h.sync();
    expect(h.fake.messages()).toHaveLength(before);
  });

  test("a cut-off reply splits the batch in two; one turn still cut off counts against it", async () => {
    const h = await harness();
    const a = h.turn({ owner: "第一個回合" });
    const b = h.turn({ owner: "第二個回合" });
    const cut: FakeReply = {
      kind: "message",
      blocks: [{ type: "text", text: '{"cand' }],
      stop: "max_tokens",
    };
    h.fake.reply(cut, json({ candidates: [] }), cut);
    await h.sync();
    const ex = sent(h, "extract");
    expect(ex).toHaveLength(3);
    expect(messageText(ex[0] as never)).toContain(a.ref);
    expect(messageText(ex[0] as never)).toContain(b.ref);
    expect(messageText(ex[1] as never)).not.toContain(b.ref);
    expect(messageText(ex[2] as never)).toContain(b.ref);
    const w = h.wiki();
    expect(all(w, "SELECT state, attempts, last_error FROM sources ORDER BY turn_rowid")).toEqual([
      { state: "extracted", attempts: 0, last_error: null },
      { state: "pending", attempts: 1, last_error: "truncated" },
    ]);
    expect(all(w, "SELECT kind, state, reason FROM turns ORDER BY rowid")).toEqual([
      { kind: "extract", state: "failed", reason: "split" },
      { kind: "extract", state: "completed", reason: null },
      { kind: "extract", state: "failed", reason: "truncated" },
    ]);
  });
});

describe("consolidation", () => {
  test("a new page; a second sync keeps the first one's entries and sources", async () => {
    const h = await harness();
    const t1 = await onePage(h);
    const first = h.page("people/wang-xiaoming");
    expect(first).toContain(`- [i1] 搬到台中西屯。 [[source:${t1.ref}]]`);
    expect(h.io.stdout).toContain("寫入 people/wang-xiaoming（新增 1、更新 0）");
    const t2 = h.turn({ owner: "王小明的生日是三月九日" });
    h.fake.reply(
      extracted({ source: t2.ref, quote: "生日是三月九日", text: "生日是 3 月 9 日。" }),
      json(keepAll([{ from: ["c2"], text: "生日是 3 月 9 日。" }])),
    );
    await h.sync();
    const second = h.page("people/wang-xiaoming");
    expect(second).toContain(`- [i1] 搬到台中西屯。 [[source:${t1.ref}]]`);
    expect(second).toContain(`- [i2] 生日是 3 月 9 日。 [[source:${t2.ref}]]`);
    expect(readFileSync(h.paths.wikiIndex, "utf8")).toContain(
      "- [[people/wang-xiaoming]] 王小明｜｜",
    );
  });

  const cuj5: [string, (ref: string, old: string) => unknown, string][] = [
    [
      "an entry that does not exist",
      () => ({
        summary: { keep: true },
        facts: [{ op: "update", id: "i9", text: "x", from: ["c2"] }],
        open: [],
      }),
      "bad_id",
    ],
    [
      "a summary rewrite that loses an old source",
      () => ({
        summary: { keep: false, text: "新摘要。", reason: "r", from: ["c2"] },
        facts: [],
        open: [],
      }),
      "source_lost",
    ],
    [
      "a summary citing a turn that does not exist",
      (_, old) => ({
        summary: {
          keep: false,
          text: `摘要。 [[source:${old}]] [[source:deadbeef/deadbeef]]`,
          reason: "r",
          from: ["c2"],
        },
        facts: [],
        open: [],
      }),
      "source_lost",
    ],
    [
      "a candidate with nowhere to go",
      () => ({ summary: { keep: true }, facts: [], open: [] }),
      "bad_from",
    ],
    [
      "one candidate in two operations",
      () => ({
        summary: { keep: true },
        facts: [
          { op: "add", text: "a", from: ["c2"] },
          { op: "add", text: "b", from: ["c2"] },
        ],
        open: [],
      }),
      "bad_from",
    ],
    [
      "a dropped candidate also in a from",
      () => ({
        summary: { keep: true },
        facts: [{ op: "add", text: "a", from: ["c2"] }],
        open: [],
        dropped: [{ candidate: "c2", reason: "dup" }],
      }),
      "bad_from",
    ],
  ];
  test.each(cuj5)(
    "%s: the file stays byte for byte, the candidate's attempts go up",
    async (_, patch, reason) => {
      const h = await harness();
      const t1 = h.turn({ owner: OWNER });
      h.fake.reply(
        extracted({ source: t1.ref, quote: "搬到台中西屯" }),
        json({
          summary: {
            keep: false,
            text: `在台中。 [[source:${t1.ref}]]`,
            reason: "第一次",
            from: ["c1"],
          },
          facts: [{ op: "add", text: "搬到台中西屯。", from: ["c1"] }],
          open: [],
        }),
      );
      await h.sync();
      const before = h.page("people/wang-xiaoming");
      const t2 = h.turn({ owner: "王小明的生日是三月九日" });
      h.fake.reply(
        extracted({ source: t2.ref, quote: "生日是三月九日" }),
        json(patch(t2.ref, t1.ref)),
      );
      await h.sync();
      expect(h.page("people/wang-xiaoming")).toBe(before);
      expect(
        one(h.wiki(), "SELECT state, attempts, last_error FROM candidates WHERE id = 2"),
      ).toEqual({
        state: "pending",
        attempts: 1,
        last_error: reason,
      });
      expect(h.io.stdout.some((l) => l.startsWith("跳過 people/wang-xiaoming：修改不合格"))).toBe(
        true,
      );
    },
  );

  test("an assistant-only batch with a facts merge: the file stays, attempts go up", async () => {
    const h = await harness();
    const t1 = h.turn({ owner: "王小明喜歡茶，也喜歡咖啡" });
    h.fake.reply(
      extracted(
        { source: t1.ref, quote: "王小明喜歡茶", text: "喜歡茶。" },
        { source: t1.ref, quote: "也喜歡咖啡", text: "喜歡咖啡。" },
      ),
      json(
        keepAll([
          { from: ["c1"], text: "喜歡茶。" },
          { from: ["c2"], text: "喜歡咖啡。" },
        ]),
      ),
    );
    await h.sync();
    const before = h.page("people/wang-xiaoming");
    const t2 = h.turn({ owner: "x", assistant: ["他可能會升職"] });
    h.fake.reply(
      extracted({ source: t2.ref, quote: "他可能會升職", speaker: "assistant", section: "open" }),
      json({
        summary: { keep: true },
        facts: [{ op: "merge", ids: ["i1", "i2"], text: "擁有者犯了詐欺。", from: ["c3"] }],
        open: [{ op: "add", text: "可能升職。", from: ["c3"] }],
      }),
    );
    await h.sync();
    expect(h.page("people/wang-xiaoming")).toBe(before);
    expect(
      one(h.wiki(), "SELECT state, attempts, last_error FROM candidates WHERE id = 3"),
    ).toEqual({ state: "pending", attempts: 1, last_error: "assistant_only" });
  });

  test("one candidate in an add and in the summary rewrite's from passes", async () => {
    const h = await harness();
    const t = h.turn({ owner: OWNER });
    h.fake.reply(
      extracted({ source: t.ref, quote: "搬到台中西屯" }),
      json({
        summary: {
          keep: false,
          text: `住台中。 [[source:${t.ref}]]`,
          reason: "第一次整理",
          from: ["c1"],
        },
        facts: [{ op: "add", text: "搬到台中西屯。", from: ["c1"] }],
        open: [],
      }),
    );
    await h.sync();
    expect(h.page("people/wang-xiaoming")).toContain(`住台中。 [[source:${t.ref}]]`);
  });

  test("everything dropped: no file, the candidates dropped with the model's reason", async () => {
    const h = await harness();
    const t = h.turn({ owner: OWNER });
    h.fake.reply(
      extracted({ source: t.ref, quote: "搬到台中西屯" }),
      json({
        summary: { keep: true },
        facts: [],
        open: [],
        dropped: [{ candidate: "c1", reason: "太模糊" }],
      }),
    );
    await h.sync();
    expect(existsSync(join(h.paths.wiki, "people/wang-xiaoming.md"))).toBe(false);
    expect(one(h.wiki(), "SELECT state, last_error FROM candidates")).toEqual({
      state: "dropped",
      last_error: "太模糊",
    });
  });

  test("45 candidates go in three batches, a turn's never split; a failed first batch stops the page", async () => {
    const h = await harness();
    const turns = Array.from({ length: 15 }, (_, i) =>
      h.turn({ owner: `第 ${i} 件事情的原文內容` }),
    );
    h.fake.reply(
      json({
        candidates: turns.flatMap((t, i) =>
          [0, 1, 2].map((k) =>
            candidate({ source: t.ref, quote: `第 ${i} 件事情`, text: `事情 ${i}-${k}。` }),
          ),
        ),
      }),
      text("not json"),
    );
    await h.sync();
    const con = sent(h, "consolidate");
    expect(con).toHaveLength(1);
    const keys = [...messageText(con[0] as never).matchAll(/\[c(\d+)\]/g)].map((m) => Number(m[1]));
    expect(keys).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    const w = h.wiki();
    expect(one(w, "SELECT COUNT(*) AS n FROM candidates WHERE attempts = 1")).toEqual({ n: 18 });
    expect(one(w, "SELECT COUNT(*) AS n FROM candidates WHERE attempts = 0")).toEqual({ n: 27 });
  });
});

describe("requests", () => {
  test("no tools, thinking off, no cache writes, the full 8192 output", async () => {
    const h = await harness();
    h.turn({ owner: OWNER });
    await h.sync();
    const body = sent(h, "extract")[0]?.body as Record<string, unknown>;
    expect(body.tools ?? []).toEqual([]);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(8192);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("budget", () => {
  test("sync's daily cap stops the run with exit 0; the next day goes on and sends no source twice", async () => {
    // Each extraction reserves about 0.125 USD; a reply costing 0.075 leaves too little.
    const h = await harness({ config: wikiConfig(0.2) });
    const turns = Array.from({ length: 21 }, (_, i) => h.turn({ owner: `第 ${i} 個回合` }));
    h.fake.reply({ ...json({ candidates: [] }), usage: { output: 5000 } } as FakeReply);
    expect(await h.sync()).toEqual({ state: "stopped", reason: "wiki_daily_cap" });
    expect(h.io.stdout).toContain("停下：同步今日上限已到");
    expect(one(h.wiki(), "SELECT state, stop_reason FROM runs")).toEqual({
      state: "stopped",
      stop_reason: "wiki_daily_cap",
    });
    expect(sent(h, "extract")).toHaveLength(1);
    h.clock.advance(24 * 60 * 60_000);
    expect(await h.sync()).toEqual({ state: "completed" });
    const ex = sent(h, "extract");
    expect(ex).toHaveLength(2);
    for (const t of turns) expect(ex.filter((m) => messageText(m).includes(t.ref))).toHaveLength(1);
  });

  test("the provider's stop line counts agent.db's spend", async () => {
    const h = await harness();
    h.turn({ owner: OWNER });
    adjust(h.db, "anthropic", 95, undefined, h.clock.now());
    h.clock.advance(1);
    expect(await h.sync()).toEqual({ state: "stopped", reason: "budget_stopped" });
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("an input too large for the model is too_large for that turn, not a stop", async () => {
    const h = await harness({ model: { contextWindow: 3000 } });
    h.turn({ owner: "長".repeat(1300) });
    expect(await h.sync()).toEqual({ state: "completed" });
    expect(one(h.wiki(), "SELECT attempts, last_error FROM sources")).toEqual({
      attempts: 1,
      last_error: "too_large",
    });
  });
});

describe("recovery", () => {
  test("killed between the file and the transaction: no entry twice, the candidate applied, no request", async () => {
    const h = await harness();
    await onePage(h);
    const t2 = h.turn({ owner: "王小明的生日是三月九日" });
    h.fake.reply(
      extracted({ source: t2.ref, quote: "生日是三月九日", text: "生日是 3 月 9 日。" }),
      json(keepAll([{ from: ["c2"], text: "生日是 3 月 9 日。" }])),
    );
    const w = await openWikiDb(h.paths);
    opened.push(w);
    const old = one<{ hash: string; next_item: number }>(w, "SELECT hash, next_item FROM pages");
    await h.sync();
    const written = h.page("people/wang-xiaoming");
    // The state a death right after writeFileAtomic leaves: the file new, wiki.db as before.
    w.run("UPDATE pages SET hash = ?, next_item = ?", [old.hash, old.next_item]);
    w.run("UPDATE candidates SET state = 'pending' WHERE id = 2");
    const requests = h.fake.messages().length;
    await h.sync();
    expect(h.fake.messages()).toHaveLength(requests);
    expect(one(w, "SELECT state FROM candidates WHERE id = 2")).toEqual({ state: "applied" });
    const after = h.page("people/wang-xiaoming");
    expect(after.match(/生日是 3 月 9 日/g)).toHaveLength(1);
    expect(after).toBe(written);
  });

  test("killed before the file: the next run does the work as usual", async () => {
    const h = await harness();
    await onePage(h);
    const w = await openWikiDb(h.paths);
    opened.push(w);
    w.run("UPDATE candidates SET state = 'pending'");
    // As if the first write never happened: no file, no pages row.
    rmSync(join(h.paths.wiki, "people/wang-xiaoming.md"));
    w.run("DELETE FROM pages");
    h.fake.reply(json(keepAll([{ from: ["c1"] }])));
    await h.sync();
    expect(h.page("people/wang-xiaoming")).toContain("- [i1] 搬到台中西屯。");
    expect(one(w, "SELECT state FROM candidates")).toEqual({ state: "applied" });
  });
});

describe("the owner's edits", () => {
  test("an edited entry and an unnumbered line are kept; the line gets its number on the next write", async () => {
    const h = await harness();
    await onePage(h);
    const edited = h
      .page("people/wang-xiaoming")
      .replace("搬到台中西屯。", "搬到台中西屯區。")
      .replace("## 未決", "- 喜歡爬山\n## 未決");
    h.writePage("people/wang-xiaoming", edited);
    const t2 = h.turn({ owner: "王小明的生日是三月九日" });
    h.fake.reply(
      extracted({ source: t2.ref, quote: "生日是三月九日", text: "生日是 3 月 9 日。" }),
      json(keepAll([{ from: ["c2"], text: "生日是 3 月 9 日。" }])),
    );
    await h.sync();
    const page = h.page("people/wang-xiaoming");
    expect(page).toContain("- [i1] 搬到台中西屯區。");
    expect(page).toContain("- [i2] 喜歡爬山");
    expect(page).toContain("- [i3] 生日是 3 月 9 日。");
    expect(page).toContain("檔案在同步之外有變動，以檔案為準。");
  });

  test("an unknown section blocks the page; its candidates wait without a try counted", async () => {
    const h = await harness();
    await onePage(h);
    h.writePage("people/wang-xiaoming", `${h.page("people/wang-xiaoming")}## 筆記\n自己寫的\n`);
    const t2 = h.turn({ owner: "王小明的生日是三月九日" });
    h.fake.reply(extracted({ source: t2.ref, quote: "生日是三月九日" }));
    await h.sync();
    const w = h.wiki();
    expect(one(w, "SELECT state, last_error FROM pages")).toEqual({
      state: "blocked",
      last_error: "多出不認得的區段「筆記」",
    });
    expect(one(w, "SELECT state, attempts FROM candidates WHERE id = 2")).toEqual({
      state: "pending",
      attempts: 0,
    });
    expect(sent(h, "consolidate")).toHaveLength(1);
  });
});

describe("stopping", () => {
  test("aborted mid-request: usage estimated, the run aborted; a leftover running job becomes interrupted", async () => {
    const h = await harness();
    h.turn({ owner: OWNER });
    h.fake.reply({ kind: "hang" });
    const controller = new AbortController();
    const run = h.sync({}, controller.signal);
    while (h.fake.messages().length === 0) await Bun.sleep(5);
    controller.abort();
    expect(await run).toEqual({ state: "aborted" });
    const w = await openWikiDb(h.paths);
    opened.push(w);
    expect(one(w, "SELECT state FROM usage")).toEqual({ state: "estimated" });
    expect(one(w, "SELECT state FROM runs")).toEqual({ state: "aborted" });
    expect(one(w, "SELECT state FROM turns")).toEqual({ state: "aborted" });

    w.run("UPDATE turns SET state = 'running'");
    w.run("UPDATE runs SET state = 'running'");
    await h.sync();
    expect(all(w, "SELECT state FROM turns ORDER BY rowid")[0]).toEqual({ state: "interrupted" });
    expect(all(w, "SELECT state FROM runs ORDER BY rowid")[0]).toEqual({ state: "interrupted" });
  });
});

describe("refusals", () => {
  test("inside a tars session: refused before wiki.db or the directory exists", async () => {
    const h = await harness();
    const deps: SyncDeps = {
      paths: h.paths,
      env: { ...h.env, TARS_IN_SESSION: "1" },
      secrets: h.secrets,
      adapterFor,
      now: () => h.clock.now(),
      sleep: async () => {},
      io: captureIo(),
    };
    await expect(runSync(deps, {}, new AbortController().signal)).rejects.toThrow(
      "只能在你自己的終端執行",
    );
    expect(existsSync(h.paths.wikiDb)).toBe(false);
    expect(existsSync(h.paths.wiki)).toBe(false);
  });

  test("<data>/wiki as a symlink is refused", async () => {
    const h = await harness();
    const real = join(h.paths.data, "elsewhere");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, h.paths.wiki);
    await expect(h.sync()).rejects.toThrow("symlink");
  });
});
