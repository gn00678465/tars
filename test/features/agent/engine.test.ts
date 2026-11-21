import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine, TurnOutcome } from "../../../src/features/agent/engine.ts";
import { estimateTokens, utf8Bytes } from "../../../src/features/agent/bytes.ts";
import { adjust } from "../../../src/features/agent/ledger.ts";
import { E2E_BASE_URL_VARS } from "../../../src/features/agent/provider.ts";
import { REFUSAL_TEXT } from "../../../src/features/agent/tars-tool.ts";
import { reconcile } from "../../../src/features/agent/reconcile.ts";
import {
  appendItems,
  beginTurn,
  createConversation,
  newId,
  readItems,
} from "../../../src/features/agent/store.ts";
import type { Effort, Item } from "../../../src/features/agent/types.ts";
import { tarsCall, text, toolUse, type FakeBlock, type FakeReply } from "../../fakes/anthropic.ts";
import { compatText, type FakeCompatReply } from "../../fakes/openai-compat.ts";
import { openDb } from "../../../src/features/agent/db.ts";
import {
  compatHarness,
  enableCompat,
  GEMINI_ENTRY,
  OPENROUTER_ENTRY,
  type CompatHarness,
} from "./compat-fixture.ts";
import { tempHome, TEST_NOW } from "../../helpers.ts";
import { installSample, sampleScript } from "../script/sample.ts";
import { writeWikiIndex } from "../wiki/wiki-fixture.ts";
import {
  configWith,
  engineHarness,
  historyProblems,
  MODEL_ENTRY,
  MODEL_ID,
  writeCatalog,
  type EngineHarness,
  type HarnessOptions,
} from "./engine-fixture.ts";

const harnesses: EngineHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
});

async function harness(opts: HarnessOptions = {}): Promise<EngineHarness> {
  const h = await engineHarness(opts);
  harnesses.push(h);
  return h;
}

interface TurnOpts {
  convId?: string;
  effort?: Effort;
  signal?: AbortSignal;
  engine?: Engine;
}

const runTurn = (h: EngineHarness, message: string, o: TurnOpts = {}) =>
  (o.engine ?? h.engine).runTurn(
    {
      provider: "anthropic",
      model: MODEL_ID,
      effort: o.effort ?? "medium",
      text: message,
      ...(o.convId === undefined ? {} : { convId: o.convId }),
    },
    h.frontend,
    o.signal ?? new AbortController().signal,
  );

function ended(out: TurnOutcome) {
  if (out.kind !== "ended") throw new Error(`expected an ended turn, got ${JSON.stringify(out)}`);
  return out;
}

const TABLES = ["conversations", "turns", "items", "usage", "tool_calls", "approvals"] as const;
const counts = (db: Database) =>
  Object.fromEntries(
    TABLES.map((t) => [t, (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );

const rows = <T>(db: Database, sql: string, ...params: string[]) =>
  db.query(sql).all(...params) as T[];

interface Block {
  type: string;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}
type Message = { role: string; content: Block[] };

const lastMessages = (h: EngineHarness) => h.fake.messages().at(-1)?.body.messages as Message[];

const toolResults = (h: EngineHarness, convId: string) =>
  readItems(h.db, convId).flatMap((i) => (i.kind === "tool_result" ? [i.body] : []));

/** Sends one more message and checks the request built from what the last ending left. */
async function expectNextTurnValid(h: EngineHarness, convId: string, engine?: Engine) {
  h.fake.reply(text("next"));
  const out = ended(await runTurn(h, "繼續", { convId, ...(engine ? { engine } : {}) }));
  expect(out.state).toBe("completed");
  const messages = lastMessages(h);
  expect(historyProblems(messages)).toEqual([]);
  const ids = messages.flatMap((m) =>
    m.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
  );
  expect(new Set(ids).size).toBe(ids.length);
}

// --- Scripts in the library and a stand-in for the child tars.

const scriptLines = (name: string, effects: string, domains: string) => [
  `name = "${name}"`,
  'summary = "查天氣"',
  `domains = ${domains}`,
  `effects = "${effects}"`,
  'args = "--city <名稱>"',
  'outputs = "一行 JSON"',
  'exit = { 0 = "成功" }',
];

const VERSION = "0123456789abcdef";

function addScript(
  h: EngineHarness,
  name: string,
  effects: string,
  domains = '["api.example.com"]',
) {
  return installSample(
    h.paths.scripts,
    name,
    sampleScript({ name, tarsLines: scriptLines(name, effects, domains) }),
    VERSION,
  );
}

/** Points the script's current at a new version, as approving an update does. */
function replaceVersion(dir: string, name: string, version: string) {
  mkdirSync(join(dir, "versions", version), { recursive: true });
  writeFileSync(
    join(dir, "versions", version, "script.py"),
    sampleScript({ name, tarsLines: scriptLines(name, "external-write", '["api.example.com"]') }),
  );
  unlinkSync(join(dir, "current"));
  symlinkSync(join("versions", version), join(dir, "current"));
}

/** An executable standing in for tars; `body` is sh. */
function fakeTars(body: string): string {
  const path = join(tempHome(), "fake-tars");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

const RAN = fakeTars('echo "ran $*"');
const runArgv = (name: string) => ["script", "run", name, "--", "--city", "Taipei"];

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

const turnRow = (db: Database, id: string) =>
  db.query("SELECT * FROM turns WHERE id = ?").get(id) as {
    state: string;
    reason: string | null;
    requests: number;
    cost_usd: number;
    effort: string | null;
  };

const usageRows = (db: Database, turnId: string) =>
  rows<{ state: string; cost_usd: number; cost_source: string }>(
    db,
    "SELECT state, cost_usd, cost_source FROM usage WHERE turn_id = ? ORDER BY id",
    turnId,
  );

const httpError = (status: number, type: string, extra = {}): FakeReply => ({
  kind: "http_error",
  status,
  type,
  ...extra,
});
const overloaded = httpError(529, "overloaded_error");

// ---------------------------------------------------------------------------------------------

describe("critical user journeys", () => {
  test("CUJ 2: skill_load and file_read, the reply streams, the turn sums usage", async () => {
    const h = await harness();
    mkdirSync(join(h.paths.skills, "tars-mode", "playbooks"), { recursive: true });
    writeFileSync(
      join(h.paths.skills, "tars-mode", "SKILL.md"),
      "---\nname: tars-mode\ndescription: 路由\n---\n路由表\n",
    );
    writeFileSync(join(h.paths.skills, "tars-mode", "playbooks", "weekly.md"), "整理一週\n");
    h.fake.reply(
      toolUse("tu1", "skill_load", { name: "tars-mode" }),
      toolUse("tu2", "file_read", { path: "tars-mode/playbooks/weekly.md" }),
      text("這週的工作整理如下"),
    );
    const out = ended(await runTurn(h, "hey tars 我想整理一下這週的工作"));
    expect(out.state).toBe("completed");
    const results = toolResults(h, out.convId);
    expect(results.map((r) => r.status)).toEqual(["done", "done"]);
    expect(results[0]?.text).toContain("路由表");
    expect(results[1]?.text).toContain("整理一週");
    const deltas = h.frontend.events.flatMap((e) => (e.type === "delta" ? [e.text] : []));
    expect(deltas.join("")).toBe("這週的工作整理如下");
    const end = h.frontend.events.at(-1);
    if (end?.type !== "turn_end") throw new Error("last event is not turn_end");
    expect(end.requests).toBe(3);
    expect(end.usage.outputTokens).toBe(30);
    expect(end.usage.uncachedInputTokens).toBe(300);
    expect(end.costUsd).toBeCloseTo(turnRow(h.db, out.turnId).cost_usd, 12);
    expect(historyProblems(lastMessages(h))).toEqual([]);
  });

  test("CUJ 3: a read-only script with one exact host runs without approval", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "weather", "read-only");
    h.fake.reply(tarsCall("tu1", runArgv("weather")), text("晴天"));
    const out = ended(await runTurn(h, "台北天氣"));
    expect(out.state).toBe("completed");
    expect(h.frontend.approvals).toEqual([]);
    const [result] = toolResults(h, out.convId);
    expect(result?.status).toBe("done");
    expect(result?.text).toContain(
      `ran script run weather --expect-version ${VERSION} --timeout 120 -- --city Taipei`,
    );
    expect(counts(h.db).approvals).toBe(0);
  });

  test("CUJ 4: an external-write script asks; approved, it runs", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "push", "external-write");
    h.frontend.answer = async () => "approved";
    h.fake.reply(tarsCall("tu1", runArgv("push")), text("送出了"));
    const out = ended(await runTurn(h, "推播"));
    expect(out.state).toBe("completed");
    const [approval] = h.frontend.approvals;
    expect(approval?.fields.argv).toEqual([
      "script",
      "run",
      "push",
      "--expect-version",
      VERSION,
      "--timeout",
      "120",
      "--",
      "--city",
      "Taipei",
    ]);
    expect(approval?.expiresAt).toBe(TEST_NOW + 600_000);
    expect(rows<{ state: string }>(h.db, "SELECT state FROM approvals")).toEqual([
      { state: "approved" },
    ]);
    expect(toolResults(h, out.convId)[0]?.status).toBe("done");
  });

  test("CUJ 4: denied, the call is denied and the rest of the step skipped", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "push", "external-write");
    h.fake.reply(
      {
        kind: "message",
        blocks: [
          { type: "tool_use", id: "tu1", name: "tars", input: { argv: runArgv("push") } },
          { type: "tool_use", id: "tu2", name: "tars", input: { argv: ["script", "list"] } },
        ],
      },
      text("好，不送"),
    );
    const out = ended(await runTurn(h, "推播"));
    expect(out.state).toBe("completed");
    expect(toolResults(h, out.convId).map((r) => r.status)).toEqual(["denied", "skipped"]);
    expect(toolResults(h, out.convId)[1]?.text).toBe("前一個動作沒有執行，這個已略過");
    expect(rows<{ state: string }>(h.db, "SELECT state FROM approvals")).toEqual([
      { state: "denied" },
    ]);
    await expectNextTurnValid(h, out.convId);
  });

  test("CUJ 5: a command off the whitelist is refused with the fixed text", async () => {
    const h = await harness();
    h.fake.reply(tarsCall("tu1", ["memory", "remember", "x"]), text("好"));
    const out = ended(await runTurn(h, "記住"));
    const [result] = toolResults(h, out.convId);
    expect(result?.status).toBe("refused");
    expect(result?.text.startsWith(REFUSAL_TEXT)).toBe(true);
    expect(h.frontend.notices()).toContain("blocked");
  });

  test("CUJ 6: a quota at the stop line refuses the message and writes nothing", async () => {
    const h = await harness();
    adjust(h.db, "anthropic", 94.99, undefined, h.clock.now());
    const before = counts(h.db);
    const out = await runTurn(h, "hi");
    expect(out).toMatchObject({ kind: "rejected", reason: "budget_stopped" });
    expect(counts(h.db)).toEqual(before);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("CUJ 7a: aborting a running child interrupts it and aborts the turn", async () => {
    const mark = join(tempHome(), "started");
    const h = await harness({ selfCommand: [fakeTars(`echo x > ${mark}\nexec sleep 30`)] });
    addScript(h, "weather", "read-only");
    h.fake.reply(tarsCall("tu1", runArgv("weather")));
    const controller = new AbortController();
    const pending = runTurn(h, "台北天氣", { signal: controller.signal });
    await until(() => existsSync(mark));
    controller.abort();
    const out = ended(await pending);
    expect(out.state).toBe("aborted");
    const [result] = toolResults(h, out.convId);
    expect(result).toMatchObject({ status: "interrupted", text: "中斷，結果不明" });
    expect(rows<{ state: string }>(h.db, "SELECT state FROM tool_calls")).toEqual([
      { state: "interrupted" },
    ]);
    expect(h.fake.messages()).toHaveLength(1);
    await expectNextTurnValid(h, out.convId);
  });

  test("CUJ 7b: after reconcile a turn left running can be followed by another", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "push", "external-write");
    // The approval is never answered: the process "dies" while it waits.
    h.frontend.answer = () => new Promise(() => {});
    h.fake.reply(tarsCall("tu1", runArgv("push")));
    void runTurn(h, "推播");
    await until(() => h.frontend.approvals.length === 1);
    const report = reconcile(h.db, h.clock.now());
    expect(report).toMatchObject({ approvals: 1, toolCalls: 1, turns: 1 });
    const convId = (h.db.query("SELECT id FROM conversations").get() as { id: string }).id;
    expect(toolResults(h, convId).map((r) => r.status)).toEqual(["expired"]);
    await expectNextTurnValid(h, convId, h.restart());
  });

  test("CUJ 8: a model retired between turns refuses the message; fixed, it goes on", async () => {
    const h = await harness();
    h.fake.reply(text("一"));
    const first = ended(await runTurn(h, "hi"));
    writeCatalog(h.paths, [{ ...MODEL_ENTRY, status: "retired", default: false }]);
    const before = counts(h.db);
    const out = await runTurn(h, "again", { convId: first.convId });
    expect(out).toMatchObject({ kind: "rejected", reason: "unknown_model" });
    expect(counts(h.db)).toEqual(before);
    writeCatalog(h.paths, [MODEL_ENTRY]);
    h.fake.reply(text("二"));
    expect(ended(await runTurn(h, "again", { convId: first.convId })).state).toBe("completed");
  });

  test("CUJ 8: prices past 90 days refuse; past 30 days warn", async () => {
    const h = await harness({ model: { pricedAt: "2026-08-01" } });
    expect(await runTurn(h, "hi")).toMatchObject({ kind: "rejected", reason: "prices_stale" });
    writeCatalog(h.paths, [{ ...MODEL_ENTRY, pricedAt: "2026-10-01" }]);
    h.fake.reply(text("ok"));
    ended(await runTurn(h, "hi"));
    const warn = h.frontend.events.find((e) => e.type === "notice" && e.code === "prices_warn");
    expect(warn).toMatchObject({ data: { days: 49 } });
  });

  test("CUJ 9: every request of a turn carries the conversation's level", async () => {
    const h = await harness();
    h.fake.reply(toolUse("tu1", "skill_load", { name: "demo" }), text("ok"));
    const out = ended(await runTurn(h, "hi"));
    const bodies = h.fake.messages().map((r) => r.body);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.output_config).toEqual({ effort: "medium" });
      expect(b.thinking).toEqual({ type: "adaptive" });
    }
    expect(turnRow(h.db, out.turnId).effort).toBe("medium");
  });
});

describe("rejections", () => {
  test("no key, a disabled provider and a broken config.toml leave no rows", async () => {
    const h = await harness();
    const before = counts(h.db);
    h.secrets.entries.delete("llm:anthropic");
    expect(await runTurn(h, "hi")).toMatchObject({ kind: "rejected", reason: "no_key" });
    h.secrets.entries.set("llm:anthropic", "sk-test");
    writeFileSync(h.paths.configFile, configWith({ enabled: false }));
    expect(await runTurn(h, "hi")).toMatchObject({
      kind: "rejected",
      reason: "provider_disabled",
    });
    writeFileSync(h.paths.configFile, "[limits\n");
    expect(await runTurn(h, "hi")).toMatchObject({ kind: "rejected", reason: "config_invalid" });
    expect(counts(h.db)).toEqual(before);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("an invalid models.json refuses the message and leaves no turn", async () => {
    const h = await harness();
    writeFileSync(h.paths.modelsFile, "{ not json");
    const before = counts(h.db);
    expect(await runTurn(h, "hi")).toMatchObject({ kind: "rejected", reason: "catalog_invalid" });
    expect(counts(h.db)).toEqual(before);
  });

  test("wiki sync's spend at the stop line refuses the message", async () => {
    const h = await harness();
    h.otherSpend = { period: 95, today: 0, rawToday: 0, rawMonth: 0 };
    expect(await runTurn(h, "hi")).toMatchObject({ kind: "rejected", reason: "budget_stopped" });
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("an unreadable wiki.db refuses the message before any turn exists", async () => {
    const h = await harness();
    const before = counts(h.db);
    h.otherSpend = undefined;
    expect(await runTurn(h, "hi")).toMatchObject({
      kind: "rejected",
      reason: "budget_unreadable",
    });
    expect(counts(h.db)).toEqual(before);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("wiki.db turning unreadable mid-turn ends the turn as failed, never left running", async () => {
    const h = await harness();
    const emit = h.frontend.emit;
    h.frontend.emit = (e) => {
      emit(e);
      if (e.type === "item" && e.item.kind === "tool_result") h.otherSpend = undefined;
    };
    h.fake.reply(toolUse("tu1", "skill_load", { name: "demo" }));
    const out = ended(await runTurn(h, "hi"));
    expect(out).toMatchObject({ state: "failed", reason: "budget_unreadable" });
    expect(rows(h.db, "SELECT state FROM turns")).toEqual([{ state: "failed" }]);
    expect(h.fake.messages()).toHaveLength(1);
  });

  test("a config edited between turns applies to the next one", async () => {
    const h = await harness();
    h.fake.reply(text("一"), text("二"));
    const first = ended(await runTurn(h, "hi"));
    expect(h.fake.messages()[0]?.body.max_tokens).toBe(16000);
    writeFileSync(h.paths.configFile, configWith({ max_output_tokens: 2000 }));
    ended(await runTurn(h, "again", { convId: first.convId }));
    expect(h.fake.messages()[1]?.body.max_tokens).toBe(2000);
  });
});

describe("retries and provider failures", () => {
  test("two overloads then success: three requests, the first two voided", async () => {
    const h = await harness();
    h.fake.reply(overloaded, overloaded, text("ok"));
    const out = ended(await runTurn(h, "hi"));
    expect(out.state).toBe("completed");
    expect(h.sleeps).toEqual([2000, 8000]);
    const turn = turnRow(h.db, out.turnId);
    expect(turn.requests).toBe(3);
    const usage = usageRows(h.db, out.turnId);
    expect(usage.map((u) => u.state)).toEqual(["voided", "voided", "final"]);
    expect(usage.slice(0, 2).every((u) => u.cost_usd === 0 && u.cost_source === "none")).toBe(true);
    expect(turn.cost_usd).toBeCloseTo(usage[2]?.cost_usd as number, 12);
    expect(h.frontend.notices().filter((n) => n === "retrying")).toHaveLength(2);
  });

  test("retries used up end as provider_error", async () => {
    const h = await harness();
    h.fake.reply(overloaded, overloaded, overloaded);
    const out = ended(await runTurn(h, "hi"));
    expect(out).toMatchObject({ state: "failed", reason: "provider_error" });
    expect(turnRow(h.db, out.turnId).requests).toBe(3);
    const error = readItems(h.db, out.convId).find((i) => i.kind === "error");
    expect(error?.body).toMatchObject({ code: "provider_error" });
    await expectNextTurnValid(h, out.convId);
  });

  test("a retry that would pass max_requests_per_turn ends as request_limit", async () => {
    const h = await harness({ config: configWith({ max_requests_per_turn: 2 }) });
    h.fake.reply(overloaded, overloaded);
    const out = ended(await runTurn(h, "hi"));
    expect(out).toMatchObject({ state: "failed", reason: "request_limit" });
    expect(turnRow(h.db, out.turnId).requests).toBe(2);
    await expectNextTurnValid(h, out.convId);
  });

  test("aborting during the wait before a retry aborts the turn", async () => {
    const h = await harness();
    const controller = new AbortController();
    const emit = h.frontend.emit;
    h.frontend.emit = (e) => {
      emit(e);
      if (e.type === "notice" && e.code === "retrying") controller.abort();
    };
    h.fake.reply(overloaded);
    const out = ended(await runTurn(h, "hi", { signal: controller.signal }));
    expect(out.state).toBe("aborted");
    expect(turnRow(h.db, out.turnId).requests).toBe(1);
    await expectNextTurnValid(h, out.convId);
  });

  test("retry-after is used, capped at 60 s", async () => {
    const h = await harness();
    h.fake.reply(httpError(429, "rate_limit_error", { retryAfter: "120" }), text("ok"));
    ended(await runTurn(h, "hi"));
    expect(h.sleeps).toEqual([60_000]);
  });

  test("a stream cut after text is stream_interrupted, with an incomplete item", async () => {
    const h = await harness();
    h.fake.reply({ kind: "disconnect", blocks: [{ type: "text", text: "一半的回" }] });
    const out = ended(await runTurn(h, "hi"));
    expect(out).toMatchObject({ state: "failed", reason: "stream_interrupted" });
    expect(h.sleeps).toEqual([]);
    const assistant = readItems(h.db, out.convId).find((i) => i.kind === "assistant");
    expect(assistant?.body).toEqual({ text: "一半的回", state: "incomplete", native: null });
    expect(usageRows(h.db, out.turnId).map((u) => u.state)).toEqual(["estimated"]);
    await expectNextTurnValid(h, out.convId);
  });

  test("an error event after text is stream_interrupted too", async () => {
    const h = await harness();
    h.fake.reply({
      kind: "stream_error",
      blocks: [{ type: "text", text: "部分" }],
      type: "overloaded_error",
    });
    const out = ended(await runTurn(h, "hi"));
    expect(out).toMatchObject({ state: "failed", reason: "stream_interrupted" });
    await expectNextTurnValid(h, out.convId);
  });

  test.each([
    ["auth", httpError(401, "authentication_error")],
    ["bad_request", httpError(400, "invalid_request_error", { message: "bad thing" })],
    [
      "provider_spend_limit",
      httpError(400, "invalid_request_error", { errorCode: "enforced_spend_limit_reached" }),
    ],
  ] as const)("%s is not retried, and the next turn is valid", async (reason, reply) => {
    const h = await harness();
    h.fake.reply(reply);
    const out = ended(await runTurn(h, "hi"));
    expect(out).toMatchObject({ state: "failed", reason });
    expect(h.sleeps).toEqual([]);
    expect(usageRows(h.db, out.turnId).map((u) => u.state)).toEqual(["voided"]);
    if (reason === "bad_request") {
      const end = h.frontend.events.findLast((e) => e.type === "turn_end");
      expect(end).toMatchObject({ detail: "bad thing" });
    }
    await expectNextTurnValid(h, out.convId);
  });

  test("aborting while the model answers aborts the turn with an estimated row", async () => {
    const h = await harness();
    h.fake.reply({ kind: "hang" });
    const controller = new AbortController();
    const pending = runTurn(h, "hi", { signal: controller.signal });
    await until(() => h.fake.messages().length === 1);
    await Bun.sleep(20);
    controller.abort();
    const out = ended(await pending);
    expect(out.state).toBe("aborted");
    expect(usageRows(h.db, out.turnId).map((u) => u.state)).toEqual(["estimated"]);
    expect(readItems(h.db, out.convId).some((i) => i.kind === "error")).toBe(false);
    await expectNextTurnValid(h, out.convId);
  });

  test("max_tokens with a tool_use block stores no tool call and replays none", async () => {
    const h = await harness();
    h.fake.reply({
      kind: "message",
      stop: "max_tokens",
      blocks: [
        { type: "text", text: "我來查" },
        { type: "tool_use", id: "tu1", name: "tars", input: { argv: ["script", "list"] } },
      ],
    });
    const out = ended(await runTurn(h, "hi"));
    expect(out.state).toBe("completed");
    expect(counts(h.db).tool_calls).toBe(0);
    const assistant = readItems(h.db, out.convId).find((i) => i.kind === "assistant");
    expect(assistant?.body).toMatchObject({ state: "truncated", text: "我來查" });
    await expectNextTurnValid(h, out.convId);
    const blocks = lastMessages(h).flatMap((m) => m.content);
    expect(blocks.some((b) => b.type === "tool_use")).toBe(false);
  });
});

describe("tools, approvals and the budget", () => {
  test("budget reached at a tars call: refused, the rest skipped, turn failed", async () => {
    const h = await harness();
    adjust(h.db, "anthropic", 94.5, undefined, h.clock.now());
    h.clock.advance(1);
    h.fake.reply({
      kind: "message",
      usage: { output: 40000 },
      blocks: [
        { type: "tool_use", id: "tu1", name: "skill_load", input: { name: "demo" } },
        { type: "tool_use", id: "tu2", name: "tars", input: { argv: ["script", "list"] } },
        { type: "tool_use", id: "tu3", name: "tars", input: { argv: ["cost"] } },
      ],
    });
    const out = ended(await runTurn(h, "hi"));
    expect(out).toMatchObject({ state: "failed", reason: "budget_stopped" });
    expect(toolResults(h, out.convId).map((r) => r.status)).toEqual(["done", "refused", "skipped"]);
    expect(h.fake.messages()).toHaveLength(1);
  });

  test("with the quota full no approval is created", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "push", "external-write");
    adjust(h.db, "anthropic", 94.5, undefined, h.clock.now());
    h.clock.advance(1);
    h.fake.reply({
      kind: "message",
      usage: { output: 40000 },
      blocks: [{ type: "tool_use", id: "tu1", name: "tars", input: { argv: runArgv("push") } }],
    });
    const out = ended(await runTurn(h, "推播"));
    expect(out).toMatchObject({ state: "failed", reason: "budget_stopped" });
    expect(h.frontend.approvals).toEqual([]);
    expect(counts(h.db).approvals).toBe(0);
    expect(toolResults(h, out.convId)[0]?.status).toBe("refused");
  });

  test("an approval answered after it expired is recorded expired; the turn goes on", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "push", "external-write");
    h.frontend.answer = async () => {
      h.clock.advance(601_000);
      return "approved";
    };
    h.fake.reply(tarsCall("tu1", runArgv("push")), text("過期了"));
    const out = ended(await runTurn(h, "推播"));
    expect(out.state).toBe("completed");
    expect(toolResults(h, out.convId)[0]).toMatchObject({
      status: "expired",
      text: "核准已過期，沒有執行",
    });
    expect(rows<{ state: string }>(h.db, "SELECT state FROM approvals")).toEqual([
      { state: "expired" },
    ]);
    await expectNextTurnValid(h, out.convId);
  });

  test("a no given after expiry is an expiry in both tables", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "push", "external-write");
    h.frontend.answer = async () => {
      h.clock.advance(601_000);
      return "denied";
    };
    h.fake.reply(tarsCall("tu1", runArgv("push")), text("過期了"));
    const out = ended(await runTurn(h, "推播"));
    expect(out.state).toBe("completed");
    expect(toolResults(h, out.convId)[0]?.status).toBe("expired");
    expect(rows<{ state: string }>(h.db, "SELECT state FROM approvals")).toEqual([
      { state: "expired" },
    ]);
    expect(rows<{ state: string }>(h.db, "SELECT state FROM tool_calls")).toEqual([
      { state: "expired" },
    ]);
  });

  test("aborting while the approval waits cancels it and aborts the turn", async () => {
    const h = await harness({ selfCommand: [RAN] });
    addScript(h, "push", "external-write");
    const controller = new AbortController();
    h.frontend.answer = (_a, signal) =>
      new Promise((done) => {
        signal.addEventListener("abort", () => done("cancelled"), { once: true });
        controller.abort();
      });
    h.fake.reply({
      kind: "message",
      blocks: [
        { type: "tool_use", id: "tu1", name: "tars", input: { argv: runArgv("push") } },
        { type: "tool_use", id: "tu2", name: "tars", input: { argv: ["cost"] } },
      ],
    });
    const out = ended(await runTurn(h, "推播", { signal: controller.signal }));
    expect(out.state).toBe("aborted");
    expect(toolResults(h, out.convId).map((r) => r.status)).toEqual(["cancelled", "skipped"]);
    expect(rows<{ state: string }>(h.db, "SELECT state FROM approvals")).toEqual([
      { state: "cancelled" },
    ]);
    await expectNextTurnValid(h, out.convId);
  });

  test("a script whose version changes after approval is refused", async () => {
    const h = await harness({ selfCommand: [RAN] });
    const dir = addScript(h, "push", "external-write");
    h.frontend.answer = async () => {
      replaceVersion(dir, "push", "fedcba9876543210");
      return "approved";
    };
    h.fake.reply(tarsCall("tu1", runArgv("push")), text("沒送"));
    const out = ended(await runTurn(h, "推播"));
    expect(out.state).toBe("completed");
    const [result] = toolResults(h, out.convId);
    expect(result?.status).toBe("refused");
    expect(result?.text).toContain("腳本或路徑在核准後變了");
  });
});

describe("effort", () => {
  test("a level the model lacks is clamped below, and the notice says which", async () => {
    const h = await harness();
    h.fake.reply(text("ok"));
    const out = ended(await runTurn(h, "hi", { effort: "max" }));
    expect(h.fake.messages()[0]?.body.output_config).toEqual({ effort: "high" });
    expect(h.frontend.events).toContainEqual({
      type: "notice",
      code: "effort_clamped",
      data: { effort: "high" },
    });
    expect(turnRow(h.db, out.turnId).effort).toBe("high");
  });

  test("a model without effort: no parameters, one notice per conversation", async () => {
    const h = await harness({ model: { effortLevels: undefined } });
    h.fake.reply(text("一"), text("二"));
    const first = ended(await runTurn(h, "hi"));
    ended(await runTurn(h, "again", { convId: first.convId }));
    for (const r of h.fake.messages()) {
      expect(r.body.output_config).toBeUndefined();
      expect(r.body.thinking).toBeUndefined();
    }
    expect(h.frontend.notices().filter((n) => n === "effort_unsupported")).toHaveLength(1);
    expect(turnRow(h.db, first.turnId).effort).toBeNull();
  });

  test("output used up by thinking sends effort_truncated", async () => {
    const h = await harness();
    h.fake.reply({
      kind: "message",
      stop: "max_tokens",
      blocks: [{ type: "thinking", thinking: "想很久", signature: "sig" }],
    });
    const out = ended(await runTurn(h, "hi"));
    expect(h.frontend.notices()).toContain("effort_truncated");
    expect(readItems(h.db, out.convId).some((i: Item) => i.kind === "assistant")).toBe(false);
    await expectNextTurnValid(h, out.convId);
  });
});

describe("preserved thinking", () => {
  const thought = (id: string, after: FakeBlock): FakeReply => ({
    kind: "message",
    blocks: [{ type: "thinking", thinking: "", signature: `sig-${id}` }, after],
  });
  /** The signatures each assistant message of the last request carries. */
  const signatures = (h: EngineHarness) =>
    lastMessages(h)
      .filter((m) => m.role === "assistant")
      .map((m) =>
        (m.content as { type: string; signature?: string }[])
          .filter((b) => b.type === "thinking")
          .map((b) => b.signature),
      );

  test("an unchanged prefix replays earlier thinking, and the tool loop keeps its own", async () => {
    const h = await harness();
    h.fake.reply(thought("a", { type: "text", text: "one" }));
    const first = ended(await runTurn(h, "first"));
    h.fake.reply(
      thought("b", { type: "tool_use", id: "tu1", name: "skill_load", input: { name: "demo" } }),
      text("two"),
    );
    ended(await runTurn(h, "second", { convId: first.convId }));
    expect(signatures(h)).toEqual([["sig-a"], ["sig-b"]]);
  });

  test("after MEMORY.md changes, earlier thinking is not replayed; the tool loop's still is", async () => {
    const h = await harness();
    h.fake.reply(thought("a", { type: "text", text: "one" }));
    const first = ended(await runTurn(h, "first"));
    writeFileSync(h.paths.memory, "# Memory\n- new fact\n");
    h.fake.reply(
      thought("b", { type: "tool_use", id: "tu1", name: "skill_load", input: { name: "demo" } }),
      text("two"),
    );
    ended(await runTurn(h, "second", { convId: first.convId }));
    expect(signatures(h)).toEqual([[], ["sig-b"]]);
    const texts = lastMessages(h)[1]?.content as { type: string }[];
    expect(texts.map((b) => b.type)).toEqual(["text"]);
  });
});

describe("the wiki index in a conversation", () => {
  type Sent = { role: string; content: { type: string; text?: string; cache_control?: unknown }[] };
  const strip = (m: unknown) =>
    JSON.parse(JSON.stringify(m), (k, v) => (k === "cache_control" ? undefined : v)) as Sent[];
  const sent = (h: EngineHarness, i: number) =>
    h.fake.messages()[i]?.body as Record<string, unknown>;
  const kinds = (h: EngineHarness, convId: string) => readItems(h.db, convId).map((i) => i.kind);

  test("a new conversation stores the index just before the message, in the same turn", async () => {
    const h = await harness();
    writeWikiIndex(h.paths, ["王小明"]);
    h.fake.reply(text("ok"));
    const out = ended(await runTurn(h, "hi"));
    const items = readItems(h.db, out.convId);
    expect(items.map((i) => i.kind).slice(0, 2)).toEqual(["wiki_index", "user"]);
    expect(items[0]?.turnId).toBe(items[1]?.turnId as string);
    expect(items[1]?.seq).toBe((items[0]?.seq as number) + 1);
    const [first] = strip(sent(h, 0).messages);
    expect(first?.content.map((b) => b.text?.split("\n")[0])).toEqual(["<wiki-index>", "hi"]);
    expect(h.frontend.events.some((e) => e.type === "item" && e.item.kind === "wiki_index")).toBe(
      true,
    );
  });

  test("the next turn adds no index; a changed index.md leaves sent bytes alone", async () => {
    const h = await harness();
    writeWikiIndex(h.paths, ["王小明"]);
    h.fake.reply(text("ok"), text("ok"));
    const { convId } = ended(await runTurn(h, "hi"));
    writeWikiIndex(h.paths, ["王小明", "陳大文"], "2026-11-20");
    ended(await runTurn(h, "again", { convId }));
    expect(kinds(h, convId).filter((k) => k === "wiki_index")).toHaveLength(1);
    const [a, b] = [sent(h, 0), sent(h, 1)];
    expect(b.system).toEqual(a.system);
    expect(b.tools).toEqual(a.tools);
    expect(strip(b.messages).slice(0, 1)).toEqual(strip(a.messages));
    expect(JSON.stringify(b.messages)).not.toContain("陳大文");
  });

  test("a refused message leaves no index behind", async () => {
    const h = await harness();
    writeWikiIndex(h.paths, ["王小明"]);
    adjust(h.db, "anthropic", 94.99, undefined, h.clock.now());
    expect(await runTurn(h, "hi")).toMatchObject({ kind: "rejected" });
    expect(counts(h.db).items).toBe(0);
  });

  test("without index.md the request is as before; once it appears, the next turn adds one", async () => {
    const h = await harness();
    h.fake.reply(text("ok"), text("ok"));
    const { convId } = ended(await runTurn(h, "hi"));
    expect(kinds(h, convId)).not.toContain("wiki_index");
    expect(strip(sent(h, 0).messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    writeWikiIndex(h.paths, ["王小明"]);
    ended(await runTurn(h, "again", { convId }));
    const items = readItems(h.db, convId);
    const at = items.findIndex((i) => i.kind === "wiki_index");
    expect(items[at + 1]).toMatchObject({ kind: "user", body: { text: "again" } });
    const second = strip(sent(h, 1).messages);
    expect(second.slice(0, 1)).toEqual(strip(sent(h, 0).messages));
    expect(second.at(-1)?.content.map((b) => b.text?.split("\n")[0])).toEqual([
      "<wiki-index>",
      "again",
    ]);
  });
});

describe("compatible providers", () => {
  const compats: CompatHarness[] = [];
  afterEach(async () => {
    for (const h of compats.splice(0)) await h.stop();
  });
  async function compat(opts: HarnessOptions = {}) {
    const h = await compatHarness(opts);
    compats.push(h);
    return h;
  }
  type Ref = { provider: "gemini" | "openrouter"; model: string };
  const GEMINI: Ref = { provider: "gemini", model: GEMINI_ENTRY.id };
  const OPENROUTER: Ref = { provider: "openrouter", model: OPENROUTER_ENTRY.id };
  const send = (h: CompatHarness, ref: Ref, message: string, signal?: AbortSignal) =>
    h.engine.runTurn(
      { ...ref, effort: "medium", text: message },
      h.frontend,
      signal ?? new AbortController().signal,
    );
  const usageRows = (h: CompatHarness) =>
    rows<{
      state: string;
      cost_usd: number;
      cost_source: string;
      reserved_usd: number;
      output_tokens: number;
      max_tokens: number;
    }>(h.db, "SELECT * FROM usage ORDER BY id");
  const fakeOf = (h: CompatHarness, ref: Ref) =>
    ref.provider === "gemini" ? h.gemini : h.openrouter;

  test("while the stream runs without input usage, the row stays at the reserved amount", async () => {
    const h = await compat();
    h.gemini.reply({ kind: "hang", text: "thinking" });
    const ctl = new AbortController();
    const pending = send(h, GEMINI, "hi", ctl.signal);
    while (h.gemini.chats().length === 0) await Bun.sleep(5);
    await Bun.sleep(30);
    const [during] = usageRows(h);
    expect(during).toMatchObject({ state: "reserved" });
    expect(during?.cost_usd).toBe(during?.reserved_usd);
    ctl.abort();
    await pending;
  });

  test("a normal end is final; OpenRouter's amount is the response's cost", async () => {
    const h = await compat();
    h.openrouter.reply(compatText("hello", { prompt: 30, completion: 5, cost: 0.0042 }));
    expect(ended(await send(h, OPENROUTER, "hi")).state).toBe("completed");
    expect(usageRows(h)[0]).toMatchObject({
      state: "final",
      cost_usd: 0.0042,
      cost_source: "provider",
    });
    h.gemini.reply(compatText("hello", { prompt: 1000, completion: 500, total: 1500 }));
    expect(ended(await send(h, GEMINI, "hi")).state).toBe("completed");
    // 1,000 in at 1 USD and 500 out at 4 USD per million.
    expect(usageRows(h)[1]).toMatchObject({ state: "final", cost_source: "table" });
    expect(usageRows(h)[1]?.cost_usd).toBeCloseTo(0.003, 10);
  });

  test("CUJ 7: Gemini at medium breaks off mid-stream: estimated, output at the full limit", async () => {
    const h = await compat();
    h.gemini.reply({ kind: "disconnect", text: "half an answer" });
    const out = ended(await send(h, GEMINI, "hi"));
    expect(out).toMatchObject({ state: "failed", reason: "stream_interrupted" });
    const [row] = usageRows(h);
    expect(row).toMatchObject({ state: "estimated", cost_source: "estimate" });
    expect(row?.output_tokens).toBe(row?.max_tokens);
    expect(row?.cost_usd).toBeCloseTo(row?.reserved_usd ?? -1, 10);
  });

  describe("what counts as reasoning", () => {
    const PLAIN: Ref = { provider: "gemini", model: "gemini-plain" };
    const plainEntry = { ...GEMINI_ENTRY, id: "gemini-plain", label: "plain" };
    const { effortLevels: _, ...noLevels } = plainEntry;
    const broken = async (h: CompatHarness, ref: Ref, reply: FakeCompatReply) => {
      fakeOf(h, ref).reply(reply);
      ended(await send(h, ref, "hi"));
      return usageRows(h).at(-1);
    };

    test("a thinking signal in the stream", async () => {
      const h = await compat({ extraModels: [noLevels] });
      const row = await broken(h, PLAIN, { kind: "disconnect", text: "x" });
      expect(row?.output_tokens).toBeLessThan(row?.max_tokens ?? 0);
      // Same model, a reasoning delta before the break.
      h.gemini.reply({ kind: "message", text: "x", reasoning: true, finish: null });
      ended(await send(h, PLAIN, "hi"));
      const thought = usageRows(h).at(-1);
      expect(thought?.output_tokens).toBe(thought?.max_tokens);
    });

    test("a level sent", async () => {
      const h = await compat();
      const row = await broken(h, GEMINI, { kind: "disconnect", text: "x" });
      expect(h.gemini.chats()[0]?.body.reasoning_effort).toBe("medium");
      expect(row?.output_tokens).toBe(row?.max_tokens);
    });

    test("levels on the model and no off setting sent: the summary request to OpenRouter", async () => {
      const h = await compat({ config: SHORT_KEEP });
      const convId = ended(await sendText(h, OPENROUTER, "first")).convId;
      h.openrouter.reply({ kind: "disconnect", text: "## Goal" });
      await h.engine.compact(
        convId,
        { trigger: "manual" },
        h.frontend,
        new AbortController().signal,
      );
      const body = h.openrouter.chats().at(-1)?.body;
      expect(body?.reasoning).toEqual({ effort: "low" });
      const row = usageRows(h).at(-1);
      expect(row?.output_tokens).toBe(row?.max_tokens);
    });

    test("the off setting sent and no thinking seen: not reasoning", async () => {
      const h = await compat({ config: SHORT_KEEP });
      const convId = ended(await sendText(h, GEMINI, "first")).convId;
      h.gemini.reply({ kind: "disconnect", text: "## Goal" });
      await h.engine.compact(
        convId,
        { trigger: "manual" },
        h.frontend,
        new AbortController().signal,
      );
      expect(h.gemini.chats().at(-1)?.body.reasoning_effort).toBe("none");
      const row = usageRows(h).at(-1);
      expect(row?.output_tokens).toBeLessThan(row?.max_tokens ?? 0);
    });

    // keep_recent 1,000 tokens: /compact has the earlier turns to replace.
    const SHORT_KEEP = enableCompat(configWith({ compact_keep_recent_tokens: 1000 }));
    // A conversation long enough that /compact has something to replace.
    async function sendText(h: CompatHarness, ref: Ref, first: string) {
      const fake = fakeOf(h, ref);
      let convId: string | undefined;
      let out: TurnOutcome | undefined;
      for (let i = 0; i < 6; i++) {
        fake.reply(compatText("a".repeat(3000)));
        out = await h.engine.runTurn(
          {
            ...ref,
            effort: "medium",
            text: `${first} ${"u".repeat(3000)} ${i}`,
            ...(convId === undefined ? {} : { convId }),
          },
          h.frontend,
          new AbortController().signal,
        );
        convId = ended(out).convId;
      }
      return out as TurnOutcome;
    }
  });

  test("an end without usage: the turn completes, the tool runs, the row is estimated, a notice", async () => {
    const h = await compat();
    h.openrouter.reply(
      {
        kind: "message",
        toolCalls: [{ id: "p1", name: "tars", args: { argv: ["cost"] } }],
        usage: null,
      },
      compatText("done", null),
    );
    const out = ended(await send(h, OPENROUTER, "cost?"));
    expect(out.state).toBe("completed");
    expect(rows<{ state: string }>(h.db, "SELECT state FROM tool_calls")).toEqual([
      { state: "done" },
    ]);
    expect(usageRows(h).map((r) => [r.state, r.cost_source])).toEqual([
      ["estimated", "estimate"],
      ["estimated", "estimate"],
    ]);
    expect(h.frontend.notices().filter((n) => n === "usage_missing")).toHaveLength(2);
  });

  test("usage that cannot price the request: estimated with the reservation, never zero", async () => {
    const h = await compat();
    h.openrouter.reply(
      { kind: "message", text: "x", rawUsage: {} },
      {
        kind: "message",
        text: "y",
        rawUsage: { prompt_tokens: 10, completion_tokens: 2, cost: -1 },
      },
    );
    h.gemini.reply(compatText("z", { total: null }));
    for (const ref of [OPENROUTER, OPENROUTER, GEMINI])
      expect(ended(await send(h, ref, "hi")).state).toBe("completed");
    const settled = usageRows(h);
    expect(settled.map((r) => [r.state, r.cost_source])).toEqual(
      Array(3).fill(["estimated", "estimate"]),
    );
    // effort medium reasons: the whole output limit stays counted.
    for (const r of settled) expect(r.output_tokens).toBe(r.max_tokens);
    expect(h.frontend.notices().filter((n) => n === "usage_missing")).toHaveLength(3);
  });

  test("no usage, no reasoning, only a tool call: its name and input are the output", async () => {
    // No effort levels: a request to it does not count as reasoning.
    const { effortLevels: _, ...plain } = { ...OPENROUTER_ENTRY, id: "vendor/plain" };
    const h = await compat({ extraModels: [plain] });
    const input = { argv: ["script", "run", "x", "--note", "長".repeat(500)] };
    h.openrouter.reply(
      { kind: "message", toolCalls: [{ id: "p1", name: "tars", args: input }], usage: null },
      compatText("done"),
    );
    const out = await send(h, { provider: "openrouter", model: plain.id }, "go");
    expect(ended(out).state).toBe("completed");
    const first = usageRows(h)[0];
    expect(first?.state).toBe("estimated");
    expect(first?.output_tokens).toBe(
      estimateTokens(utf8Bytes("tars") + utf8Bytes(JSON.stringify(input))),
    );
  });

  describe("no start and no status", () => {
    const silent = { kind: "silent", after: "close" } as const;
    // No effort levels: a request to it does not count as reasoning.
    const { effortLevels: _, ...plain } = { ...OPENROUTER_ENTRY, id: "vendor/plain" };
    const PLAIN: Ref = { provider: "openrouter", model: plain.id };
    const wholeReservation = (r: { cost_usd: number; reserved_usd: number }) =>
      expect(r.cost_usd).toBeCloseTo(r.reserved_usd, 12);
    const inputOnly = (r: { cost_usd: number; reserved_usd: number; output_tokens: number }) => {
      expect(r.output_tokens).toBe(0);
      expect(r.cost_usd).toBeLessThan(r.reserved_usd);
    };

    test("reasoning, the body ends after the headers: each attempt keeps its reservation", async () => {
      const h = await compat();
      h.openrouter.reply(silent, silent, silent);
      expect(ended(await send(h, OPENROUTER, "hi")).state).toBe("failed");
      const settled = usageRows(h);
      expect(settled.map((r) => r.state)).toEqual(["estimated", "estimated", "estimated"]);
      for (const r of settled) {
        wholeReservation(r);
        expect(r.output_tokens).toBe(r.max_tokens);
      }
    });

    test("reasoning, Ctrl+C before the first chunk: the reservation stays", async () => {
      const h = await compat();
      h.gemini.reply({ kind: "silent", after: "wait" });
      const ctl = new AbortController();
      const pending = send(h, GEMINI, "hi", ctl.signal);
      while (h.gemini.chats().length === 0) await Bun.sleep(5);
      ctl.abort();
      await pending;
      const [row] = usageRows(h);
      expect(row?.state).toBe("estimated");
      if (row !== undefined) wholeReservation(row);
    });

    test("not reasoning: the input only, as before", async () => {
      const h = await compat({ extraModels: [plain] });
      h.openrouter.reply(silent, silent, silent);
      expect(ended(await send(h, PLAIN, "hi")).state).toBe("failed");
      for (const r of usageRows(h)) inputOnly(r);
    });

    test("reasoning, but the connection failed before anything was sent: the input only", async () => {
      const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const url = `http://127.0.0.1:${closed.port}`;
      await closed.stop(true);
      const h = await compat({ extraEnv: { [E2E_BASE_URL_VARS.openrouter]: url } });
      expect(ended(await send(h, OPENROUTER, "hi")).state).toBe("failed");
      const settled = usageRows(h);
      expect(settled).toHaveLength(3);
      for (const r of settled) inputOnly(r);
    });
  });

  test("usage that contradicts itself: estimated with a notice, not priced", async () => {
    const h = await compat();
    h.gemini.reply({
      kind: "message",
      text: "x",
      rawUsage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 1 },
    });
    h.openrouter.reply({
      kind: "message",
      text: "y",
      rawUsage: { prompt_tokens: 0.1, completion_tokens: 0.2 },
    });
    for (const ref of [GEMINI, OPENROUTER])
      expect(ended(await send(h, ref, "hi")).state).toBe("completed");
    expect(usageRows(h).map((r) => r.state)).toEqual(["estimated", "estimated"]);
    expect(h.frontend.notices().filter((n) => n === "usage_missing")).toHaveLength(2);
  });

  test("the answer's items and its estimated row are written in one transaction", async () => {
    const h = await compat();
    const writer = await openDb(h.paths);
    writer.run(
      `CREATE TRIGGER fault BEFORE INSERT ON items WHEN NEW.kind = 'assistant'
       BEGIN SELECT RAISE(ABORT, 'fault'); END`,
    );
    writer.close();
    h.openrouter.reply(compatText("never stored", null));
    await expect(send(h, OPENROUTER, "hi")).rejects.toThrow("fault");
    expect(usageRows(h)[0]?.state).toBe("reserved");
  });

  test("acceptance 2: Anthropic at its stop line; a Gemini turn goes ahead", async () => {
    const h = await compat();
    adjust(h.db, "anthropic", 95, undefined, h.clock.now());
    expect(await runTurn(h, "hi")).toMatchObject({ kind: "rejected", reason: "budget_stopped" });
    h.gemini.reply(compatText("fine"));
    expect(ended(await send(h, GEMINI, "hi")).state).toBe("completed");
    expect(h.fake.messages()).toHaveLength(0);
  });
});

describe("continuing with another model", () => {
  // maxBytes for the carried text is 10,000 × 0.4 × 2 = 8,000; the stop line is 8,500 tokens.
  const SMALL = configWith({ max_input_tokens: 10000 });

  /** An earlier conversation of `turns` turns, through the engine. */
  async function earlier(h: EngineHarness, turns: readonly [string, string][]) {
    let convId: string | undefined;
    for (const [said, replied] of turns) {
      h.fake.reply(text(replied));
      convId = ended(await runTurn(h, said, convId === undefined ? {} : { convId })).convId;
    }
    return convId as string;
  }
  const carryOn = (h: EngineHarness, from: string, message: string, keepLast?: number) =>
    h.engine.runTurn(
      {
        provider: "anthropic",
        model: MODEL_ID,
        effort: "medium",
        text: message,
        continueFrom: from,
        ...(keepLast === undefined ? {} : { keepLast }),
      },
      h.frontend,
      new AbortController().signal,
    );
  const withoutCacheControl = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(withoutCacheControl)
      : typeof v === "object" && v !== null
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => k !== "cache_control")
              .map(([k, x]) => [k, withoutCacheControl(x)]),
          )
        : v;

  test("the new conversation has parent_id; stored: carried text, index, message", async () => {
    const h = await harness();
    writeWikiIndex(h.paths, ["王小明"]);
    const old = await earlier(h, [["第一個問題", "第一個回答"]]);
    const before = readItems(h.db, old);
    h.fake.reply(text("好"));
    const out = ended(await carryOn(h, old, "繼續剛才的整理"));
    expect(out.convId).not.toBe(old);
    expect(rows(h.db, "SELECT parent_id FROM conversations WHERE id = ?", out.convId)).toEqual([
      { parent_id: old },
    ]);
    const items = readItems(h.db, out.convId);
    expect(items.slice(0, 3).map((i) => i.kind)).toEqual(["user", "wiki_index", "user"]);
    const [carried, , message] = items;
    expect(carried?.kind === "user" && carried.body.carriedFrom).toBe(old);
    expect(carried?.kind === "user" && carried.body.text).toContain("│ 第一個回答");
    expect(message?.kind === "user" && message.body).toEqual({ text: "繼續剛才的整理" });
    expect(readItems(h.db, old)).toEqual(before);
  });

  test.each([
    ["with", true],
    ["without", false],
  ])(
    "%s an index, the first request's opening message is byte for byte the second's",
    async (_, index) => {
      const h = await harness();
      if (index) writeWikiIndex(h.paths, ["王小明"]);
      const old = await earlier(h, [["一", "二"]]);
      h.fake.reply(text("好"));
      const convId = ended(await carryOn(h, old, "繼續")).convId;
      h.fake.reply(text("再好"));
      ended(await runTurn(h, "下一則", { convId }));
      const [first, second] = h.fake.messages().slice(-2);
      const opening = (r: { body: Record<string, unknown> } | undefined) =>
        JSON.stringify(withoutCacheControl((r?.body.messages as unknown[] | undefined)?.[0]));
      expect(opening(second)).toBe(opening(first));
      expect(opening(first)).toContain("previous-conversation");
      expect(opening(first).includes("wiki-index")).toBe(index);
    },
  );

  /** A conversation stored by hand, for sizes the engine would compact first. */
  function stored(h: EngineHarness, items: Parameters<typeof appendItems>[3]) {
    const convId = newId();
    const turnId = newId();
    const now = h.clock.now().getTime();
    createConversation(h.db, {
      id: convId,
      text: "old",
      provider: "anthropic",
      model: MODEL_ID,
      effort: "medium",
      now,
    });
    beginTurn(h.db, { id: turnId, convId, kind: "chat", effort: "medium", now });
    appendItems(h.db, convId, turnId, items, now);
    return convId;
  }
  const said = (t: string) => ({ kind: "user" as const, step: 0, body: { text: t } });
  const replied = (t: string) => ({
    kind: "assistant" as const,
    step: 1,
    body: { text: t, state: "complete" as const, native: null },
  });

  test.each([
    [
      "a summary too long",
      () => [
        {
          kind: "compaction" as const,
          step: 1,
          body: {
            firstKeptSeq: 2,
            summary: "s".repeat(9000),
            tokensBefore: 1,
            replacedCount: 1,
            trigger: "manual" as const,
            usageId: 1,
          },
        },
        said("hi"),
      ],
      "x",
      "前一個對話的摘要太長，帶不進這個模型。用 --keep-last <N> 只帶最後幾個回合",
    ],
    [
      "the latest turn too long",
      () => [said("t".repeat(9000)), replied("ok")],
      "x",
      "最近一個回合就超過這個模型能帶入的長度，--keep-last 也帶不進去。換視窗較大的模型，或開新對話",
    ],
    [
      "the message with it over the stop line",
      () => [said("t".repeat(6000)), replied("ok")],
      "m".repeat(14000),
      "這則訊息加上帶入的內容太長。縮短訊息，或用 --keep-last <N> 少帶幾個回合",
    ],
  ])("conv_too_long when %s; nothing is created", async (_, items, message, expected) => {
    const h = await harness({ config: SMALL });
    const old = stored(h, items());
    const before = counts(h.db);
    expect(await carryOn(h, old, message)).toEqual({
      kind: "rejected",
      reason: "conv_too_long",
      message: expected,
    });
    expect(counts(h.db)).toEqual(before);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("keepLast carries only the last turns", async () => {
    const h = await harness();
    const old = await earlier(h, [
      ["first question", "first answer"],
      ["second question", "second answer"],
      ["third question", "third answer"],
    ]);
    h.fake.reply(text("好"));
    const convId = ended(await carryOn(h, old, "go", 1)).convId;
    const carried = readItems(h.db, convId)[0];
    const body = carried?.kind === "user" ? carried.body.text : "";
    expect(body).toContain("│ third answer");
    expect(body).not.toContain("second question");
    expect(body).toContain("（這裡有 2 個回合沒有帶入）");
  });
});
