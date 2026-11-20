import { afterEach, describe, expect, test } from "bun:test";
import { adapterFor } from "../../../src/features/agent/provider.ts";
import { openWikiDb } from "../../../src/features/wiki/db.ts";
import { sourceRef } from "../../../src/features/wiki/evidence.ts";
import { run } from "../../../src/main.ts";
import { text } from "../../fakes/anthropic.ts";
import { testDeps } from "../../helpers.ts";
import { engineHarness, type EngineHarness } from "../agent/engine-fixture.ts";
import { chatTurn } from "./wiki-fixture.ts";

const harnesses: EngineHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
});

async function setup() {
  const h = await engineHarness();
  harnesses.push(h);
  const deps = () =>
    testDeps({ env: h.env, secrets: h.secrets, adapterFor, now: () => h.clock.now() });
  return { h, deps };
}

const json = (v: unknown) => text(JSON.stringify(v));

describe("tars wiki sync", () => {
  test("prints each page written and the summary", async () => {
    const { h, deps } = await setup();
    const t = chatTurn(h.db, { owner: "王小明上個月搬到台中西屯了", now: h.clock.now() });
    const ref = sourceRef(t.convId, t.turnId);
    h.fake.reply(
      json({
        candidates: [
          {
            source: ref,
            page: "people/wang-xiaoming",
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
    const d = deps();
    expect(await run(["wiki", "sync"], d)).toBe(0);
    expect(d.io.stdout).toEqual([
      "寫入 people/wang-xiaoming（新增 1、更新 0）",
      "掃描：新的回合 1，進索引的訊息 1，變動的頁面 0",
      "抽取：送出 1 批，候選 1，退回 0",
      "整併：寫入 1 頁，不合格 0 頁",
      expect.stringMatching(
        /^花費：\d+\.\d+ USD（今日 \d+\.\d+ \/ 1\.00，本月 \d+\.\d+ \/ 10\.00）$/,
      ),
      "還沒做：來源回合 0，候選 0",
    ]);
  });
});

describe("tars wiki status", () => {
  test("before any sync", async () => {
    const { deps } = await setup();
    const d = deps();
    expect(await run(["wiki", "status"], d)).toBe(0);
    expect(d.io.stdout).toEqual(["還沒有同步過"]);
  });

  test("every line", async () => {
    const { h, deps } = await setup();
    const t = chatTurn(h.db, { owner: "說了一件事", now: h.clock.now() });
    chatTurn(h.db, { owner: "還在跑", state: "running", now: h.clock.now() });
    h.fake.reply(text("not json"), text("not json"), text("not json"));
    for (let i = 0; i < 3; i++) expect(await run(["wiki", "sync"], deps())).toBe(0);
    chatTurn(h.db, { owner: "同步之後才有的", now: h.clock.now() });
    const w = await openWikiDb(h.paths);
    w.run(
      `INSERT INTO pages (path, title, aliases, created, updated, hash, next_item, state, last_error)
       VALUES ('people/chen-dawen', '陳大文', '[]', '2026-11-01', '2026-11-01', 'h', 1, 'blocked', '多出不認得的區段「筆記」')`,
    );
    w.close();
    const d = deps();
    expect(await run(["wiki", "status"], d)).toBe(0);
    expect(d.io.stdout).toEqual([
      "頁面：people 1、projects 0、topics 0、life 0、learning 0、investment 0",
      "頁面索引到 2026-11-19T12:00Z；原始紀錄索引到 2026-11-19T12:00Z，之後有 2 個回合還沒進索引",
      "待抽取的回合：0；待整併的候選：0；等待中的回合（還在執行）：1",
      "失敗：來源回合 1、候選 0",
      `  ${sourceRef(t.convId, t.turnId)}：回應不是 JSON（3 次）`,
      "解析不了的頁面：1",
      "  people/chen-dawen：多出不認得的區段「筆記」",
      "內容被裁掉中段的回合：0",
      "上次同步：2026-11-19T12:00Z，completed",
      expect.stringMatching(/^同步的花費：今日 \d+\.\d+ \/ 1\.00，本月 \d+\.\d+ \/ 10\.00 USD$/),
    ]);
  });

  test("a wiki.db from a newer tars: exit 1", async () => {
    const { h, deps } = await setup();
    const w = await openWikiDb(h.paths);
    w.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    w.close();
    const d = deps();
    expect(await run(["wiki", "status"], d)).toBe(1);
    expect(d.io.stderr.join("\n")).toContain("較新的 tars");
  });
});

/** One synced page and its source turn, with a tool call whose result must never print. */
async function synced() {
  const { h, deps } = await setup();
  const t = chatTurn(h.db, {
    owner: "王小明上個月搬到台中西屯了",
    assistant: ["記下了"],
    tools: [
      { name: "tars", argv: ["script", "run", "weather"], status: "done", result: "RESULT-TEXT" },
    ],
    now: h.clock.now(),
  });
  const ref = sourceRef(t.convId, t.turnId);
  h.fake.reply(
    json({
      candidates: [
        {
          source: ref,
          page: "people/wang-xiaoming",
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
  expect(await run(["wiki", "sync"], deps())).toBe(0);
  return { h, deps, t, ref };
}

describe("tars wiki list", () => {
  test("text and --json; an unknown category is a usage error", async () => {
    const { deps } = await synced();
    const d = deps();
    expect(await run(["wiki", "list"], d)).toBe(0);
    expect(d.io.stdout).toEqual(["people/wang-xiaoming｜王小明｜｜2026-11-19"]);
    const j = deps();
    expect(await run(["wiki", "list", "people", "--json"], j)).toBe(0);
    expect(JSON.parse(j.io.stdout.join(""))).toEqual({
      counts: { people: 1, projects: 0, topics: 0, life: 0, learning: 0, investment: 0 },
      pages: [
        {
          path: "people/wang-xiaoming",
          title: "王小明",
          aliases: [],
          type: "people",
          created: "2026-11-19",
          updated: "2026-11-19",
          state: "ok",
        },
      ],
    });
    expect(await run(["wiki", "list", "notes"], deps())).toBe(2);
  });

  test("before any sync", async () => {
    const { deps } = await setup();
    const d = deps();
    expect(await run(["wiki", "list"], d)).toBe(0);
    expect(d.io.stdout).toEqual(["還沒有同步過"]);
  });
});

describe("tars wiki show", () => {
  test("text and --json; no such page is 1; a bad path is 2", async () => {
    const { deps, ref } = await synced();
    const d = deps();
    expect(await run(["wiki", "show", "people/wang-xiaoming"], d)).toBe(0);
    expect(d.io.stdout[0]).toBe("people/wang-xiaoming｜更新 2026-11-19");
    expect(d.io.stdout[1]).toBe("");
    expect(d.io.stdout[2]).toContain(`- [i1] 搬到台中西屯。 [[source:${ref}]]`);
    const j = deps();
    expect(await run(["wiki", "show", "people/wang-xiaoming", "--json"], j)).toBe(0);
    expect(JSON.parse(j.io.stdout.join(""))).toMatchObject({
      path: "people/wang-xiaoming",
      title: "王小明",
      type: "people",
      state: "ok",
      error: null,
      summary: { text: "", sources: [] },
      facts: [{ id: "i1", text: "搬到台中西屯。", sources: [ref] }],
      open: [],
      related: [],
    });
    expect(await run(["wiki", "show", "people/nobody"], deps())).toBe(1);
    expect(await run(["wiki", "show", "notes/x"], deps())).toBe(2);
  });
});

describe("tars wiki source", () => {
  test("text and --json, without the tool's result; an unknown turn is 1; a bad ref is 2", async () => {
    const { h, deps, t, ref } = await synced();
    const d = deps();
    expect(await run(["wiki", "source", ref], d)).toBe(0);
    expect(d.io.stdout).toEqual([
      `${ref}｜2026-11-19T12:00Z｜anthropic/model-a｜completed`,
      "擁有者：",
      "王小明上個月搬到台中西屯了",
      "tars：",
      "記下了",
      "工具：tars script run weather（done）",
    ]);
    expect(d.io.stdout.join("\n")).not.toContain("RESULT-TEXT");
    const j = deps();
    expect(await run(["wiki", "source", ref, "--json"], j)).toBe(0);
    expect(JSON.parse(j.io.stdout.join(""))).toEqual({
      source: ref,
      conv: t.convId,
      turn: t.turnId,
      startedAt: h.clock.now().getTime(),
      model: "anthropic/model-a",
      state: "completed",
      owner: "王小明上個月搬到台中西屯了",
      assistant: ["記下了"],
      tools: [{ name: "tars", argv: ["script", "run", "weather"], status: "done" }],
    });
    expect(await run(["wiki", "source", `${ref.slice(0, 8)}/ffffffff`], deps())).toBe(1);
    expect(await run(["wiki", "source", "nope"], deps())).toBe(2);
  });
});

describe("tars wiki search usage errors", () => {
  const also = (n: number) => Array.from({ length: n }, (_, i) => ["--also", `w${i}`]).flat();
  test.each([
    ["a date that does not exist", ["--since", "2026-02-30"]],
    ["--since after --until", ["--since", "2026-11-02", "--until", "2026-11-01"]],
    ["a seventh --also", also(7)],
    ["--also -x", ["--also", "-x"]],
  ])("%s", async (_, extra) => {
    const { deps } = await setup();
    expect(await run(["wiki", "search", "q", ...extra], deps())).toBe(2);
  });
});
