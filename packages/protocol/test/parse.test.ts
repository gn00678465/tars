import { describe, expect, test } from "bun:test";
import {
  ARGV_ITEMS,
  checkClient,
  COMPACT_FOCUS_CHARS,
  DATA_KEYS,
  FRAME_BYTES,
  EFFORT_LEVELS,
  EFFORT_NAME,
  KEEP_LAST,
  MESSAGE_BYTES,
  MODELS,
  parseClient,
  parseFrame,
  parseRelayFrame,
  parseServer,
  PRICE_WARNS,
  SKILL_TEXT,
  SKILLS,
  skillInvocationText,
  SNAPSHOT_ITEMS,
  TEXT_BYTES,
  UI_CHOICES,
  UI_KEY,
  UI_VALUE,
  type Parsed,
} from "../src/index.ts";
import { CLIENT, CONN, context, ID, ITEMS, msg, SERVER, status } from "./fixtures.ts";

const reason = (r: Parsed<unknown>) => (r.ok ? "ok" : r.reason);
const submit = (text: string) => JSON.stringify(msg("turn.submit", { requestId: ID, text }));

describe("limits", () => {
  test("over MESSAGE_BYTES is refused before it is parsed", () => {
    const huge = "x".repeat(MESSAGE_BYTES + 1);
    // Not JSON at all: refused for its size, not for its syntax.
    expect(reason(parseClient(huge))).toBe("too_large");
    expect(reason(parseServer(huge))).toBe("too_large");
    // Multi-byte text that is short in UTF-16 units but long in bytes.
    expect(reason(parseClient("中".repeat(MESSAGE_BYTES / 3 + 1)))).toBe("too_large");
  });

  test("a frame may carry a message at MESSAGE_BYTES; over FRAME_BYTES is refused", () => {
    const pad = MESSAGE_BYTES - JSON.stringify(msg("hello", {}, { re: "" })).length;
    const m = msg("hello", {}, { re: "" });
    const atLimit = JSON.stringify({ t: "msg", conn: CONN, m: { ...m, pad: "x".repeat(pad) } });
    expect(atLimit.length).toBeGreaterThan(MESSAGE_BYTES);
    expect(reason(parseFrame(atLimit))).toBe("ok");
    expect(reason(parseFrame("x".repeat(FRAME_BYTES + 1)))).toBe("too_large");
    expect(reason(parseRelayFrame("x".repeat(FRAME_BYTES + 1)))).toBe("too_large");
  });

  test("turn.submit's text: TEXT_BYTES in bytes, not characters", () => {
    expect(reason(parseClient(submit("x".repeat(TEXT_BYTES))))).toBe("ok");
    expect(reason(parseClient(submit("x".repeat(TEXT_BYTES + 1))))).toBe("bad_message");
    expect(reason(parseClient(submit("中".repeat(TEXT_BYTES / 3 + 1))))).toBe("too_large");
    expect(reason(parseClient(submit("")))).toBe("bad_message");
  });

  test("too many items, too long an argv, too long a string", () => {
    const items = Array.from({ length: SNAPSHOT_ITEMS + 1 }, () => ITEMS.user);
    const snap = SERVER["conv.snapshot"] as { p: Record<string, unknown> };
    expect(reason(parseServer(JSON.stringify({ ...snap, p: { ...snap.p, items } })))).toBe(
      "bad_message",
    );
    const req = SERVER["approval.request"] as { p: { approval: Record<string, unknown> } };
    const withArgv = (argv: string[]) =>
      JSON.stringify({ ...req, p: { approval: { ...req.p.approval, argv } } });
    expect(reason(parseServer(withArgv(Array(ARGV_ITEMS).fill("a"))))).toBe("ok");
    expect(reason(parseServer(withArgv(Array(ARGV_ITEMS + 1).fill("a"))))).toBe("bad_message");
    expect(reason(parseServer(withArgv(["a".repeat(4097)])))).toBe("bad_message");
    expect(reason(parseClient(JSON.stringify({ ...CLIENT.hello, id: "x".repeat(65) })))).toBe(
      "bad_message",
    );
  });
});

describe("an approval's tool call", () => {
  test("callId is optional: a card with it and one without both parse", () => {
    const req = SERVER["approval.request"] as { p: { approval: Record<string, unknown> } };
    const withCall = (approval: Record<string, unknown>) =>
      JSON.stringify({ ...req, p: { approval } });
    expect(reason(parseServer(withCall({ ...req.p.approval, callId: ID })))).toBe("ok");
    expect(reason(parseServer(withCall(req.p.approval)))).toBe("ok");
    expect(reason(parseServer(withCall({ ...req.p.approval, callId: "x".repeat(65) })))).toBe(
      "bad_message",
    );
  });
});

describe("an A2UI form: ui.submit and the user item's uiCall", () => {
  const form = CLIENT["ui.submit"] as { conv: string; p: Record<string, unknown> };
  const withContext = (context: unknown) =>
    parseClient(JSON.stringify({ ...form, p: { ...form.p, context } }));

  test("ui.submit needs conv: a form is in a conversation", () => {
    const { conv: _, ...noConv } = form;
    expect(reason(parseClient(JSON.stringify(noConv)))).toBe("bad_message");
  });

  test("context: strings and short lists of them, within the limits", () => {
    expect(reason(withContext({}))).toBe("ok");
    expect(reason(withContext({ a: "x".repeat(UI_VALUE) }))).toBe("ok");
    expect(reason(withContext({ a: Array(UI_CHOICES).fill("x") }))).toBe("ok");
    for (const bad of [
      { a: "x".repeat(UI_VALUE + 1) },
      { a: Array(UI_CHOICES + 1).fill("x") },
      { ["k".repeat(UI_KEY + 1)]: "x" },
      { "": "x" },
      { a: 1 },
      { a: { "@path": "/a" } },
      Object.fromEntries(Array.from({ length: DATA_KEYS + 1 }, (_, i) => [`k${i}`, "x"])),
    ])
      expect(reason(withContext(bad))).toBe("bad_message");
  });

  test("uiCall is optional on a user item and only there", () => {
    const item = (body: Record<string, unknown>) =>
      parseServer(JSON.stringify(msg("item", { item: body }, { conv: ID })));
    expect(reason(item(ITEMS.user))).toBe("ok");
    expect(reason(item({ ...ITEMS.user, uiCall: ID }))).toBe("ok");
    expect(reason(item({ ...ITEMS.user, uiCall: "x".repeat(65) }))).toBe("bad_message");
    expect(reason(item({ ...ITEMS.assistant, uiCall: ID }))).toBe("bad_message");
  });
});

describe("status's skills and certificate expiry", () => {
  test("both optional; a description longer than SKILL_TEXT is refused", () => {
    const st = SERVER.status as { p: Record<string, unknown> };
    const withP = (extra: Record<string, unknown>) =>
      JSON.stringify({ ...st, p: { ...st.p, ...extra } });
    const skill = { name: "demo", description: "示範", localOnly: false };
    expect(reason(parseServer(withP({})))).toBe("ok");
    expect(reason(parseServer(withP({ skills: [skill], certExpiresAt: 1 })))).toBe("ok");
    expect(
      reason(
        parseServer(withP({ skills: [{ ...skill, description: "x".repeat(SKILL_TEXT + 1) }] })),
      ),
    ).toBe("bad_message");
    expect(reason(parseServer(withP({ skills: Array(SKILLS + 1).fill(skill) })))).toBe(
      "bad_message",
    );
  });

  test("skillInvocationText is one wording for the terminal and the page", () => {
    expect(skillInvocationText("demo", "")).toBe(
      "請用 skill「demo」處理下面的內容。先用 skill_load 讀它。",
    );
    expect(skillInvocationText("demo", "內容")).toBe(
      "請用 skill「demo」處理下面的內容。先用 skill_load 讀它。\n\n內容",
    );
  });
});

describe("turn.submit's model, from and keepLast; models.result", () => {
  const with_ = (extra: Record<string, unknown>) =>
    JSON.stringify(msg("turn.submit", { requestId: ID, text: "hi", ...extra }));
  const model = { provider: "gemini", id: "g" };

  test("all three optional: a new conversation on a model, a continuation, the last turns only", () => {
    expect(reason(parseClient(with_({})))).toBe("ok");
    expect(reason(parseClient(with_({ model })))).toBe("ok");
    expect(reason(parseClient(with_({ model, from: ID })))).toBe("ok");
    expect(reason(parseClient(with_({ model, from: ID, keepLast: KEEP_LAST })))).toBe("ok");
  });

  test("from without model, keepLast without from, keepLast out of range, a key no one knows", () => {
    expect(reason(parseClient(with_({ from: ID })))).toBe("bad_message");
    expect(reason(parseClient(with_({ model, keepLast: 3 })))).toBe("bad_message");
    for (const keepLast of [0, -1, 1.5, KEEP_LAST + 1])
      expect(reason(parseClient(with_({ model, from: ID, keepLast })))).toBe("bad_message");
    expect(reason(parseClient(with_({ model: { ...model, effort: "high" } })))).toBe("bad_message");
  });

  test("models.result: window and unusable optional; at most MODELS", () => {
    const one = { provider: "anthropic", id: "m", label: "M", isDefault: false };
    const result = (models: unknown[]) => JSON.stringify(msg("models.result", { models }));
    expect(reason(parseServer(result([one])))).toBe("ok");
    expect(reason(parseServer(result([{ ...one, window: 0 }])))).toBe("bad_message");
    expect(reason(parseServer(result(Array(MODELS + 1).fill(one))))).toBe("bad_message");
  });
});

describe("effort: turn.submit's, models.result's levels, a conversation's", () => {
  const submit = (extra: Record<string, unknown>) =>
    JSON.stringify(msg("turn.submit", { requestId: ID, text: "hi", ...extra }));
  const one = { provider: "anthropic", id: "m", label: "M", isDefault: true };
  const result = (extra: Record<string, unknown>) =>
    JSON.stringify(msg("models.result", { models: [{ ...one, ...extra }] }));
  const conv = (extra: Record<string, unknown>) =>
    JSON.stringify(
      msg("conv.list.result", {
        convs: [{ id: ID, title: "t", provider: "anthropic", model: "m", updatedAt: 1, ...extra }],
      }),
    );

  test("turn.submit: on its own, with a conversation, with a new model; a name, not an empty one", () => {
    expect(reason(parseClient(submit({ effort: "high" })))).toBe("ok");
    expect(
      reason(
        parseClient(
          JSON.stringify({
            ...msg("turn.submit", { requestId: ID, text: "hi", effort: "low" }),
            conv: ID,
          }),
        ),
      ),
    ).toBe("ok");
    expect(
      reason(parseClient(submit({ model: { provider: "gemini", id: "g" }, effort: "low" }))),
    ).toBe("ok");
    // A level a newer local end knows is still a message; the local end judges it.
    expect(reason(parseClient(submit({ effort: "ultra" })))).toBe("ok");
    expect(reason(parseClient(submit({ effort: "" })))).toBe("bad_message");
    expect(reason(parseClient(submit({ effort: "x".repeat(EFFORT_NAME + 1) })))).toBe(
      "bad_message",
    );
    expect(reason(parseClient(submit({ effort: 2 })))).toBe("bad_message");
  });

  test("models.result: levels and the default optional, an empty list allowed, at most EFFORT_LEVELS", () => {
    expect(reason(parseServer(result({})))).toBe("ok");
    expect(reason(parseServer(result({ effortLevels: [] })))).toBe("ok");
    expect(
      reason(parseServer(result({ effortLevels: ["low", "max"], defaultEffort: "low" }))),
    ).toBe("ok");
    expect(
      reason(parseServer(result({ effortLevels: Array(EFFORT_LEVELS + 1).fill("low") }))),
    ).toBe("bad_message");
    expect(reason(parseServer(result({ effortLevels: [""] })))).toBe("bad_message");
  });

  test("a conversation's effort is optional", () => {
    expect(reason(parseServer(conv({})))).toBe("ok");
    expect(reason(parseServer(conv({ effort: "medium" })))).toBe("ok");
    expect(reason(parseServer(conv({ effort: 1 })))).toBe("bad_message");
  });
});

describe("not a message", () => {
  test.each([
    ["not JSON", "{nope"],
    ["an array", "[1]"],
    ["a string", '"hello"'],
    ["null", "null"],
    ["a number", "1"],
  ])("%s", (_, raw) => {
    for (const parse of [parseClient, parseServer, parseFrame, parseRelayFrame])
      expect(reason(parse(raw))).toBe("bad_message");
  });

  test("v that is not 1 is a version mismatch, for either side", () => {
    for (const v of [2, 0, "1", undefined]) {
      expect(reason(parseClient(JSON.stringify({ ...CLIENT.hello, v })))).toBe("version");
      expect(reason(parseServer(JSON.stringify({ ...SERVER.ack, v })))).toBe("version");
    }
  });
});

test("no parse function throws, whatever it is given", () => {
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  const deepObject = `{"v":1,"m":${deep.slice(0, 100_000)}`;
  const inputs: unknown[] = [
    "",
    deep,
    deepObject,
    "\u0000",
    '{"__proto__":{"v":1}}',
    '{"v":1,"id":"x","kind":"hello","p":{},"constructor":1}',
    undefined,
    null,
    42,
  ];
  for (const raw of inputs)
    for (const parse of [parseClient, parseServer, parseFrame, parseRelayFrame])
      expect(() => parse(raw as string)).not.toThrow();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(reason(checkClient(cyclic))).toBe("bad_message");
  expect(reason(checkClient(undefined))).toBe("bad_message");
  expect(reason(checkClient(BigInt(1)))).toBe("bad_message");
});

test("checkClient: a frame's m checked like a raw message", () => {
  expect(reason(checkClient(CLIENT.hello))).toBe("ok");
  expect(reason(checkClient({ ...CLIENT.hello, v: 2 }))).toBe("version");
  expect(reason(checkClient({ ...CLIENT.hello, extra: 1 }))).toBe("bad_message");
});

describe("batch 4: every new field optional, each bounded", () => {
  const server = (kind: string, p: object, extra: object = {}) =>
    reason(parseServer(JSON.stringify(msg(kind, p, extra))));
  const item = (it: object) => server("item", { item: it }, { conv: ID });

  test("usage: cache read, thinking and effort; counts are whole and not negative", () => {
    expect(item({ ...ITEMS.usage, cacheReadTokens: 0, thinkingTokens: 92, effort: "medium" })).toBe(
      "ok",
    );
    expect(item({ ...ITEMS.usage, cacheReadTokens: -1 })).toBe("bad_message");
    expect(item({ ...ITEMS.usage, thinkingTokens: 1.5 })).toBe("bad_message");
    expect(item({ ...ITEMS.usage, effort: "" })).toBe("bad_message");
  });

  test("tool_result: duration and why it was refused; an unknown reason is refused", () => {
    expect(item({ ...ITEMS.tool_result, durationMs: 840 })).toBe("ok");
    for (const refusal of ["not_offered", "changed", "budget"])
      expect(item({ ...ITEMS.tool_result, status: "refused", refusal })).toBe("ok");
    expect(item({ ...ITEMS.tool_result, refusal: "other" })).toBe("bad_message");
    expect(item({ ...ITEMS.tool_result, durationMs: -1 })).toBe("bad_message");
  });

  test("error and turn data: strings and numbers, at most DATA_KEYS keys, no nesting", () => {
    const data = { provider: "anthropic", spentUsd: 95.1, stopUsd: 95 };
    expect(item({ ...ITEMS.error, data })).toBe("ok");
    const many = Object.fromEntries(Array.from({ length: DATA_KEYS + 1 }, (_, i) => [`k${i}`, i]));
    expect(item({ ...ITEMS.error, data: many })).toBe("bad_message");
    expect(item({ ...ITEMS.error, data: { nested: { a: 1 } } })).toBe("bad_message");
    expect(item({ ...ITEMS.error, data: { s: "x".repeat(257) } })).toBe("bad_message");
    expect(server("turn", { turn: ID, state: "failed", reason: "daily_cap", data })).toBe("ok");
    expect(server("turn", { turn: ID, state: "interrupted" })).toBe("ok");
    expect(server("compact", { state: "failed", reason: "budget_stopped", data })).toBe("ok");
    expect(server("compact", { state: "paused" })).toBe("bad_message");
  });

  test("compaction: when, why, how much; all optional", () => {
    expect(item(ITEMS.compaction)).toBe("ok");
    expect(
      item({
        ...ITEMS.compaction,
        at: 1,
        trigger: "manual",
        beforeTokens: 152_400,
        keptTokens: 20_000,
        count: 14,
        costUsd: 0.004,
        firstKeptSeq: 30,
      }),
    ).toBe("ok");
    expect(item({ ...ITEMS.compaction, trigger: "cron" })).toBe("bad_message");
  });

  test("a turn's phase: one of four, as its own message and in a snapshot's running turn", () => {
    expect(server("turn.phase", { turn: ID, phase: "waiting_approval" }, { conv: ID })).toBe("ok");
    expect(server("turn.phase", { turn: ID, phase: "sleeping" })).toBe("bad_message");
    const snapshot = (running: object) =>
      server("conv.snapshot", { epoch: "ab".repeat(16), items: [], more: false, running });
    expect(snapshot({ turn: ID, text: "", truncated: false, phase: "replying" })).toBe("ok");
    // A compaction has no turn the page knows: it is the snapshot's compacting, not a phase.
    expect(snapshot({ turn: ID, text: "", truncated: false, phase: "compacting" })).toBe(
      "bad_message",
    );
    const bare = { epoch: "ab".repeat(16), items: [], more: false };
    expect(server("conv.snapshot", { ...bare, compacting: true })).toBe("ok");
    expect(server("conv.snapshot", { ...bare, compacting: false })).toBe("bad_message");
  });

  test("approvals: when and which connection decided; already_decided says what", () => {
    const resolved = { approvalId: ID, state: "approved", via: "remote" };
    expect(server("approval.resolved", { ...resolved, at: 1, source: "this" })).toBe("ok");
    expect(server("approval.resolved", { ...resolved, source: "other_device" })).toBe("ok");
    expect(server("approval.resolved", { ...resolved, source: "terminal" })).toBe("bad_message");
    expect(
      server("nack", { reason: "already_decided", state: "denied", source: "other_device" }),
    ).toBe("ok");
    expect(server("nack", { reason: "already_decided", state: "pending" })).toBe("bad_message");
  });

  test("status: period, estimate, the prices to confirm, candidate and retired counts", () => {
    const p = { ...status.providers[0], period: "cumulative", estimated: false };
    const warn = { provider: "anthropic", model: "claude-opus-4-1", ageDays: 34, state: "stale" };
    expect(
      server("status", { ...status, providers: [p], prices: [warn], candidates: 2, retired: 1 }),
    ).toBe("ok");
    expect(server("status", { ...status, providers: [{ ...p, period: "week" }] })).toBe(
      "bad_message",
    );
    expect(
      server("status", { ...status, prices: [{ ...warn, ageDays: undefined, state: "missing" }] }),
    ).toBe("ok");
    expect(server("status", { ...status, prices: Array(PRICE_WARNS + 1).fill(warn) })).toBe(
      "bad_message",
    );
  });

  test("models.result: the read-only table, its total and the list's date", () => {
    const entry = {
      provider: "openrouter",
      id: "deepseek/deepseek-chat",
      label: "DeepSeek",
      status: "candidate",
      price: { input: 0.27, output: 1.1 },
      priceSource: "openrouter",
      pricedAt: "2026-11-19",
    };
    const result = (extra: object) =>
      server("models.result", { models: [], updatedAt: "2026-11-19", ...extra });
    expect(result({ catalog: [entry], catalogTotal: 340 })).toBe("ok");
    expect(result({ catalog: [{ ...entry, status: "beta" }] })).toBe("bad_message");
    expect(result({ catalog: [{ ...entry, price: { input: 1, other: 2 } }] })).toBe("bad_message");
    expect(result({ catalog: Array(MODELS + 1).fill(entry) })).toBe("bad_message");
  });

  test("conv.context: the ratios and the window are required; the cache share is 0 to 100", () => {
    expect(server("conv.context", context, { conv: ID })).toBe("ok");
    expect(server("conv.context", { ...context, cacheHitPct: 101 })).toBe("bad_message");
    // An estimate is marked true; nothing else stands for it.
    expect(server("conv.context", { ...context, estimated: true }, { conv: ID })).toBe("ok");
    expect(server("conv.context", { ...context, estimated: false })).toBe("bad_message");
    expect(server("conv.context", { ...context, contextLimit: 0 })).toBe("bad_message");
  });

  test("conv.compact: needs conv; the focus is optional, not empty, at most COMPACT_FOCUS_CHARS", () => {
    const compact = (p: object, extra: object = { conv: ID }) =>
      reason(parseClient(JSON.stringify(msg("conv.compact", p, extra))));
    expect(compact({})).toBe("ok");
    expect(compact({ focus: "x".repeat(COMPACT_FOCUS_CHARS) })).toBe("ok");
    expect(compact({ focus: "x".repeat(COMPACT_FOCUS_CHARS + 1) })).toBe("bad_message");
    expect(compact({ focus: "" })).toBe("bad_message");
    expect(compact({}, {})).toBe("bad_message");
  });

  test("conv.archive: needs conv and a boolean, nothing else", () => {
    const archive = (p: object, extra: object = { conv: ID }) =>
      reason(parseClient(JSON.stringify(msg("conv.archive", p, extra))));
    expect(archive({ archived: true })).toBe("ok");
    expect(archive({ archived: false })).toBe("ok");
    expect(archive({})).toBe("bad_message");
    expect(archive({ archived: "yes" })).toBe("bad_message");
    expect(archive({ archived: true, extra: 1 })).toBe("bad_message");
    expect(archive({ archived: true }, {})).toBe("bad_message");
  });

  test("the new nacks and status.archive parse; status.archive is only true", () => {
    expect(server("nack", { reason: "conv_archived" })).toBe("ok");
    expect(server("nack", { reason: "conv_active" })).toBe("ok");
    expect(server("status", { ...status, archive: true })).toBe("ok");
    expect(server("status", { ...status, archive: false })).toBe("bad_message");
  });
});
