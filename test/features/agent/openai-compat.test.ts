import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { APIConnectionError, APIConnectionTimeoutError, APIError, OpenAIError } from "openai";
import { utf8Bytes } from "../../../src/features/agent/bytes.ts";
import {
  createCompatAdapter,
  listGemini,
  listOpenRouter,
  requestBody,
  toChatMessages,
  toProviderError,
  usageOf,
  type CompatProvider,
} from "../../../src/features/agent/openai-compat.ts";
import { ProviderError, type ProviderAdapter } from "../../../src/features/agent/provider.ts";
import type {
  Effort,
  Item,
  ModelRequest,
  ProviderEvent,
} from "../../../src/features/agent/types.ts";
import {
  compatCall,
  compatText,
  startFakeCompat,
  type FakeCompat,
  type FakeCompatReply,
} from "../../fakes/openai-compat.ts";

// --- Items.
const KEY = "key-now";
const user = (seq: number, t: string): Item => ({
  seq,
  turnId: "t",
  step: 0,
  kind: "user",
  body: { text: t },
});
const assistant = (seq: number, t: string, native: unknown[] | null, thinkingKey = KEY): Item => ({
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
const toolResult = (seq: number, callId: string, t = "ok"): Item => ({
  seq,
  turnId: "t",
  step: 1,
  kind: "tool_result",
  body: { callId, status: "done", text: t, truncated: false },
});
const signed = (id: string, signature?: string) => ({
  id,
  type: "function" as const,
  function: { name: "tars", arguments: '{"argv":["cost"]}' },
  ...(signature === undefined
    ? {}
    : { extra_content: { google: { thought_signature: signature } } }),
});
const callMessage = (...calls: unknown[]) => ({
  role: "assistant",
  content: null,
  tool_calls: calls,
});

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "model-c",
    maxOutputTokens: 1024,
    system: [
      { text: "preamble", cache: false },
      { text: "soul", cache: true },
    ],
    tools: [
      { name: "tars", description: "run tars", inputSchema: { type: "object", properties: {} } },
    ],
    history: [user(1, "hi")],
    cacheTtl: "5m",
    cacheHistory: true,
    toolResultBytes: 16384,
    thinkingKey: KEY,
    capabilities: { thinkingTypes: [], effortLevels: [] },
    ...overrides,
  };
}

const messagesOf = (req: ModelRequest): unknown => toChatMessages(req);

describe("history to chat messages", () => {
  test("the system blocks become one message; user and assistant items follow", () => {
    expect(
      messagesOf(
        request({
          history: [
            user(1, "hi"),
            assistant(2, "hello", [{ role: "assistant", content: "hello" }]),
          ],
        }),
      ),
    ).toEqual([
      { role: "system", content: "preamble\n\nsoul" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("tool calls ride on the assistant message, each result follows as a tool message", () => {
    const history = [
      user(1, "cost?"),
      assistant(2, "", [callMessage(signed("p1"))]),
      toolCall(3, "c1", "p1"),
      toolResult(4, "c1", "12 USD"),
      assistant(5, "12", [{ role: "assistant", content: "12" }]),
    ];
    expect(messagesOf(request({ history }))).toEqual([
      { role: "system", content: "preamble\n\nsoul" },
      { role: "user", content: "cost?" },
      callMessage(signed("p1")),
      { role: "tool", tool_call_id: "p1", content: "12 USD" },
      { role: "assistant", content: "12" },
    ]);
  });

  test("neighbouring user items merge; an assistant without native is its text; empty is skipped", () => {
    expect(
      messagesOf(
        request({
          system: [],
          history: [
            user(1, "carried"),
            user(2, "index"),
            user(3, "message"),
            assistant(4, "partial", null),
            user(5, "a"),
            assistant(6, "", null),
            user(7, "b"),
          ],
        }),
      ),
    ).toEqual([
      { role: "user", content: "carried\n\nindex\n\nmessage" },
      { role: "assistant", content: "partial" },
      { role: "user", content: "a\n\nb" },
    ]);
  });

  test("neighbouring assistant messages merge; the tool calls are the later one's", () => {
    expect(
      messagesOf(
        request({
          system: [],
          history: [
            user(1, "x"),
            assistant(2, "first", null),
            assistant(3, "", [
              { role: "assistant", content: "second", tool_calls: [signed("p1")] },
            ]),
          ],
        }),
      ),
    ).toEqual([
      { role: "user", content: "x" },
      { role: "assistant", content: "first\n\nsecond", tool_calls: [signed("p1")] },
    ]);
  });

  test("a tool result longer than toolResultBytes is cut", () => {
    const long = "x".repeat(5000);
    const history = [
      user(1, "go"),
      assistant(2, "", [callMessage(signed("p1"))]),
      toolCall(3, "c1", "p1"),
      toolResult(4, "c1", long),
    ];
    const out = toChatMessages(request({ history, toolResultBytes: 1024 }));
    const tool = out.at(-1) as { content: string };
    expect(new TextEncoder().encode(tool.content).length).toBeLessThan(1500);
  });

  test("a stored message is not changed by the conversion", () => {
    const native = [{ role: "assistant", content: "a" }];
    toChatMessages(
      request({ history: [user(1, "x"), assistant(2, "a", native), assistant(3, "b", null)] }),
    );
    expect(native).toEqual([{ role: "assistant", content: "a" }]);
  });
});

describe("Gemini signatures going back", () => {
  const finished = (key: string) => [
    user(1, "first"),
    assistant(2, "", [callMessage(signed("p1", "sig-old"))], key),
    toolCall(3, "c1", "p1"),
    toolResult(4, "c1"),
    assistant(5, "done", [{ role: "assistant", content: "done" }], key),
    user(6, "second"),
    assistant(7, "", [callMessage(signed("p2", "sig-new"))], key),
    toolCall(8, "c2", "p2"),
    toolResult(9, "c2"),
  ];
  const calls = (req: ModelRequest) =>
    toChatMessages(req).flatMap((m) => ("tool_calls" in m ? (m.tool_calls ?? []) : []));

  test("thinkingKey matching: every signature goes back as stored", () => {
    expect(calls(request({ history: finished(KEY) }))).toEqual([
      signed("p1", "sig-old"),
      signed("p2", "sig-new"),
    ]);
  });

  test("thinkingKey not matching: finished turns lose theirs, the current turn keeps its own", () => {
    expect(calls(request({ history: finished("key-before") }))).toEqual([
      signed("p1"),
      signed("p2", "sig-new"),
    ]);
  });
});

describe("request body", () => {
  const body = (provider: CompatProvider, overrides: Partial<ModelRequest> = {}) =>
    requestBody(request(overrides), provider);
  const caps = (thinkingTypes: string[], effortLevels: Effort[]) => ({
    thinkingTypes,
    effortLevels,
  });

  test("no effort: no reasoning parameters at all", () => {
    for (const p of ["gemini", "openrouter"] as const) {
      const b = body(p);
      expect(b.reasoning_effort).toBeUndefined();
      expect(b.reasoning).toBeUndefined();
    }
  });

  test("a level goes as each endpoint names it", () => {
    expect(body("gemini", { effort: "high" }).reasoning_effort).toBe("high");
    expect(body("openrouter", { effort: "xhigh" }).reasoning).toEqual({ effort: "xhigh" });
  });

  test("off, the model able to turn it off: the off setting", () => {
    const c = caps(["disabled"], ["low", "high"]);
    expect(body("gemini", { effort: "off", capabilities: c }).reasoning_effort).toBe("none");
    expect(body("openrouter", { effort: "off", capabilities: c }).reasoning).toEqual({
      enabled: false,
    });
  });

  test("off, the model unable but with levels: its lowest level (D32)", () => {
    const c = caps([], ["high", "medium"]);
    expect(body("gemini", { effort: "off", capabilities: c }).reasoning_effort).toBe("medium");
    expect(body("openrouter", { effort: "off", capabilities: c }).reasoning).toEqual({
      effort: "medium",
    });
  });

  test("off, the model unable and without levels: nothing", () => {
    const b = body("openrouter", { effort: "off", capabilities: caps([], []) });
    expect(b.reasoning).toBeUndefined();
    expect(body("gemini", { effort: "off" }).reasoning_effort).toBeUndefined();
  });

  test("Gemini asks for usage in the stream; OpenRouter carries the data policy", () => {
    const g = body("gemini");
    const o = body("openrouter");
    expect(g.stream_options).toEqual({ include_usage: true });
    expect(g.provider).toBeUndefined();
    expect(o.stream_options).toBeUndefined();
    expect(o.provider).toEqual({ data_collection: "deny" });
  });

  test("model, stream, max_tokens and function tools", () => {
    const b = body("gemini");
    expect(b).toMatchObject({ model: "model-c", stream: true, max_tokens: 1024 });
    expect(b.tools).toEqual([
      {
        type: "function",
        function: {
          name: "tars",
          description: "run tars",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(body("gemini", { tools: [] }).tools).toBeUndefined();
  });
});

describe("usage", () => {
  test("cache fields split the input; without them all is uncached", () => {
    expect(
      usageOf("openrouter", {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      })?.usage,
    ).toEqual({
      uncachedInputTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      outputTokens: 20,
      thinkingTokens: 0,
    });
    expect(
      usageOf("gemini", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })?.usage,
    ).toMatchObject({
      uncachedInputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("OpenRouter's cost is taken; Gemini's is ignored", () => {
    expect(
      usageOf("openrouter", { prompt_tokens: 1, completion_tokens: 1, cost: 0.0123 })?.costUsd,
    ).toBe(0.0123);
    expect(
      usageOf("gemini", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 1 }),
    ).toEqual({ usage: expect.any(Object) });
  });

  test("Gemini's output is total − prompt; without total its thinking is unknown: no usage", () => {
    expect(
      usageOf("gemini", { prompt_tokens: 50, completion_tokens: 14, total_tokens: 456 })?.usage,
    ).toMatchObject({ outputTokens: 406, thinkingTokens: 392 });
    expect(usageOf("gemini", { prompt_tokens: 50, completion_tokens: 14 })).toBeUndefined();
  });

  test.each([
    ["an empty object", {}],
    ["no prompt_tokens", { completion_tokens: 5 }],
    ["no completion_tokens", { prompt_tokens: 5 }],
    ["a negative count", { prompt_tokens: -1, completion_tokens: 5 }],
    ["a count as a string", { prompt_tokens: "5", completion_tokens: 5 }],
    ["NaN", { prompt_tokens: Number.NaN, completion_tokens: 5 }],
    ["Infinity", { prompt_tokens: 5, completion_tokens: Number.POSITIVE_INFINITY }],
    [
      "a negative cached count",
      { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: -2 } },
    ],
    ["a negative cost", { prompt_tokens: 5, completion_tokens: 5, cost: -1 }],
    ["a NaN cost", { prompt_tokens: 5, completion_tokens: 5, cost: Number.NaN }],
    ["a cost as a string", { prompt_tokens: 5, completion_tokens: 5, cost: "0.01" }],
  ] as const)("OpenRouter, %s: not enough to price, no usage", (_, raw) => {
    expect(usageOf("openrouter", raw)).toBeUndefined();
  });

  const MAX = Number.MAX_SAFE_INTEGER;
  test.each([
    ["openrouter", "a fractional count", { prompt_tokens: 0.1, completion_tokens: 0.2 }],
    ["openrouter", "a count past the safe range", { prompt_tokens: MAX + 1, completion_tokens: 1 }],
    ["openrouter", "a huge float", { prompt_tokens: 1e308, completion_tokens: 1 }],
    [
      "openrouter",
      "cached above the prompt",
      { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } },
    ],
    [
      "openrouter",
      "cached and written together above the prompt",
      {
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 5 },
      },
    ],
    [
      "openrouter",
      "reasoning above the completion",
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 6 },
      },
    ],
    [
      "openrouter",
      "a fractional reasoning count",
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 1.5 },
      },
    ],
    [
      "gemini",
      "total below the prompt",
      { prompt_tokens: 100, completion_tokens: 1, total_tokens: 1 },
    ],
    [
      "gemini",
      "total below prompt + completion",
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 110 },
    ],
    ["gemini", "a fractional total", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2.5 }],
  ] as const)("%s, %s: inconsistent, no usage", (provider, _, raw) => {
    expect(usageOf(provider, raw)).toBeUndefined();
  });

  test("the largest safe counts that agree are still priced", () => {
    expect(
      usageOf("openrouter", { prompt_tokens: MAX, completion_tokens: 0 })?.usage
        .uncachedInputTokens,
    ).toBe(MAX);
    expect(
      usageOf("gemini", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })?.usage,
    ).toMatchObject({ outputTokens: 20, thinkingTokens: 0 });
  });

  test("null details and a null cost count as absent", () => {
    expect(
      usageOf("openrouter", {
        prompt_tokens: 5,
        completion_tokens: 5,
        prompt_tokens_details: null,
        completion_tokens_details: null,
        cost: null,
      }),
    ).toEqual({ usage: expect.objectContaining({ uncachedInputTokens: 5, outputTokens: 5 }) });
  });

  test("OpenRouter's reasoning tokens are inside completion, not added", () => {
    expect(
      usageOf("openrouter", {
        prompt_tokens: 10,
        completion_tokens: 300,
        total_tokens: 310,
        completion_tokens_details: { reasoning_tokens: 250 },
      })?.usage,
    ).toMatchObject({ outputTokens: 300, thinkingTokens: 250 });
  });
});

describe("errors", () => {
  const seen = { receivedStart: false, receivedContent: false };
  const SECRET = "or-" + "live-0123456789";
  const signal = new AbortController().signal;
  const apiError = (status: number, message: string, headers: Record<string, string> = {}) =>
    APIError.generate(status, { error: { message } }, undefined, new Headers(headers));
  const kind = (err: unknown, provider: CompatProvider = "openrouter") =>
    (toProviderError(err, provider, signal, seen, SECRET) as ProviderError).kind;

  test.each([
    [402, "spend_limit"],
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [503, "overloaded"],
    [529, "overloaded"],
    [408, "connection"],
    [500, "server"],
    [502, "server"],
    [400, "bad_request"],
    [404, "bad_request"],
  ] as const)("HTTP %d is %s", (status, expected) => {
    expect(kind(apiError(status, "x"))).toBe(expected);
  });

  test("429 reads retry-after", () => {
    const e = toProviderError(
      apiError(429, "slow", { "retry-after": "3" }),
      "gemini",
      signal,
      seen,
      SECRET,
    );
    expect(e).toMatchObject({ kind: "rate_limit", retryAfterMs: 3000 });
  });

  test("Gemini's 400 about the API key is auth; OpenRouter's is not", () => {
    const bad = apiError(400, "API key not valid. Please pass a valid API key.");
    expect(kind(bad, "gemini")).toBe("auth");
    expect(kind(bad, "openrouter")).toBe("bad_request");
  });

  test("OpenRouter's data-policy 404 has its own text; another 404 keeps the upstream's", () => {
    const policy = toProviderError(
      apiError(404, "No endpoints found matching your data policy"),
      "openrouter",
      signal,
      seen,
      SECRET,
    ) as ProviderError;
    expect(policy.kind).toBe("bad_request");
    expect(policy.detail).toContain("資料政策");
    const other = toProviderError(
      apiError(404, "model vendor/x not found"),
      "openrouter",
      signal,
      seen,
      SECRET,
    );
    expect((other as ProviderError).detail).toBe("model vendor/x not found");
  });

  test("connection errors and other SDK errors are connection; an aborted signal is aborted", () => {
    expect(kind(new APIConnectionError({ message: "x" }))).toBe("connection");
    expect(kind(new APIConnectionTimeoutError())).toBe("connection");
    expect(kind(new OpenAIError("x"))).toBe("connection");
    const ac = new AbortController();
    ac.abort();
    expect(
      (toProviderError(new Error("x"), "gemini", ac.signal, seen, SECRET) as ProviderError).kind,
    ).toBe("aborted");
  });

  test("a bad request's detail is cut to 500 characters", () => {
    const e = toProviderError(
      apiError(400, "word ".repeat(180)),
      "gemini",
      signal,
      seen,
      SECRET,
    ) as ProviderError;
    expect(e.detail).toHaveLength(500);
  });

  test("only error.message is kept: metadata.raw and a body that is not JSON are dropped", () => {
    const raw = APIError.generate(
      400,
      { error: { metadata: { raw: `authorization: Bearer ${SECRET}` } } },
      undefined,
      new Headers(),
    );
    const notJson = APIError.generate(400, undefined, `echo: ${SECRET}`, new Headers());
    for (const err of [raw, notJson]) {
      const e = toProviderError(err, "openrouter", signal, seen, SECRET) as ProviderError;
      expect(e.kind).toBe("bad_request");
      expect(e.detail).toBeUndefined();
    }
  });

  describe("the key and anything shaped like a token are taken out", () => {
    // Near a real key's length (39 to 73 characters), with the + and / an encoding changes.
    const key = "ab+cd/ef" + "0123456789abcdefghijklmnop";
    const detail = (message: string, body: object = { error: { message } }) =>
      (
        toProviderError(
          APIError.generate(400, body, undefined, new Headers()),
          "openrouter",
          signal,
          seen,
          key,
        ) as ProviderError
      ).detail;

    test("the key as sent", () => {
      expect(detail(`sent with ${key}.`)).toBe("sent with [金鑰已遮蔽].");
    });

    test("encodings no list names: lower-case percent, Base64 of the Bearer header, key=<Base64>", () => {
      const lower = encodeURIComponent(key).toLowerCase();
      expect(lower).not.toBe(encodeURIComponent(key));
      expect(detail(`bad key ${lower} here`)).toBe("bad key [已遮蔽] here");
      const bearer = Buffer.from(`Bearer ${key}`).toString("base64");
      expect(detail(`header ${bearer} refused`)).toBe("header [已遮蔽] refused");
      expect(detail(`got key=${Buffer.from(key).toString("base64")}`)).toBe("got [已遮蔽]");
    });

    test("not taken: a word, an identifier, a model id, a plain sentence, an HTTP status", () => {
      for (const kept of [
        "Function call is missing a thought_signature in functionCall parts.",
        "model google/gemini-2.5-flash is not available in your region",
        "internationalization of characteristically uncharacteristic responses",
        "Provider returned error 400 (Bad Request): the model is unavailable, try later.",
        "HTTP 503 Service Unavailable",
      ])
        expect(detail(kept)).toBe(kept);
    });

    test("a cut-short echo outside the message is dropped", () => {
      expect(detail("", { error: { message: "bad", metadata: { raw: "key=a+b/" } } })).toBe("bad");
    });

    test("before the cut, so the cut cannot leave part of one", () => {
      const shaped = ("01234567" + "89abcdef").repeat(2);
      for (const tail of [SECRET, shaped]) {
        const e = toProviderError(
          apiError(400, `${"word ".repeat(99)}${tail}`),
          "gemini",
          signal,
          seen,
          SECRET,
        ) as ProviderError;
        expect(e.detail).toHaveLength(500);
        expect(e.detail).not.toContain(tail.slice(0, 5));
      }
    });
  });
});

describe("model lists", () => {
  const NOW = new Date("2026-11-20T00:00:00Z");

  test("OpenRouter: prices per million, cache prices fall back to input, limits, guessed levels", () => {
    const [m] = listOpenRouter(
      [
        {
          id: "vendor/m",
          name: "Vendor M",
          context_length: 128000,
          top_provider: { max_completion_tokens: 16000 },
          pricing: { prompt: "0.000003", completion: "0.000015" },
          supported_parameters: ["tools", "reasoning"],
        },
      ],
      NOW,
    );
    expect(m).toEqual({
      id: "vendor/m",
      label: "Vendor M",
      lifecycle: "active",
      contextWindow: 128000,
      maxOutput: 16000,
      effortLevels: ["low", "medium", "high"],
      inferred: ["effortLevels"],
      price: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 },
      priceSource: "openrouter",
    });
    expect(m?.thinkingTypes).toBeUndefined();
  });

  test("OpenRouter: cache prices when given; no reasoning is no levels; no max output is left out", () => {
    const [m] = listOpenRouter(
      [
        {
          id: "v/n",
          name: "N",
          context_length: 1000,
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
            input_cache_read: "0.0000001",
            input_cache_write: "0.00000125",
          },
          supported_parameters: ["tools"],
        },
      ],
      NOW,
    );
    expect(m?.price).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(m?.effortLevels).toEqual([]);
    expect(m?.maxOutput).toBeUndefined();
  });

  test("OpenRouter: expiration_date past is retired, ahead is deprecated, absent is active", () => {
    const one = (expiration_date?: string) =>
      listOpenRouter([{ id: "v/x", name: "X", expiration_date }], NOW)[0];
    expect(one("2026-11-01")?.lifecycle).toBe("retired");
    expect(one("2027-01-01")).toMatchObject({ lifecycle: "deprecated", retiresAt: "2027-01-01" });
    expect(one()?.lifecycle).toBe("active");
  });

  test("Gemini: the models/ prefix goes, display_name is the label, nothing else is filled", () => {
    expect(
      listGemini([
        { id: "models/gemini-x", object: "model", owned_by: "google", display_name: "Gemini X" },
        { id: "gemini-y", object: "model", owned_by: "google" },
      ]),
    ).toEqual([
      { id: "gemini-x", label: "Gemini X" },
      { id: "gemini-y", label: "gemini-y" },
    ]);
  });
});

// --- Against the fake endpoint.

const fakes: Record<CompatProvider, FakeCompat> = {} as Record<CompatProvider, FakeCompat>;
const warnings: string[] = [];
const adapters: Record<CompatProvider, ProviderAdapter> = {} as Record<
  CompatProvider,
  ProviderAdapter
>;

beforeAll(() => {
  for (const p of ["gemini", "openrouter"] as const) {
    fakes[p] = startFakeCompat(p);
    adapters[p] = createCompatAdapter({
      provider: p,
      apiKey: "test-key",
      baseURL: fakes[p].url,
      warn: (l) => warnings.push(l),
    });
  }
});
afterAll(async () => {
  for (const f of Object.values(fakes)) await f.stop();
});
afterEach(() => {
  for (const f of Object.values(fakes)) {
    f.requests.length = 0;
    delete f.handler;
  }
});

async function events(
  provider: CompatProvider,
  reply: FakeCompatReply,
  req: ModelRequest = request(),
): Promise<ProviderEvent[]> {
  fakes[provider].reply(reply);
  const out: ProviderEvent[] = [];
  for await (const ev of adapters[provider].stream(req, new AbortController().signal)) out.push(ev);
  return out;
}

async function failure(
  provider: CompatProvider,
  reply: FakeCompatReply,
  req: ModelRequest = request(),
): Promise<ProviderError> {
  try {
    await events(provider, reply, req);
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error("expected a ProviderError");
}

const endOf = (evs: ProviderEvent[]) => evs.at(-1) as Extract<ProviderEvent, { type: "end" }>;
interface ChatCall {
  id: string;
  function: { name: string; arguments: string };
  extra_content?: { google: { thought_signature: string } };
}
const callsOf = (evs: ProviderEvent[]) =>
  evs.filter((e): e is Extract<ProviderEvent, { type: "tool_call" }> => e.type === "tool_call");

describe("stream", () => {
  test("text: start without usage, the deltas, end with usage and the message to replay", async () => {
    const evs = await events(
      "openrouter",
      compatText("hello there", { prompt: 20, completion: 5, cost: 0.002 }),
    );
    expect(evs[0]).toEqual({ type: "start" });
    expect(
      evs
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("hello there");
    expect(endOf(evs)).toEqual({
      type: "end",
      stop: "end",
      usage: {
        uncachedInputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        thinkingTokens: 0,
      },
      costUsd: 0.002,
      native: [{ role: "assistant", content: "hello there" }],
    });
    expect(fakes.openrouter.chats()[0]?.headers.authorization).toBe("Bearer test-key");
  });

  test("a tool call split across chunks, finish tool_calls: tool_use with the parsed input", async () => {
    const evs = await events("openrouter", compatCall("p1", "tars", { argv: ["cost", "--json"] }));
    expect(callsOf(evs)).toEqual([
      {
        type: "tool_call",
        providerCallId: "p1",
        name: "tars",
        input: { argv: ["cost", "--json"] },
      },
    ]);
    expect(endOf(evs).stop).toBe("tool_use");
  });

  test("finish stop with a complete tool call is still tool_use (Gemini's stream)", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [{ id: "p1", name: "tars", args: { argv: ["cost"] }, signature: "s" }],
      finish: "stop",
    });
    expect(endOf(evs).stop).toBe("tool_use");
    expect(callsOf(evs)).toHaveLength(1);
  });

  test("finish stop without calls is end; length is max_tokens and drops calls; other is other", async () => {
    expect(endOf(await events("gemini", compatText("x"))).stop).toBe("end");
    const cut = await events("openrouter", {
      kind: "message",
      text: "partial",
      toolCalls: [{ id: "p1", name: "tars", args: "{" }],
      finish: "length",
    });
    expect(endOf(cut).stop).toBe("max_tokens");
    expect(callsOf(cut)).toEqual([]);
    expect(endOf(cut).native).toEqual([{ role: "assistant", content: "partial" }]);
    const odd = await events("openrouter", {
      kind: "message",
      toolCalls: [{ id: "p1", name: "tars", args: {} }],
      finish: "content_filter",
    });
    expect(endOf(odd).stop).toBe("other");
    expect(callsOf(odd)).toEqual([]);
    expect(endOf(odd).native).toEqual([]);
  });

  test("no finish_reason: the stream broke, a connection error", async () => {
    const err = await failure("openrouter", { kind: "message", text: "half", finish: null });
    expect(err).toMatchObject({ kind: "connection", receivedStart: true, receivedContent: true });
    const cut = await failure("gemini", { kind: "disconnect", text: "half" });
    expect(cut.kind).toBe("connection");
  });

  test("end carries the call bytes as received, dropped calls included", async () => {
    const args = `{"argv": [${" ".repeat(100)}"cost"]}`;
    const kept = await events("openrouter", compatCall("p1", "tars", args));
    expect(endOf(kept).callBytes).toBe(utf8Bytes("tars") + utf8Bytes(args));
    const cut = await events("openrouter", {
      kind: "message",
      toolCalls: [{ id: "p1", name: "tars", args: "{" }],
      finish: "length",
    });
    expect(endOf(cut).callBytes).toBe(utf8Bytes("tars") + 1);
    expect(endOf(await events("openrouter", compatText("x")))).not.toHaveProperty("callBytes");
  });

  test("arguments that are not JSON reach the tool as _invalid_arguments", async () => {
    const evs = await events("openrouter", compatCall("p1", "tars", '{"argv": [oops'));
    expect(callsOf(evs)[0]?.input).toEqual({ _invalid_arguments: '{"argv": [oops' });
  });

  test("finish_reason without usage: end has no usage, the calls are still reported", async () => {
    const evs = await events("openrouter", {
      kind: "message",
      toolCalls: [{ id: "p1", name: "tars", args: { argv: ["cost"] } }],
      usage: null,
    });
    expect(callsOf(evs)).toHaveLength(1);
    const end = endOf(evs);
    expect(end.stop).toBe("tool_use");
    expect(end.usage).toBeUndefined();
    expect(end.costUsd).toBeUndefined();
  });

  test("usage: {} at the end, or Gemini's without total_tokens: end has no usage", async () => {
    expect(
      endOf(await events("openrouter", { kind: "message", text: "x", rawUsage: {} })).usage,
    ).toBeUndefined();
    expect(endOf(await events("gemini", compatText("x", { total: null })))).not.toHaveProperty(
      "usage",
    );
  });

  test("Gemini's running totals on every chunk: the last one is used, not a sum", async () => {
    const evs = await events(
      "gemini",
      compatText("abcdef", { prompt: 50, completion: 14, total: 456 }),
    );
    expect(endOf(evs).usage).toMatchObject({ uncachedInputTokens: 50, outputTokens: 406 });
  });

  test("reasoning in the stream is one thinking signal", async () => {
    const evs = await events("openrouter", { kind: "message", text: "x", reasoning: true });
    expect(evs.filter((e) => e.type === "thinking")).toHaveLength(1);
  });

  test("an event that is not JSON is a broken stream, before the first chunk and after", async () => {
    const before = await failure("openrouter", { kind: "bad_sse", afterChunk: false });
    expect(before).toMatchObject({ kind: "connection", receivedStart: false, mayHaveRun: true });
    const after = await failure("gemini", { kind: "bad_sse", afterChunk: true });
    expect(after).toMatchObject({ kind: "connection", receivedStart: true });
    expect(after.mayHaveRun).toBeUndefined();
  });

  test("an error chunk mid-stream is a ProviderError", async () => {
    const err = await failure("openrouter", { kind: "stream_error", text: "half" });
    expect(err.receivedContent).toBe(true);
  });

  test("keys upstream adds to a tool call are not kept in native", async () => {
    const evs = await events(
      "openrouter",
      compatCall("p1", "tars", { argv: [] }, { extra: { index_hint: 3, vendor: "x" } }),
    );
    expect(endOf(evs).native).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "p1", type: "function", function: { name: "tars", arguments: '{"argv":[]}' } },
        ],
      },
    ]);
  });
});

describe("Gemini signatures coming in", () => {
  const nativeCalls = (evs: ProviderEvent[]) =>
    (endOf(evs).native[0] as { tool_calls: Record<string, unknown>[] }).tool_calls;

  test("kept in native on its fixed path; other keys under extra_content are not", async () => {
    const evs = await events(
      "gemini",
      compatCall(
        "p1",
        "tars",
        { argv: ["cost"] },
        { signature: "sig-1", googleExtra: { other: 1 } },
      ),
    );
    expect(nativeCalls(evs)).toEqual([
      {
        id: "p1",
        type: "function",
        function: { name: "tars", arguments: '{"argv":["cost"]}' },
        extra_content: { google: { thought_signature: "sig-1" } },
      },
    ]);
  });

  test("two parallel calls each keep their own; a later chunk's signature replaces the earlier", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: {}, signature: "sig-a" },
        { id: "p2", name: "tars", args: {}, signature: "sig-b" },
      ],
      resendSignature: "sig-later",
    });
    const calls = nativeCalls(evs) as {
      extra_content: { google: { thought_signature: string } };
    }[];
    expect(calls.map((c) => c.extra_content.google.thought_signature)).toEqual([
      "sig-later",
      "sig-later",
    ]);
    const plain = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: {}, signature: "sig-a" },
        { id: "p2", name: "tars", args: {}, signature: "sig-b" },
      ],
    });
    const two = nativeCalls(plain) as {
      extra_content: { google: { thought_signature: string } };
    }[];
    expect(two.map((c) => c.extra_content.google.thought_signature)).toEqual(["sig-a", "sig-b"]);
  });

  test("a signature over 16,384 bytes fails the response as bad_request", async () => {
    const err = await failure(
      "gemini",
      compatCall("p1", "tars", {}, { signature: "s".repeat(16385) }),
    );
    expect(err).toMatchObject({ kind: "bad_request", detail: "thought_signature 超過上限" });
    const ok = await events(
      "gemini",
      compatCall("p1", "tars", {}, { signature: "s".repeat(16384) }),
    );
    expect(endOf(ok).stop).toBe("tool_use");
  });

  test("a response not ending in tool calls has no signature", async () => {
    const evs = await events("gemini", {
      kind: "message",
      text: "cut",
      toolCalls: [{ id: "p1", name: "tars", args: {}, signature: "sig" }],
      finish: "length",
    });
    expect(JSON.stringify(endOf(evs).native)).not.toContain("sig");
  });

  test("OpenRouter does not keep the same field", async () => {
    const evs = await events("openrouter", compatCall("p1", "tars", {}, { signature: "sig" }));
    expect(JSON.stringify(endOf(evs).native)).not.toContain("thought_signature");
  });

  test("the next request carries it back, and the fake refuses one without it", async () => {
    const first = await events(
      "gemini",
      compatCall("p1", "tars", { argv: ["cost"] }, { signature: "sig-r" }),
    );
    const history = [
      user(1, "cost?"),
      assistant(2, "", endOf(first).native as unknown[]),
      toolCall(3, "c1", "p1"),
      toolResult(4, "c1"),
    ];
    const second = await events("gemini", compatText("12 USD"), request({ history }));
    expect(endOf(second).stop).toBe("end");
    expect(JSON.stringify(fakes.gemini.chats().at(-1)?.body.messages)).toContain("sig-r");
    const stripped = [
      user(1, "cost?"),
      assistant(2, "", [callMessage(signed("p1"))]),
      toolCall(3, "c1", "p1"),
      toolResult(4, "c1"),
    ];
    // The fake refuses before it takes a reply, so none is queued.
    let err: unknown;
    try {
      for await (const _ of adapters.gemini.stream(
        request({ history: stripped }),
        new AbortController().signal,
      ));
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: "bad_request", status: 400 });
    expect((err as ProviderError).detail).toContain("thought_signature");
  });
});

// M4-G: Gemini's parallel calls came in as one, and the history it left failed every request
// after. The fake's data is made up; the shapes are the owner's conversation's.
describe("parallel calls in one slot", () => {
  const TARS = { argv: ["script", "show", "a-script"] };
  const READ = { path: "notes/a.md" };
  const seen = (evs: ProviderEvent[]) =>
    callsOf(evs).map((c) => [c.providerCallId, c.name, c.input]);
  const replay = (evs: ProviderEvent[]) =>
    (endOf(evs).native[0] as { tool_calls: ChatCall[] }).tool_calls.map((c) => [
      c.id,
      c.function.name,
      c.function.arguments,
      c.extra_content?.google.thought_signature,
    ]);
  const both = [
    ["p1", "tars", JSON.stringify(TARS), "sig-a"],
    ["p2", "file_read", JSON.stringify(READ), "sig-b"],
  ];

  test("a: two calls on the same index stay two, each with its own name, input and signature", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: TARS, index: 0, signature: "sig-a" },
        { id: "p2", name: "file_read", args: READ, index: 0, signature: "sig-b" },
      ],
    });
    expect(seen(evs)).toEqual([
      ["p1", "tars", TARS],
      ["p2", "file_read", READ],
    ]);
    expect(replay(evs)).toEqual(both);
  });

  test("b: the second call sent without an index is its own call", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: TARS, index: 0, signature: "sig-a" },
        { id: "p2", name: "file_read", args: READ, index: null, signature: "sig-b" },
      ],
    });
    expect(seen(evs)).toEqual([
      ["p1", "tars", TARS],
      ["p2", "file_read", READ],
    ]);
    expect(replay(evs)).toEqual(both);
  });

  test("c: the same name on the same index with another id is another call", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: TARS, index: 0 },
        { id: "p2", name: "tars", args: { argv: ["cost"] }, index: 0 },
      ],
    });
    expect(seen(evs)).toEqual([
      ["p1", "tars", TARS],
      ["p2", "tars", { argv: ["cost"] }],
    ]);
  });

  test("d: one call's arguments in pieces stay one call, with or without the id repeated", async () => {
    for (const repeatId of [false, true]) {
      const evs = await events("openrouter", {
        kind: "message",
        toolCalls: [{ id: "p1", name: "tars", args: TARS, index: 0, repeatId }],
      });
      expect(seen(evs)).toEqual([["p1", "tars", TARS]]);
      expect(endOf(evs).callBytes).toBe(utf8Bytes("tars") + utf8Bytes(JSON.stringify(TARS)));
    }
  });

  test("e: two calls on their own indexes keep their own signatures", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: TARS, signature: "sig-a" },
        { id: "p2", name: "file_read", args: READ, signature: "sig-b" },
      ],
    });
    expect(replay(evs)).toEqual(both);
  });

  test("no id and the same name on the same index: taken as more of the same call [unconfirmed]", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: TARS, index: 0 },
        { id: "", name: "tars", args: { argv: ["cost"] }, index: 0 },
      ],
    });
    const raw = JSON.stringify(TARS) + JSON.stringify({ argv: ["cost"] });
    expect(seen(evs)).toEqual([["p1", "tars", { _invalid_arguments: raw }]]);
    expect(callsOf(evs)[0]?.invalid).toEqual({
      index: 0,
      ids: 1,
      calls: 1,
      interleaved: false,
      bytes: utf8Bytes(raw),
    });
  });

  test("no id and another name on the same index: another call, dropped like any call without an id", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: TARS, index: 0 },
        { id: "", name: "file_read", args: READ, index: 0 },
      ],
    });
    expect(seen(evs)).toEqual([["p1", "tars", TARS]]);
    expect(callsOf(evs)[0]).not.toHaveProperty("invalid");
  });

  test("calls split apart carry no diagnosis; valid ones never do", async () => {
    const evs = await events("gemini", {
      kind: "message",
      toolCalls: [
        { id: "p1", name: "tars", args: TARS, index: 0 },
        { id: "p2", name: "file_read", args: READ, index: 0 },
      ],
    });
    for (const c of callsOf(evs)) expect(c).not.toHaveProperty("invalid");
  });

  // The owner's conversation: one call holding two calls' arguments, signed, its tool failed,
  // then another message from the user.
  const glued = JSON.stringify(TARS) + JSON.stringify(READ);
  const broken = [
    user(1, "記一筆帳"),
    assistant(2, "", [
      callMessage({
        id: "p1",
        type: "function",
        function: { name: "file_read", arguments: glued },
        extra_content: { google: { thought_signature: "sig-x" } },
      }),
    ]),
    toolCall(3, "c1", "p1"),
    {
      ...toolResult(4, "c1", "path 必須是非空的字串"),
      body: { callId: "c1", status: "failed", text: "path 必須是非空的字串", truncated: false },
    } as Item,
    user(5, "再試一次"),
  ];
  const sent = (history: Item[]) =>
    toChatMessages(request({ history })).flatMap((m) =>
      "tool_calls" in m ? (m.tool_calls ?? []) : [],
    );

  test("arguments that are not JSON go back as the JSON the tool was given", () => {
    const [call] = sent(broken);
    expect(call?.function.arguments).toBe(JSON.stringify({ _invalid_arguments: glued }));
    expect(JSON.parse(call?.function.arguments as string)).toEqual({ _invalid_arguments: glued });
    expect(call?.id).toBe("p1");
    expect(call?.function.name).toBe("file_read");
  });

  test("in a finished turn such a call goes without its signature; in the current turn with it", () => {
    expect(sent(broken)[0]).not.toHaveProperty("extra_content");
    const current = sent(broken.slice(0, 4))[0];
    expect(current?.extra_content).toEqual({ google: { thought_signature: "sig-x" } });
  });

  test("valid arguments go back byte for byte, signature and all", () => {
    const fine = signed("p9", "sig-9");
    const history = [user(1, "a"), assistant(2, "", [callMessage(fine)]), toolCall(3, "c9", "p9")];
    expect(sent([...history, toolResult(4, "c9"), user(5, "b")])).toEqual([fine]);
  });

  test("the owner's conversation: the next message is answered, not refused", async () => {
    // A handler, not the queue: a refused request leaves nothing queued for the tests after.
    fakes.gemini.handler = () => compatText("記好了");
    for (const history of [broken, broken.slice(0, 4)]) {
      const evs: ProviderEvent[] = [];
      const stream = adapters.gemini.stream(request({ history }), new AbortController().signal);
      for await (const ev of stream) evs.push(ev);
      expect(endOf(evs).stop).toBe("end");
    }
  });
});

describe("the adapter", () => {
  test("Gemini's array error body still yields its message: a bad key is auth", async () => {
    const err = await failure("gemini", {
      kind: "http_error",
      status: 400,
      body: [{ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }],
    });
    expect(err).toMatchObject({ kind: "auth", status: 400 });
  });

  test("an upstream echoing the key: metadata.raw is dropped, the message has it taken out", async () => {
    const raw = await failure("openrouter", {
      kind: "http_error",
      status: 400,
      body: { error: { metadata: { raw: "authorization: Bearer test-key" } } },
    });
    expect(raw.kind).toBe("bad_request");
    expect(raw.detail).toBeUndefined();
    const array = await failure("gemini", {
      kind: "http_error",
      status: 400,
      body: [{ error: { code: 400, message: "bad field; request had key=test-key" } }],
    });
    expect(array.detail).toBe("bad field; request had key=[金鑰已遮蔽]");
  });

  test("402 is spend_limit; 429 carries retry-after", async () => {
    expect(
      (await failure("openrouter", { kind: "http_error", status: 402, message: "credits" })).kind,
    ).toBe("spend_limit");
    expect(
      await failure("openrouter", {
        kind: "http_error",
        status: 429,
        message: "slow",
        retryAfter: "2",
      }),
    ).toMatchObject({ kind: "rate_limit", retryAfterMs: 2000 });
  });

  test("an aborted request is aborted", async () => {
    fakes.openrouter.reply({ kind: "hang", text: "x" });
    const ac = new AbortController();
    const it = adapters.openrouter.stream(request(), ac.signal);
    setTimeout(() => ac.abort(), 50);
    let err: unknown;
    try {
      for await (const _ of it);
    } catch (e) {
      err = e;
    }
    expect((err as ProviderError).kind).toBe("aborted");
  });

  test("OPENAI_* variables are removed, with one warning", () => {
    process.env.OPENAI_BASE_URL = "http://elsewhere.invalid";
    process.env.OPENAI_ORG_ID = "org";
    const seen: string[] = [];
    createCompatAdapter({
      provider: "gemini",
      apiKey: "k",
      baseURL: "http://127.0.0.1:9",
      warn: (l) => seen.push(l),
    });
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_ORG_ID).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("OPENAI_BASE_URL");
  });

  test("listModels reads GET /models for each provider", async () => {
    fakes.openrouter.models = [
      { id: "v/a", name: "A", pricing: { prompt: "0.000001", completion: "0.000002" } },
    ];
    fakes.gemini.models = [
      { id: "models/g-1", object: "model", owned_by: "google", display_name: "G 1" },
    ];
    const signal = new AbortController().signal;
    expect((await adapters.openrouter.listModels(signal)).map((m) => m.id)).toEqual(["v/a"]);
    expect(await adapters.gemini.listModels(signal)).toEqual([{ id: "g-1", label: "G 1" }]);
  });
});
