import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../helpers.ts";
import { utf8Bytes } from "../../../src/features/agent/bytes.ts";
import { loadCatalog, resolve } from "../../../src/features/agent/catalog.ts";
import {
  buildActiveHistory,
  sentBytes,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM,
  SUMMARY_HEADINGS,
  SUMMARY_PREFIX,
  UPDATE_SUMMARIZATION_PROMPT,
} from "../../../src/features/agent/compaction.ts";
import { DEFAULT_LIMITS } from "../../../src/features/agent/config.ts";
import type { TurnOutcome } from "../../../src/features/agent/engine.ts";
import { estimateInput, insertReserved } from "../../../src/features/agent/ledger.ts";
import { buildSystem, loadSkillIndex, TOOL_SPECS } from "../../../src/features/agent/prompt.ts";
import { reconcile } from "../../../src/features/agent/reconcile.ts";
import {
  addTurnRequest,
  beginTurn,
  newId,
  readActiveItems,
  readItems,
} from "../../../src/features/agent/store.ts";
import type { CompactionItem, ContextItem } from "../../../src/features/agent/types.ts";
import { loadBoot } from "../../../src/features/session/boot.ts";
import { text, toolUse, type FakeReply, type RecordedRequest } from "../../fakes/anthropic.ts";
import {
  configWith,
  engineHarness,
  type HarnessOptions,
  historyProblems,
  MODEL_ID,
  type EngineHarness,
} from "./engine-fixture.ts";

// A 10,000-token window: compaction at 5,000 estimated tokens, the hard stop at 8,500. The
// compact line sits well under the stop line so a turn can still go ahead when compaction fails
// or is skipped. keep_recent 1,000 tokens keeps about one seeded turn; a 1,024-token summary
// leaves 7,476 estimated tokens for the whole summary prompt.
const BASE = {
  max_input_tokens: 10000,
  context_warn_ratio: 0.4,
  context_compact_ratio: 0.5,
  context_stop_ratio: 0.85,
  compact_keep_recent_tokens: 1000,
  compact_max_output_tokens: 1024,
};
const OVER_LINE = 5500;
const U = "u".repeat(1200);
const A = "a".repeat(1200);

const summaryText = (marker = "") =>
  SUMMARY_HEADINGS.map((h, i) => `## ${h}\n- ${i === 0 ? `goal ${marker}` : "(none)"}`).join(
    "\n\n",
  );
const summaryReply = (marker = "", input = 100): FakeReply => ({
  kind: "message",
  blocks: [{ type: "text", text: summaryText(marker) }],
  usage: { input },
});
const answer = (input = 100): FakeReply => ({
  kind: "message",
  blocks: [{ type: "text", text: A }],
  usage: { input },
});

const isSummary = (r: RecordedRequest) =>
  (r.body.system as { text: string }[])[0]?.text === SUMMARIZATION_SYSTEM;
const promptOf = (r: RecordedRequest) =>
  ((r.body.messages as { content: { text: string }[] }[])[0]?.content[0]?.text ?? "") as string;

let harness: EngineHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function setup(
  values: Record<string, string | number | boolean> = {},
  model = {},
  opts: Omit<HarnessOptions, "config" | "model"> = {},
) {
  harness = await engineHarness({ ...opts, config: configWith({ ...BASE, ...values }), model });
  return harness;
}

function run(h: EngineHarness, message: string, convId?: string, signal?: AbortSignal) {
  return h.engine.runTurn(
    {
      ...(convId === undefined ? {} : { convId }),
      provider: "anthropic",
      model: MODEL_ID,
      effort: "medium",
      text: message,
    },
    h.frontend,
    signal ?? new AbortController().signal,
  );
}

const ended = (out: TurnOutcome) => {
  if (out.kind !== "ended") throw new Error(`turn rejected: ${out.reason} ${out.message}`);
  return out;
};

/** `turns` completed turns; the last request reports `lastInput` tokens of input. */
async function seed(h: EngineHarness, turns: number, lastInput = 100, first = U): Promise<string> {
  let convId: string | undefined;
  for (let i = 0; i < turns; i++) {
    h.fake.reply(answer(i === turns - 1 ? lastInput : 100));
    const out = ended(await run(h, (i === 0 ? first : U) + i, convId));
    expect(out.state).toBe("completed");
    convId = out.convId;
  }
  return convId as string;
}

const compact = (h: EngineHarness, convId: string, focus?: string, signal?: AbortSignal) =>
  h.engine.compact(
    convId,
    { trigger: "manual", ...(focus === undefined ? {} : { focus }) },
    h.frontend,
    signal ?? new AbortController().signal,
  );

const compactions = (h: EngineHarness, convId: string) =>
  readItems(h.db, convId).filter((i): i is CompactionItem => i.kind === "compaction");

const turnsOf = (h: EngineHarness, convId: string) =>
  h.db
    .query("SELECT id, kind, state, reason, cost_usd FROM turns WHERE conv_id = ? ORDER BY rowid")
    .all(convId) as {
    id: string;
    kind: string;
    state: string;
    reason: string | null;
    cost_usd: number;
  }[];

const conversation = (h: EngineHarness, convId: string) =>
  h.db
    .query(
      "SELECT last_total_input_tokens, last_request_at, last_prefix_key FROM conversations WHERE id = ?",
    )
    .get(convId) as {
    last_total_input_tokens: number;
    last_request_at: number | null;
    last_prefix_key: string | null;
  };

const rowCounts = (h: EngineHarness) =>
  ["turns", "items", "usage", "conversations"].map(
    (t) => (h.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
  );

const firstUsage = (h: EngineHarness, turnId: string) =>
  h.db.query("SELECT * FROM usage WHERE turn_id = ? ORDER BY id LIMIT 1").get(turnId) as {
    state: string;
    reserved_usd: number;
    uncached_input_tokens: number;
  };

/** Aborts once the server has seen `count` message requests. */
function abortAt(h: EngineHarness, count: number, ctl: AbortController): void {
  const timer = setInterval(() => {
    if (h.fake.messages().length >= count) {
      clearInterval(timer);
      ctl.abort();
    }
  }, 2);
}

describe("automatic compaction", () => {
  test("crossing the compact line compacts before the next reply", async () => {
    const h = await setup();
    const convId = await seed(h, 2, OVER_LINE);
    const items = readItems(h.db, convId);
    h.fake.reply(summaryReply(), text("reply"));
    const out = ended(await run(h, "next", convId));
    expect(out.state).toBe("completed");

    const sent = h.fake.messages();
    expect(sent).toHaveLength(4);
    expect(isSummary(sent[2] as RecordedRequest)).toBe(true);
    const turns = turnsOf(h, convId);
    expect(turns.map((t) => t.kind)).toEqual(["chat", "chat", "compaction", "chat"]);
    expect(turns[2]?.state).toBe("completed");

    const [c] = compactions(h, convId);
    const secondUser = items.filter((i) => i.kind === "user")[1];
    expect(c?.body.trigger).toBe("auto");
    expect(c?.body.firstKeptSeq).toBe(secondUser?.seq as number);
    expect(c?.body.replacedCount).toBe(2);
    expect(c?.body.tokensBefore).toBe(OVER_LINE);

    // The summary and the first kept user message merge into one user message.
    const messages = (sent[3] as RecordedRequest).body.messages as {
      role: string;
      content: { text: string }[];
    }[];
    expect(historyProblems(messages)).toEqual([]);
    expect(messages[0]?.content[0]?.text).toBe(SUMMARY_PREFIX + summaryText());
    expect(messages[0]?.content[1]?.text).toBe(`${U}1`);
    expect(JSON.stringify(messages)).not.toContain(`${U}0`);
    expect(h.frontend.notices()).toContain("compact_start");
  });

  test("auto_compact = false never compacts", async () => {
    const h = await setup({ auto_compact: false });
    const convId = await seed(h, 2, OVER_LINE);
    h.fake.reply(text("reply"));
    expect(ended(await run(h, "next", convId)).state).toBe("completed");
    expect(h.fake.messages().some(isSummary)).toBe(false);
    expect(turnsOf(h, convId).map((t) => t.kind)).toEqual(["chat", "chat", "chat"]);
  });

  test.each([
    ["provider_error", { kind: "http_error", status: 500, type: "api_error" } as FakeReply],
    [
      "compact_truncated",
      {
        kind: "message",
        blocks: [{ type: "text", text: summaryText() }],
        stop: "max_tokens",
      } as FakeReply,
    ],
    ["compact_bad_summary", text(summaryText().replace("## Next Steps", "## Later"))],
  ])("a failed compaction (%s) leaves no summary and the turn goes on", async (reason, reply) => {
    const h = await setup();
    const convId = await seed(h, 2, OVER_LINE);
    h.fake.reply(reply, text("reply"));
    expect(ended(await run(h, "next", convId)).state).toBe("completed");

    expect(compactions(h, convId)).toEqual([]);
    const compaction = turnsOf(h, convId)[2];
    expect(compaction).toMatchObject({ kind: "compaction", state: "failed", reason });
    expect(h.frontend.events).toContainEqual({
      type: "notice",
      code: "compact_failed",
      data: { reason },
    });
    // No retry for a summary request: the next one is the chat request.
    expect(h.sleeps).toEqual([]);
    const sent = h.fake.messages();
    expect(sent).toHaveLength(4);
    const messages = (sent[3] as RecordedRequest).body.messages;
    expect(historyProblems(messages)).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("conversation-summary");
  });

  test("too much to serialize: compact_too_large, nothing sent or stored for it", async () => {
    // An 8,000-token summary leaves 8,500 − 8,000 = 500 estimated tokens for the whole prompt.
    const h = await setup({ compact_max_output_tokens: 8000 });
    const convId = await seed(h, 2, OVER_LINE);
    h.fake.reply(text("reply"));
    expect(ended(await run(h, "next", convId)).state).toBe("completed");
    expect(h.fake.messages()).toHaveLength(3);
    expect(turnsOf(h, convId).map((t) => t.kind)).toEqual(["chat", "chat", "chat"]);
    expect(h.frontend.events).toContainEqual({
      type: "notice",
      code: "compact_failed",
      data: { reason: "compact_too_large" },
    });
  });

  test("over the daily cap the compaction is refused and writes nothing", async () => {
    const h = await setup();
    const convId = await seed(h, 2, OVER_LINE);
    // Re-read at the next turn; the two seeded turns already spent about 0.0009 USD today.
    writeFileSync(h.paths.configFile, configWith({ ...BASE, daily_cap_usd: 0.001 }));
    const before = rowCounts(h);
    const out = await run(h, "next", convId);
    expect(h.frontend.events).toContainEqual({
      type: "notice",
      code: "compact_failed",
      data: { reason: "daily_cap" },
    });
    // The turn went on to its own reservation, which the same cap refuses.
    expect(out).toMatchObject({ kind: "rejected", reason: "daily_cap" });
    expect(rowCounts(h)).toEqual(before);
    expect(h.fake.messages()).toHaveLength(2);
  });

  test("aborting the automatic compaction drops the message", async () => {
    const h = await setup();
    const convId = await seed(h, 2, OVER_LINE);
    h.fake.reply({ kind: "hang" });
    const ctl = new AbortController();
    abortAt(h, 3, ctl);
    const out = await run(h, "dropped message", convId, ctl.signal);
    expect(out).toMatchObject({ kind: "rejected", reason: "aborted" });

    const turns = turnsOf(h, convId);
    expect(turns.map((t) => [t.kind, t.state])).toEqual([
      ["chat", "completed"],
      ["chat", "completed"],
      ["compaction", "aborted"],
    ]);
    expect(firstUsage(h, turns[2]?.id as string).state).toBe("estimated");
    expect(compactions(h, convId)).toEqual([]);
    expect(JSON.stringify(readItems(h.db, convId))).not.toContain("dropped message");
  });

  test("still past the hard stop after compacting: conv_too_long", async () => {
    const h = await setup();
    // The second turn is too big to fit once its own reply is counted, and it is the part kept.
    h.fake.reply(answer());
    const convId = ended(await run(h, `${U}0`)).convId;
    h.fake.reply(answer(OVER_LINE));
    ended(await run(h, "w".repeat(12000), convId));
    h.fake.reply(summaryReply());
    const out = await run(h, "next", convId);
    expect(out).toMatchObject({ kind: "rejected", reason: "conv_too_long" });
    expect(compactions(h, convId)).toHaveLength(1);
    expect(turnsOf(h, convId).map((t) => t.kind)).toEqual(["chat", "chat", "compaction"]);
  });
});

describe("the summary request", () => {
  test("has no tools, no effort, no cache breakpoint, and turns thinking off", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    h.fake.reply(summaryReply());
    expect((await compact(h, convId)).kind).toBe("compacted");

    const body = (h.fake.messages()[2] as RecordedRequest).body;
    expect(body.tools).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toEqual([{ type: "text", text: SUMMARIZATION_SYSTEM }]);
    const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("cache_control");

    const prompt = promptOf(h.fake.messages()[2] as RecordedRequest);
    expect(prompt.startsWith("<conversation>\n")).toBe(true);
    expect(prompt).toContain(`role=user>\n${U}0\n</message>`);
    expect(prompt).not.toContain(`${U}1`);
    expect(prompt).not.toContain("<previous-summary>");
    expect(prompt.endsWith(SUMMARIZATION_PROMPT)).toBe(true);
  });

  test("sends no thinking parameter when the model cannot turn thinking off", async () => {
    const h = await setup({}, { thinkingTypes: ["adaptive"] });
    const convId = await seed(h, 2);
    h.fake.reply(summaryReply());
    expect((await compact(h, convId)).kind).toBe("compacted");
    expect((h.fake.messages()[2] as RecordedRequest).body.thinking).toBeUndefined();
  });

  test("a manual focus ends the prompt", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    h.fake.reply(summaryReply());
    await compact(h, convId, "  keep the weather numbers  ");
    expect(promptOf(h.fake.messages()[2] as RecordedRequest)).toEndWith(
      `${SUMMARIZATION_PROMPT}\n\nAdditional focus: keep the weather numbers`,
    );
  });
});

describe("after a compaction", () => {
  test("the request state is reset, not set from the summary request's input", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    expect(conversation(h, convId).last_total_input_tokens).toBe(100);
    h.fake.reply(summaryReply("", 5000));
    const out = await compact(h, convId);
    if (out.kind !== "compacted") throw new Error(out.kind);
    expect(conversation(h, convId)).toEqual({
      last_total_input_tokens: 0,
      last_request_at: null,
      last_prefix_key: null,
    });
    const usage = firstUsage(h, out.item.turnId);
    expect(usage.state).toBe("final");
    expect(usage.uncached_input_tokens).toBe(5000);
  });

  test("the next reservation is cold and estimated from the compacted prompt", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    h.fake.reply(summaryReply());
    await compact(h, convId);

    const system = buildSystem(await loadBoot(h.paths), (await loadSkillIndex(h.paths)).skills);
    const pending: ContextItem = {
      seq: Number.MAX_SAFE_INTEGER,
      turnId: "",
      step: 0,
      kind: "user",
      body: { text: "next" },
    };
    const history = [...buildActiveHistory(readActiveItems(h.db, convId)), pending];
    const fullBytes =
      utf8Bytes(JSON.stringify(TOOL_SPECS)) +
      system.reduce((n, b) => n + utf8Bytes(b.text), 0) +
      history.reduce((n, i) => n + sentBytes(i, DEFAULT_LIMITS.tool_result_bytes), 0);
    const est = estimateInput({ fullBytes, newBytes: 0, lastTotal: 0 });
    // Fresh input at the dearer of input (3) and cache write (3.75); 16,000 output tokens at 15.
    const expected = (est * 3.75) / 1e6 + (16000 * 15) / 1e6;

    h.fake.reply(text("reply"));
    const out = ended(await run(h, "next", convId));
    expect(firstUsage(h, out.turnId).reserved_usd).toBeCloseTo(expected, 12);
  });

  test("earlier items stay byte for byte the same", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    const rows = () =>
      h.db.query("SELECT * FROM items WHERE conv_id = ? ORDER BY seq").all(convId) as {
        seq: number;
      }[];
    const before = rows();
    h.fake.reply(summaryReply());
    await compact(h, convId);
    const after = rows();
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  test("a second compaction updates the first summary; a third right after is skipped", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    h.fake.reply(summaryReply("FIRST"));
    expect((await compact(h, convId)).kind).toBe("compacted");
    h.fake.reply(answer());
    ended(await run(h, `${U}2`, convId));
    h.fake.reply(summaryReply("SECOND"));
    expect((await compact(h, convId)).kind).toBe("compacted");

    const prompt = promptOf(h.fake.messages()[4] as RecordedRequest);
    expect(prompt).toContain(`<previous-summary>\n${summaryText("FIRST")}\n</previous-summary>`);
    expect(prompt.endsWith(UPDATE_SUMMARIZATION_PROMPT)).toBe(true);
    // Only the items between the two cut points.
    expect(prompt).toContain(`${U}1`);
    expect(prompt).not.toContain(`${U}0`);
    expect(prompt).not.toContain(`${U}2`);

    const counts = rowCounts(h);
    expect(await compact(h, convId)).toEqual({ kind: "skipped" });
    expect(rowCounts(h)).toEqual(counts);
    expect(h.fake.messages()).toHaveLength(5);
    // Only the latest summary reaches the model.
    h.fake.reply(text("reply"));
    ended(await run(h, "next", convId));
    const last = JSON.stringify((h.fake.messages()[5] as RecordedRequest).body.messages);
    expect(last).toContain("goal SECOND");
    expect(last).not.toContain("goal FIRST");
  });

  test("a compaction turn may cost more than turn_cap_usd", async () => {
    // A 20,000-token window leaves room for a 4,096-token summary of the seeded turn.
    const h = await setup({
      max_input_tokens: 20000,
      turn_cap_usd: 0.05,
      compact_max_output_tokens: 4096,
    });
    const convId = await seed(h, 2);
    h.fake.reply(summaryReply("", 20000));
    const out = await compact(h, convId);
    if (out.kind !== "compacted") throw new Error(JSON.stringify(out));
    // 4,096 × 15 / 1e6 alone is 0.061 USD, over the cap a chat turn is held to.
    expect(firstUsage(h, out.item.turnId).reserved_usd).toBeGreaterThan(0.05);
    expect(out.costUsd).toBeGreaterThan(0.05);
    expect(turnsOf(h, convId)[2]).toMatchObject({ kind: "compaction", state: "completed" });
  });

  test("a compaction turn left running is settled by reconcile without a summary", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    // What step 5 of a compaction commits before a killed tars could write anything else.
    const turnId = newId();
    const now = h.clock.now();
    const resolved = resolve(
      await loadCatalog(h.paths),
      "anthropic",
      MODEL_ID,
      DEFAULT_LIMITS,
      now,
    );
    if (!resolved.ok) throw new Error(resolved.message);
    beginTurn(h.db, { id: turnId, convId, kind: "compaction", effort: null, now: now.getTime() });
    insertReserved(h.db, {
      turnId,
      convId,
      step: 1,
      attempt: 1,
      model: resolved.model,
      cacheTtl: "5m",
      maxTokens: 1024,
      inputUsd: 0.01,
      now,
    });
    addTurnRequest(h.db, turnId);

    reconcile(h.db, now, () => {});
    expect(turnsOf(h, convId)[2]).toMatchObject({ kind: "compaction", state: "interrupted" });
    expect(firstUsage(h, turnId).state).toBe("estimated");
    expect(compactions(h, convId)).toEqual([]);

    h.fake.reply(text("reply"));
    expect(ended(await run(h, "next", convId)).state).toBe("completed");
    const messages = (h.fake.messages()[2] as RecordedRequest).body.messages;
    expect(historyProblems(messages)).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("conversation-summary");
  });

  test("every way a turn ends keeps the next request valid", async () => {
    const h = await setup();
    const convId = await seed(h, 2);
    h.fake.reply(summaryReply());
    await compact(h, convId);

    const endings: { reply: FakeReply[]; state: string; abort?: boolean }[] = [
      {
        reply: [toolUse("t1", "skill_load", { name: "demo" }, "reading"), text("ok")],
        state: "completed",
      },
      {
        reply: [{ kind: "http_error", status: 400, type: "invalid_request_error" }],
        state: "failed",
      },
      {
        reply: [{ kind: "disconnect", blocks: [{ type: "text", text: "partial" }] }],
        state: "failed",
      },
      { reply: [{ kind: "hang" }], state: "aborted", abort: true },
      {
        reply: [
          {
            kind: "message",
            blocks: [
              { type: "text", text: "cut" },
              { type: "tool_use", id: "t2", name: "tars", input: { argv: ["cost"] } },
            ],
            stop: "max_tokens",
          },
        ],
        state: "completed",
      },
      {
        reply: [toolUse("t3", "tars", { argv: ["memory", "remember", "x"] }), text("ok")],
        state: "completed",
      },
      { reply: [text("last")], state: "completed" },
    ];
    for (const [i, ending] of endings.entries()) {
      h.fake.reply(...ending.reply);
      const ctl = new AbortController();
      if (ending.abort === true) abortAt(h, h.fake.messages().length + 1, ctl);
      const out = ended(await run(h, `message ${i}`, convId, ctl.signal));
      expect(out.state as string).toBe(ending.state);
    }

    const chats = h.fake.messages().slice(3);
    expect(chats.length).toBeGreaterThanOrEqual(endings.length);
    for (const r of chats) {
      expect(historyProblems(r.body.messages)).toEqual([]);
      expect(promptOf(r).startsWith(SUMMARY_PREFIX)).toBe(true);
    }
  });
});

describe("thresholds and sizes", () => {
  test("with the default ratios a message at 72% compacts first instead of stopping", async () => {
    const h = await setup({ context_warn_ratio: 0.6, context_compact_ratio: 0.75 });
    const convId = await seed(h, 3, 7200);
    h.fake.reply(summaryReply("x"), answer());
    const out = ended(await run(h, "short", convId));
    expect(out.state).toBe("completed");
    expect(h.fake.messages().filter(isSummary)).toHaveLength(1);
    expect(compactions(h, convId)).toHaveLength(1);
  });

  test("when that compaction fails the message is stopped, and nothing promised it", async () => {
    const h = await setup({ context_warn_ratio: 0.6, context_compact_ratio: 0.75 });
    const convId = await seed(h, 3, 7200);
    h.fake.reply(text("not a summary"));
    const out = await run(h, "short", convId);
    expect(out).toMatchObject({ kind: "rejected", reason: "conv_too_long" });
    expect(h.frontend.events).toContainEqual({
      type: "notice",
      code: "compact_failed",
      data: { reason: "compact_bad_summary" },
    });
    expect(h.fake.messages().filter((r) => !isSummary(r))).toHaveLength(3);
  });

  test("a long previous summary counts: compact_too_large, nothing sent, history unchanged", async () => {
    // A summary prompt gets 17,000 − 8,000 = 9,000 estimated tokens, about 15,000 bytes; a chat
    // request gets 17,000. A 16,000-byte summary fits the chat but not the next summary prompt.
    const h = await setup({ max_input_tokens: 20000, compact_max_output_tokens: 8000 });
    const convId = await seed(h, 3);
    const big = SUMMARY_HEADINGS.map((h, i) => `## ${h}\n- ${i === 0 ? "g".repeat(16000) : "-"}`);
    h.fake.reply({ kind: "message", blocks: [{ type: "text", text: big.join("\n\n") }] });
    expect((await compact(h, convId)).kind).toBe("compacted");
    for (let i = 0; i < 2; i++) {
      h.fake.reply(answer());
      ended(await run(h, U + i, convId));
    }
    const sent = h.fake.messages().length;
    const before = readItems(h.db, convId);
    expect(await compact(h, convId)).toMatchObject({ kind: "failed", reason: "compact_too_large" });
    expect(h.fake.messages()).toHaveLength(sent);
    expect(readItems(h.db, convId)).toEqual(before);
  });

  test("turns kept by a compaction are replayed without their thinking", async () => {
    const h = await setup();
    let convId: string | undefined;
    for (let i = 0; i < 3; i++) {
      h.fake.reply({
        kind: "message",
        blocks: [
          { type: "thinking", thinking: "", signature: `sig-${i}` },
          { type: "text", text: A },
        ],
      });
      convId = ended(await run(h, U + i, convId)).convId;
    }
    h.fake.reply(summaryReply());
    expect((await compact(h, convId as string)).kind).toBe("compacted");
    h.fake.reply(answer());
    ended(await run(h, "after", convId));
    const body = JSON.stringify(h.fake.messages().at(-1)?.body.messages);
    expect(body).toContain(A);
    expect(body).not.toContain("sig-");
  });
});

describe("a changed prefix", () => {
  test("a larger SOUL.md is counted: the turn compacts, then stops instead of going out", async () => {
    const h = await setup();
    // The last request measured 100 tokens; the new SOUL.md alone is about 12,000 estimated.
    const convId = await seed(h, 3);
    writeFileSync(h.paths.soul, `# Soul\n${"s".repeat(20000)}\n`);
    h.fake.reply(summaryReply());
    const out = await run(h, "short", convId);
    expect(out).toMatchObject({ kind: "rejected", reason: "conv_too_long" });
    expect(h.fake.messages().filter(isSummary)).toHaveLength(1);
    expect(h.fake.messages().filter((r) => !isSummary(r))).toHaveLength(3);
  });

  test("a larger tool_result_bytes is counted: old tool results replay larger", async () => {
    // A tool whose output is kept whole and cut only when sent.
    const big = join(tempHome(), "fake-tars");
    writeFileSync(big, `#!/bin/sh\nhead -c 40000 /dev/zero | tr '\\0' d\n`, { mode: 0o755 });
    const h = await setup({ tool_result_bytes: 1024 }, {}, { selfCommand: [big] });
    h.fake.reply(toolUse("t1", "tars", { argv: ["script", "list"] }), answer());
    const convId = ended(await run(h, "list them")).convId;
    // Measured at 100 tokens with the result cut to 1,024 bytes; at 22,000 it is over the line.
    writeFileSync(h.paths.configFile, configWith({ ...BASE, tool_result_bytes: 22000 }));
    h.fake.reply(answer());
    const sent = h.fake.messages().length;
    expect(await run(h, "short", convId)).toMatchObject({
      kind: "rejected",
      reason: "conv_too_long",
    });
    expect(
      h.fake
        .messages()
        .slice(sent)
        .filter((r) => !isSummary(r)),
    ).toHaveLength(0);
  });

  test("the same prefix keeps using the measured total", async () => {
    const h = await setup();
    const convId = await seed(h, 3);
    h.fake.reply(answer());
    expect(ended(await run(h, "short", convId)).state).toBe("completed");
    expect(h.fake.messages().filter(isSummary)).toHaveLength(0);
  });
});
