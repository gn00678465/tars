import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AnthropicError, APIConnectionError } from "@anthropic-ai/sdk";
import {
  createAnthropicAdapter,
  requestBody,
  toMessages,
  toProviderError,
} from "../../../src/features/agent/anthropic.ts";
import { ProviderError } from "../../../src/features/agent/provider.ts";
import type {
  Item,
  ModelRequest,
  ProviderEvent,
  ToolCallEndState,
} from "../../../src/features/agent/types.ts";
import {
  capabilities,
  startFakeAnthropic,
  text,
  toolUse,
  type FakeAnthropic,
  type FakeReply,
} from "../../fakes/anthropic.ts";

// --- Items.
const user = (seq: number, t: string): Item => ({
  seq,
  turnId: "t",
  step: 0,
  kind: "user",
  body: { text: t },
});
const KEY = "key-now";
const assistant = (
  seq: number,
  t: string,
  native: unknown[] | null = [{ type: "text", text: t }],
  thinkingKey = KEY,
): Item => ({
  seq,
  turnId: "t",
  step: 1,
  kind: "assistant",
  body: { text: t, state: native === null ? "aborted" : "complete", native, thinkingKey },
});
const toolCall = (seq: number, callId: string, providerCallId: string): Item => ({
  seq,
  turnId: "t",
  step: 1,
  kind: "tool_call",
  body: { callId, providerCallId, name: "tars", input: { argv: ["cost"] } },
});
const toolResult = (
  seq: number,
  callId: string,
  status: ToolCallEndState = "done",
  t = "ok",
): Item => ({
  seq,
  turnId: "t",
  step: 1,
  kind: "tool_result",
  body: { callId, status, text: t, truncated: false },
});
const toolUseBlock = (id: string) => ({
  type: "tool_use",
  id,
  name: "tars",
  input: { argv: ["cost"] },
});

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "model-a",
    maxOutputTokens: 1024,
    system: [
      { text: "preamble", cache: false },
      { text: "soul", cache: true },
      { text: "memory", cache: true },
    ],
    tools: [
      { name: "tars", description: "run tars", inputSchema: { type: "object", properties: {} } },
    ],
    history: [user(1, "hi")],
    cacheTtl: "5m",
    cacheHistory: true,
    toolResultBytes: 16384,
    thinkingKey: KEY,
    capabilities: { thinkingTypes: ["adaptive", "disabled"], effortLevels: [] },
    ...overrides,
  };
}

/** toMessages typed loosely, so plain object literals can be compared with it. */
const messagesOf = (...args: Parameters<typeof toMessages>): unknown => toMessages(...args);

describe("history to messages", () => {
  test("a user item is one text block; an assistant with native replays it", () => {
    const native = [{ type: "text", text: "hello", citations: null }];
    expect(
      messagesOf([user(1, "hi"), assistant(2, "hello", native), user(3, "next")], 16384, null, KEY),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: native },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
  });

  test("an assistant without native is its text, and is skipped when the text is empty", () => {
    expect(
      messagesOf([user(1, "a"), assistant(2, "partial", null), user(3, "b")], 16384, null, KEY),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "partial" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ]);
    // A failed turn with no text: the two user messages merge.
    expect(
      messagesOf([user(1, "a"), assistant(2, "", null), user(3, "b")], 16384, null, KEY),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
  });

  test("tool calls come from native; results of one step merge into one user message", () => {
    const native = [{ type: "text", text: "running" }, toolUseBlock("tu_1"), toolUseBlock("tu_2")];
    const messages = toMessages(
      [
        user(1, "go"),
        assistant(2, "running", native),
        toolCall(3, "c1", "tu_1"),
        toolCall(4, "c2", "tu_2"),
        toolResult(5, "c1", "done", "first"),
        toolResult(6, "c2", "refused", "no"),
        user(7, "and then"),
      ],
      16384,
      null,
      KEY,
    );
    expect(messages as unknown).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: native },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "first" },
          { type: "tool_result", tool_use_id: "tu_2", content: "no", is_error: true },
          { type: "text", text: "and then" },
        ],
      },
    ]);
  });

  test("two neighbouring user items, the wiki index and the message, are two blocks of one message", () => {
    const messages = toMessages(
      [user(9, "<wiki-index>…</wiki-index>"), user(10, "hi")],
      16384,
      null,
      KEY,
    );
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "<wiki-index>…</wiki-index>" },
          { type: "text", text: "hi" },
        ],
      },
    ]);
  });

  test("a summary item and the first kept user message merge", () => {
    const messages = toMessages([user(-1, "<summary>"), user(10, "kept")], 16384, null, KEY);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toHaveLength(2);
  });

  test("a result longer than toolResultBytes is cut with a note on its full size", () => {
    const long = "x".repeat(5000);
    const [, , results] = toMessages(
      [
        user(1, "go"),
        assistant(2, "", [toolUseBlock("tu_1")]),
        toolCall(3, "c1", "tu_1"),
        toolResult(4, "c1", "done", long),
      ],
      2000,
      null,
      KEY,
    );
    const content = (results?.content as { content: string }[] | undefined)?.[0]?.content ?? "";
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(2000);
    expect(content).toContain("（已截斷，完整輸出共 5000 位元組）");
  });

  test("the cache mark goes on the last block of the last message, without changing history", () => {
    const native = [{ type: "text", text: "a" }];
    const history = [user(1, "q"), assistant(2, "a", native), user(3, "q2")];
    const messages = toMessages(history, 16384, { type: "ephemeral", ttl: "1h" }, KEY);
    expect(messages.at(-1)?.content).toEqual([
      { type: "text", text: "q2", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(JSON.stringify(messages[1]?.content)).not.toContain("cache_control");
    expect(native).toEqual([{ type: "text", text: "a" }]);
  });
});

describe("thinking under a changed prefix", () => {
  const think = (id: string) => ({ type: "thinking", thinking: "", signature: `sig-${id}` });
  const answer = (seq: number, id: string, key: string) =>
    assistant(seq, id, [think(id), { type: "text", text: id }], key);
  const sent = (history: Item[]) =>
    toMessages(history, 16384, null, KEY)
      .filter((m) => m.role === "assistant")
      .map((m) => (m.content as { type: string }[]).map((b) => b.type).join("+"));

  test("blocks made under the request's key are replayed whole", () => {
    expect(sent([user(1, "a"), answer(2, "x", KEY), user(3, "b"), answer(4, "y", KEY)])).toEqual([
      "thinking+text",
      "thinking+text",
    ]);
  });

  test("a stale block and every thinking block before it go; text and tool use stay", () => {
    const history = [
      user(1, "a"),
      answer(2, "x", KEY),
      user(3, "b"),
      assistant(4, "y", [think("y"), { type: "text", text: "y" }, toolUseBlock("tu_1")], "old"),
      toolCall(5, "c1", "tu_1"),
      toolResult(6, "c1"),
      answer(7, "z", KEY),
    ];
    expect(sent(history)).toEqual(["text", "text+tool_use", "thinking+text"]);
  });

  test("items written before keys existed count as stale", () => {
    const old = assistant(2, "x", [think("x"), { type: "text", text: "x" }]);
    delete (old.body as { thinkingKey?: string }).thinkingKey;
    expect(sent([user(1, "a"), old, user(3, "b"), answer(4, "y", KEY)])).toEqual([
      "text",
      "thinking+text",
    ]);
  });

  test("redacted thinking goes too, and a stale item without thinking changes nothing", () => {
    const redacted = assistant(
      2,
      "x",
      [
        { type: "redacted_thinking", data: "d" },
        { type: "text", text: "x" },
      ],
      "old",
    );
    expect(sent([user(1, "a"), redacted, user(3, "b")])).toEqual(["text"]);
    expect(
      sent([user(1, "a"), answer(2, "x", KEY), user(3, "b"), assistant(4, "t", undefined, "old")]),
    ).toEqual(["thinking+text", "text"]);
  });
});

describe("request body", () => {
  const countMarks = (value: unknown) =>
    (JSON.stringify(value).match(/cache_control/g) ?? []).length;

  test("three breakpoints: SOUL, MEMORY and the last message; none on tools or the preamble", () => {
    const body = requestBody(request({ history: [user(1, "a"), assistant(2, "b"), user(3, "c")] }));
    expect(countMarks(body)).toBe(3);
    expect(countMarks(body.tools)).toBe(0);
    expect(body.system).toEqual([
      { type: "text", text: "preamble" },
      { type: "text", text: "soul", cache_control: { type: "ephemeral", ttl: "5m" } },
      { type: "text", text: "memory", cache_control: { type: "ephemeral", ttl: "5m" } },
    ]);
    expect(countMarks(body.messages.at(-1))).toBe(1);
  });

  test("cacheHistory false leaves the last message unmarked; no tools means no tools key", () => {
    const body = requestBody(
      request({ cacheHistory: false, tools: [], system: [{ text: "s", cache: false }] }),
    );
    expect(countMarks(body)).toBe(0);
    expect("tools" in body).toBe(false);
  });

  test("without an effort there is no output_config and no thinking", () => {
    const body = requestBody(request());
    expect("output_config" in body).toBe(false);
    expect("thinking" in body).toBe(false);
  });

  test("a level sends output_config, and adaptive thinking only when the model has it", () => {
    expect(requestBody(request({ effort: "high" }))).toMatchObject({
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
    });
    const plain = requestBody(
      request({ effort: "low", capabilities: { thinkingTypes: ["disabled"], effortLevels: [] } }),
    );
    expect(plain.output_config).toEqual({ effort: "low" });
    expect("thinking" in plain).toBe(false);
  });

  test('"off" never sends output_config; disabled thinking only when the model has it', () => {
    const off = requestBody(request({ effort: "off" }));
    expect("output_config" in off).toBe(false);
    expect(off.thinking).toEqual({ type: "disabled" });
    const none = requestBody(
      request({ effort: "off", capabilities: { thinkingTypes: ["adaptive"], effortLevels: [] } }),
    );
    expect("thinking" in none).toBe(false);
  });

  test("display and budget_tokens are never sent", () => {
    expect(JSON.stringify(requestBody(request({ effort: "max" })))).not.toMatch(
      /display|budget_tokens/,
    );
  });
});

describe("the adapter against the fake API", () => {
  let fake: FakeAnthropic;
  const saved = { ...process.env };
  beforeAll(() => {
    fake = startFakeAnthropic();
  });
  afterAll(() => fake.stop());
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const adapter = (warn: (line: string) => void = () => {}) =>
    createAnthropicAdapter({ apiKey: "test-key", baseURL: fake.url, warn });

  async function run(reply: FakeReply, req = request(), signal = new AbortController().signal) {
    fake.reply(reply);
    const events: ProviderEvent[] = [];
    try {
      for await (const e of adapter().stream(req, signal)) events.push(e);
      return { events, error: undefined };
    } catch (error) {
      return { events, error };
    }
  }

  test("text streams as deltas and ends with usage, stop and native", async () => {
    const { events, error } = await run({
      kind: "message",
      blocks: [{ type: "text", text: "hello there" }],
      usage: { input: 50, cacheRead: 7, cacheWrite: 3, output: 12 },
    });
    expect(error).toBeUndefined();
    expect(events[0] as unknown).toEqual({
      type: "start",
      usage: {
        uncachedInputTokens: 50,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        outputTokens: 1,
        thinkingTokens: 0,
      },
    });
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("hello there");
    expect(events.at(-1)).toEqual({
      type: "end",
      stop: "end",
      usage: {
        uncachedInputTokens: 50,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        outputTokens: 12,
        thinkingTokens: 0,
      },
      native: [{ type: "text", text: "hello there" }],
    });
    // Pinned to what SDK 1.8.0 sends, so an upgrade that changes the header shows up here.
    const headers = fake.messages().at(-1)?.headers ?? {};
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("tool calls come out as events and the stop is tool_use", async () => {
    const { events } = await run(toolUse("tu_9", "tars", { argv: ["cost", "--json"] }, "checking"));
    expect(events).toContainEqual({
      type: "tool_call",
      providerCallId: "tu_9",
      name: "tars",
      input: { argv: ["cost", "--json"] },
    });
    expect(events.at(-1)).toMatchObject({ type: "end", stop: "tool_use" });
  });

  test("max_tokens with a tool_use block keeps the stop as max_tokens", async () => {
    const { events } = await run({
      kind: "message",
      blocks: [{ type: "tool_use", id: "tu_1", name: "tars", input: { argv: [] } }],
      stop: "max_tokens",
    });
    expect(events.at(-1)).toMatchObject({ stop: "max_tokens" });
  });

  test("thinking shows as one event; its tokens are counted; the signature stays in native", async () => {
    const { events } = await run({
      kind: "message",
      blocks: [
        { type: "thinking", thinking: "let me see", signature: "sig-123" },
        { type: "text", text: "done" },
      ],
      usage: { output: 40, thinking: 25 },
    });
    expect(events.filter((e) => e.type === "thinking")).toHaveLength(1);
    const end = events.at(-1) as Extract<ProviderEvent, { type: "end" }>;
    expect(end.usage?.thinkingTokens).toBe(25);
    expect(end.native[0]).toEqual({
      type: "thinking",
      thinking: "let me see",
      signature: "sig-123",
    });
  });

  test("a thinking block replays byte for byte", async () => {
    const native = [
      { type: "thinking", thinking: "let me see", signature: "sig-123" },
      { type: "text", text: "done" },
    ];
    await run(
      text("ok"),
      request({ history: [user(1, "q"), assistant(2, "done", native), user(3, "q2")] }),
    );
    const sent = fake.messages().at(-1)?.body.messages as { content: unknown }[];
    expect(JSON.stringify(sent[1]?.content)).toBe(JSON.stringify(native));
  });

  test("an unknown stop reason maps to other", async () => {
    const { events } = await run({
      kind: "message",
      blocks: [{ type: "text", text: "x" }],
      stop: "refusal",
    });
    expect(events.at(-1)).toMatchObject({ stop: "other" });
  });

  const errorCases: [string, FakeReply, Partial<ProviderError>][] = [
    [
      "429 with retry-after",
      { kind: "http_error", status: 429, type: "rate_limit_error", retryAfter: "3" },
      { kind: "rate_limit", status: 429, retryAfterMs: 3000 },
    ],
    [
      "429 with enforced_spend_limit_reached",
      {
        kind: "http_error",
        status: 429,
        type: "rate_limit_error",
        errorCode: "enforced_spend_limit_reached",
      },
      { kind: "spend_limit", status: 429 },
    ],
    [
      "529",
      { kind: "http_error", status: 529, type: "overloaded_error" },
      { kind: "overloaded", status: 529 },
    ],
    [
      "500",
      { kind: "http_error", status: 500, type: "api_error" },
      { kind: "server", status: 500 },
    ],
    [
      "503",
      { kind: "http_error", status: 503, type: "something_new" },
      { kind: "server", status: 503 },
    ],
    [
      "408",
      { kind: "http_error", status: 408, type: "timeout_error" },
      { kind: "connection", status: 408 },
    ],
    [
      "401",
      { kind: "http_error", status: 401, type: "authentication_error" },
      { kind: "auth", status: 401 },
    ],
    [
      "403",
      { kind: "http_error", status: 403, type: "permission_error" },
      { kind: "auth", status: 403 },
    ],
    [
      "stream error rate_limit_error",
      { kind: "stream_error", blocks: [], type: "rate_limit_error" },
      { kind: "rate_limit", receivedStart: true, receivedContent: false },
    ],
    [
      "stream error overloaded_error after text",
      {
        kind: "stream_error",
        blocks: [{ type: "text", text: "partial" }],
        type: "overloaded_error",
      },
      { kind: "overloaded", receivedStart: true, receivedContent: true },
    ],
    [
      "stream error api_error",
      { kind: "stream_error", blocks: [], type: "api_error" },
      { kind: "server", receivedStart: true },
    ],
    [
      "a dropped stream",
      { kind: "disconnect", blocks: [{ type: "text", text: "partial" }] },
      { kind: "connection", receivedStart: true, receivedContent: true },
    ],
  ];

  test.each(errorCases)("%s maps to the table's kind", async (_name, reply, expected) => {
    const { error } = await run(reply);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject(expected);
    if (expected.status === undefined) expect((error as ProviderError).status).toBeUndefined();
    expect((error as ProviderError).message).not.toContain("partial");
  });

  test("an HTTP error before the stream starts has received nothing", async () => {
    const { error } = await run({ kind: "http_error", status: 500, type: "api_error" });
    expect(error).toMatchObject({ receivedStart: false, receivedContent: false });
  });

  test("400 is bad_request with the provider's text cut to 500 characters as detail only", async () => {
    const message = `bad field: ${"y".repeat(800)}`;
    const { error } = await run({
      kind: "http_error",
      status: 400,
      type: "invalid_request_error",
      message,
    });
    expect(error).toMatchObject({ kind: "bad_request", status: 400 });
    const pe = error as ProviderError;
    expect(pe.detail).toBe(message.slice(0, 500));
    expect(pe.message).not.toContain("bad field");
  });

  test("aborting mid-stream is aborted", async () => {
    const controller = new AbortController();
    fake.reply({ kind: "hang" });
    const events: ProviderEvent[] = [];
    let error: unknown;
    try {
      for await (const e of adapter().stream(request(), controller.signal)) {
        events.push(e);
        if (e.type === "start") controller.abort();
      }
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ kind: "aborted", receivedStart: true });
  });

  test("ANTHROPIC_* variables are dropped and named; the request still reaches the fake, silently", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    process.env.ANTHROPIC_LOG = "debug";
    process.env.ANTHROPIC_CUSTOM_HEADERS = "x-leak: 1";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    const warnings: string[] = [];
    const before = fake.messages().length;
    try {
      fake.reply(text("hi"));
      const a = createAnthropicAdapter({
        apiKey: "k",
        baseURL: fake.url,
        warn: (l) => warnings.push(l),
      });
      for await (const _ of a.stream(request(), new AbortController().signal));
      expect(fake.messages().length).toBe(before + 1);
      expect(fake.messages().at(-1)?.headers["x-leak"]).toBeUndefined();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(warnings.join("\n")).toContain("ANTHROPIC_BASE_URL");
    expect(warnings.join("\n")).toContain("ANTHROPIC_LOG");
    expect(warnings.join("\n")).not.toContain("debug");
    expect(process.env.ANTHROPIC_LOG).toBeUndefined();
  });

  test("no warning when no ANTHROPIC_* variable is set", () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("ANTHROPIC_")) delete process.env[k];
    const warnings: string[] = [];
    adapter((l) => warnings.push(l));
    expect(warnings).toEqual([]);
  });

  test("listModels reads every page and maps capabilities", async () => {
    fake.models = Array.from({ length: 150 }, (_, i) => ({ id: `m-${i}` }));
    fake.models[0] = {
      id: "m-0",
      display_name: "Zero",
      lifecycle: "deprecated",
      retires_at: "2027-01-31",
      max_input_tokens: 200000,
      max_tokens: 64000,
      capabilities: capabilities(["low", "medium", "high"], ["adaptive"]),
    };
    const before = fake.requests.filter((r) => r.path === "/v1/models").length;
    const models = await adapter().listModels(new AbortController().signal);
    expect(models).toHaveLength(150);
    expect(fake.requests.filter((r) => r.path === "/v1/models").length - before).toBe(2);
    expect(models[0]).toEqual({
      id: "m-0",
      label: "Zero",
      lifecycle: "deprecated",
      retiresAt: "2027-01-31",
      contextWindow: 200000,
      maxOutput: 64000,
      effortLevels: ["low", "medium", "high"],
      thinkingTypes: ["adaptive"],
    });
    expect(models[1]).toEqual({ id: "m-1", label: "m-1", lifecycle: "active" });
  });

  test("a model whose effort is not supported lists no levels; null xhigh is unsupported", async () => {
    const caps = capabilities([], []) as { effort: Record<string, unknown> };
    fake.models = [{ id: "plain", capabilities: caps }];
    const [m] = await adapter().listModels(new AbortController().signal);
    expect(m?.effortLevels).toEqual([]);
    expect(m?.thinkingTypes).toEqual([]);
  });
});

describe("toProviderError", () => {
  const signal = new AbortController().signal;
  const seen = { receivedStart: false, receivedContent: false };

  test("a connection error is connection; a bare AnthropicError is connection", () => {
    expect(
      toProviderError(new APIConnectionError({ message: "down" }), signal, seen),
    ).toMatchObject({
      kind: "connection",
    });
    expect(toProviderError(new AnthropicError("stream ended"), signal, seen)).toMatchObject({
      kind: "connection",
    });
  });

  test("an aborted signal wins over the error's own type", () => {
    const controller = new AbortController();
    controller.abort();
    expect(toProviderError(new AnthropicError("x"), controller.signal, seen)).toMatchObject({
      kind: "aborted",
    });
  });

  test("anything else is handed back unchanged", () => {
    const err = new TypeError("bug");
    expect(toProviderError(err, signal, seen)).toBe(err);
  });
});
