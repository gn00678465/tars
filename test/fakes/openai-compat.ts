/**
 * A stand-in for an OpenAI-compatible endpoint (Gemini's or OpenRouter's) on 127.0.0.1.
 * POST /chat/completions answers with SSE from a queue of scripted replies (or a handler once
 * the queue is empty); GET /models and GET /key answer from settable values. Every request is
 * recorded. In gemini mode a current-turn tool call sent back without its thought_signature is a
 * 400, as the real endpoint does (P2 item 7).
 */

export type CompatMode = "gemini" | "openrouter";

export interface FakeCompatUsage {
  readonly prompt?: number;
  readonly completion?: number;
  /** Gemini: total − prompt includes thinking that completion leaves out. null: not sent. */
  readonly total?: number | null;
  readonly cached?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly cost?: number;
}

export interface FakeToolCall {
  readonly id: string;
  readonly name: string;
  /** A string is sent as is (it may be invalid JSON); anything else is JSON-encoded. */
  readonly args: unknown;
  readonly signature?: string;
  /** Extra keys on the tool call, as an upstream may add. */
  readonly extra?: Record<string, unknown>;
  /** Extra keys inside extra_content.google besides thought_signature. */
  readonly googleExtra?: Record<string, unknown>;
}

export type FakeCompatReply =
  | {
      readonly kind: "message";
      readonly text?: string;
      readonly toolCalls?: readonly FakeToolCall[];
      /** Default: tool_calls with calls, else stop. null: none is sent (the stream just ends). */
      readonly finish?: string | null;
      /** null: no usage at all. Default: a small usage. */
      readonly usage?: FakeCompatUsage | null;
      /** A reasoning delta before the text. */
      readonly reasoning?: boolean;
      /** Two chunks for the same call, each with its own signature; the second should win. */
      readonly resendSignature?: string;
    }
  | {
      readonly kind: "http_error";
      readonly status: number;
      /** The body as sent; default { error: { message } }. */
      readonly body?: unknown;
      readonly message?: string;
      readonly retryAfter?: string;
    }
  /** Some text, then a chunk carrying `error`. */
  | { readonly kind: "stream_error"; readonly text: string }
  /** Some text, then the connection closes without a finish_reason. */
  | { readonly kind: "disconnect"; readonly text: string }
  /** One chunk, then nothing until the client gives up. */
  | { readonly kind: "hang"; readonly text?: string };

export interface CompatRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export interface FakeKey {
  limit: number | null;
  limit_remaining: number | null;
  [k: string]: unknown;
}

export interface FakeCompat {
  readonly url: string;
  readonly mode: CompatMode;
  readonly requests: CompatRequest[];
  /** POST /chat/completions only, in order. */
  chats(): CompatRequest[];
  reply(...replies: FakeCompatReply[]): void;
  handler?: (body: Record<string, unknown>) => FakeCompatReply;
  /** Raw entries of GET /models. */
  models: unknown[];
  /** GET /key's data; "hang" never answers, a number is that HTTP status. */
  key: FakeKey | "hang" | number;
  stop(): Promise<void>;
}

export const compatText = (t: string, usage?: FakeCompatUsage | null): FakeCompatReply => ({
  kind: "message",
  text: t,
  ...(usage === undefined ? {} : { usage }),
});

export const compatCall = (
  id: string,
  name: string,
  args: unknown,
  more: Partial<FakeToolCall> = {},
): FakeCompatReply => ({ kind: "message", toolCalls: [{ id, name, args, ...more }] });

const encoder = new TextEncoder();
const data = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const DONE = encoder.encode("data: [DONE]\n\n");

function usageJson(u: FakeCompatUsage, share = 1) {
  const prompt = u.prompt ?? 100;
  const completion = Math.round((u.completion ?? 10) * share);
  const details =
    u.cached === undefined && u.cacheWrite === undefined
      ? {}
      : {
          prompt_tokens_details: {
            cached_tokens: u.cached ?? 0,
            ...(u.cacheWrite === undefined ? {} : { cache_write_tokens: u.cacheWrite }),
          },
        };
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    ...(u.total === null
      ? {}
      : {
          total_tokens:
            prompt + Math.round(((u.total ?? prompt + (u.completion ?? 10)) - prompt) * share),
        }),
    ...details,
    ...(u.reasoning === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: u.reasoning } }),
    ...(u.cost === undefined ? {} : { cost: u.cost }),
  };
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

function messageChunks(mode: CompatMode, reply: Extract<FakeCompatReply, { kind: "message" }>) {
  const out: Record<string, unknown>[] = [chunk({ role: "assistant", content: "" })];
  if (reply.reasoning === true) out.push(chunk({ reasoning: "thinking it over" }));
  const text = reply.text ?? "";
  // Two pieces, so a client sees a stream rather than one chunk.
  const half = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)])
    if (piece !== "") out.push(chunk({ content: piece }));
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    const args = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
    const mid = Math.ceil(args.length / 2);
    const google =
      call.signature === undefined && call.googleExtra === undefined
        ? undefined
        : {
            google: {
              ...(call.signature === undefined ? {} : { thought_signature: call.signature }),
              ...call.googleExtra,
            },
            other_vendor: { x: 1 },
          };
    out.push(
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: args.slice(0, mid) },
            ...(google === undefined ? {} : { extra_content: google }),
            ...call.extra,
          },
        ],
      }),
      chunk({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] }),
    );
    if (reply.resendSignature !== undefined)
      out.push(
        chunk({
          tool_calls: [
            { index, extra_content: { google: { thought_signature: reply.resendSignature } } },
          ],
        }),
      );
  }
  const finish =
    reply.finish === undefined
      ? (reply.toolCalls ?? []).length > 0
        ? "tool_calls"
        : "stop"
      : reply.finish;
  if (finish !== null)
    out.push({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  const usage = reply.usage === undefined ? {} : reply.usage;
  if (usage !== null) {
    if (mode === "gemini")
      // Every chunk carries the running totals; the last one has the final numbers.
      out.forEach((c, i) => {
        c.usage = usageJson(usage, (i + 1) / out.length);
      });
    else out.push({ ...chunk({}), choices: [], usage: usageJson(usage) });
  }
  return out;
}

/** In gemini mode: is a current-turn tool call missing its signature? */
function missingSignature(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  return messages
    .slice(lastUser + 1)
    .some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        (m.tool_calls as Record<string, unknown>[]).some(
          (c) =>
            typeof (c.extra_content as { google?: { thought_signature?: unknown } } | undefined)
              ?.google?.thought_signature !== "string",
        ),
    );
}

const errorBody = (mode: CompatMode, status: number, message: string) => {
  const error = { code: status, message, status: "INVALID_ARGUMENT" };
  return mode === "gemini" ? [{ error }] : { error };
};

function streamReply(mode: CompatMode, reply: FakeCompatReply, signal: AbortSignal): Response {
  if (reply.kind === "http_error")
    return Response.json(
      reply.body ?? { error: { message: reply.message ?? `HTTP ${reply.status}` } },
      {
        status: reply.status,
        headers: reply.retryAfter === undefined ? {} : { "retry-after": reply.retryAfter },
      },
    );
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunks: readonly Record<string, unknown>[]) => {
        for (const c of chunks) controller.enqueue(data(c));
      };
      if (reply.kind === "hang") {
        send([chunk({ role: "assistant", content: reply.text ?? "" })]);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        return controller.close();
      }
      if (reply.kind === "stream_error" || reply.kind === "disconnect") {
        send([chunk({ role: "assistant", content: "" }), chunk({ content: reply.text })]);
        if (reply.kind === "stream_error")
          send([{ error: { message: "upstream broke", code: 502 } }]);
        return controller.close();
      }
      send(messageChunks(mode, reply));
      controller.enqueue(DONE);
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function startFakeCompat(mode: CompatMode): FakeCompat {
  const requests: CompatRequest[] = [];
  const queue: FakeCompatReply[] = [];
  const fake: FakeCompat = {
    url: "",
    mode,
    requests,
    chats: () => requests.filter((r) => r.path === "/chat/completions"),
    reply: (...replies) => void queue.push(...replies),
    models: [],
    key: { limit: 10, limit_remaining: 10 },
    stop: async () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" ? await req.text() : "";
      const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      requests.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        body,
      });
      if (req.method === "GET" && url.pathname === "/models")
        return Response.json(
          mode === "gemini" ? { object: "list", data: fake.models } : { data: fake.models },
        );
      if (req.method === "GET" && url.pathname === "/key") {
        const key = fake.key;
        if (key === "hang")
          return new Promise<Response>((resolve) =>
            req.signal.addEventListener("abort", () => resolve(new Response("", { status: 499 }))),
          );
        if (typeof key === "number") return new Response("no", { status: key });
        return Response.json({ data: key });
      }
      if (req.method !== "POST" || url.pathname !== "/chat/completions")
        return new Response("not found", { status: 404 });
      if (mode === "gemini" && missingSignature(body))
        return Response.json(
          errorBody(
            mode,
            400,
            "Function call is missing a thought_signature in functionCall parts.",
          ),
          { status: 400 },
        );
      const reply = queue.shift() ?? fake.handler?.(body);
      if (reply === undefined)
        return Response.json(errorBody(mode, 500, "fake: no reply queued"), { status: 500 });
      return streamReply(mode, reply, req.signal);
    },
  });
  return Object.assign(fake, { url: `http://127.0.0.1:${server.port}` });
}
