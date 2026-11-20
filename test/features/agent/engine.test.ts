import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine, TurnOutcome } from "../../../src/features/agent/engine.ts";
import { adjust } from "../../../src/features/agent/ledger.ts";
import { REFUSAL_TEXT } from "../../../src/features/agent/tars-tool.ts";
import { reconcile } from "../../../src/features/agent/reconcile.ts";
import { readItems } from "../../../src/features/agent/store.ts";
import type { Effort, Item } from "../../../src/features/agent/types.ts";
import { tarsCall, text, toolUse, type FakeBlock, type FakeReply } from "../../fakes/anthropic.ts";
import { tempHome, TEST_NOW } from "../../helpers.ts";
import { installSample, sampleScript } from "../script/sample.ts";
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
