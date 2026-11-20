/**
 * A stand-in for the Anthropic API on 127.0.0.1. POST /v1/messages answers with SSE from a
 * queue of scripted replies (or a handler once the queue is empty); GET /v1/models pages through
 * a settable list. Every request's body and headers are recorded.
 */

export type FakeBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string };

export interface FakeUsage {
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
  /** Absent: output_tokens_details is null. */
  readonly thinking?: number;
}

export type FakeReply =
  | {
      readonly kind: "message";
      readonly blocks: readonly FakeBlock[];
      /** end_turn by default; tool_use when a block is one. */
      readonly stop?: string;
      readonly usage?: FakeUsage;
    }
  | {
      readonly kind: "http_error";
      readonly status: number;
      readonly type: string;
      readonly message?: string;
      readonly errorCode?: string;
      readonly retryAfter?: string;
    }
  /** Some blocks, then `event: error` with this type. */
  | { readonly kind: "stream_error"; readonly blocks: readonly FakeBlock[]; readonly type: string }
  /** Some blocks, then the connection closes without message_stop. */
  | { readonly kind: "disconnect"; readonly blocks: readonly FakeBlock[] }
  /** message_start, then nothing until the client gives up. */
  | { readonly kind: "hang"; readonly usage?: FakeUsage };

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export interface FakeModel {
  readonly id: string;
  readonly display_name?: string;
  readonly lifecycle?: "active" | "deprecated" | "retired";
  readonly retires_at?: string | null;
  readonly max_input_tokens?: number | null;
  readonly max_tokens?: number | null;
  readonly capabilities?: unknown;
}

export interface FakeAnthropic {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Requests to /v1/messages only, in order. */
  messages(): RecordedRequest[];
  reply(...replies: FakeReply[]): void;
  /** Answers once the queue is empty; without one an empty queue is a 500. */
  handler?: (body: Record<string, unknown>) => FakeReply;
  models: FakeModel[];
  stop(): Promise<void>;
}

export const text = (t: string): FakeReply => ({
  kind: "message",
  blocks: [{ type: "text", text: t }],
});

export const toolUse = (id: string, name: string, input: unknown, before = ""): FakeReply => ({
  kind: "message",
  blocks: [
    ...(before === "" ? [] : [{ type: "text" as const, text: before }]),
    { type: "tool_use", id, name, input },
  ],
});

export const tarsCall = (id: string, argv: readonly string[]) => toolUse(id, "tars", { argv });

const encoder = new TextEncoder();
const sse = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function usageJson(u: FakeUsage = {}) {
  return {
    input_tokens: u.input ?? 100,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    output_tokens: u.output ?? 10,
    output_tokens_details: u.thinking === undefined ? null : { thinking_tokens: u.thinking },
  };
}

/** The SSE events for each block, in order. */
function blockEvents(blocks: readonly FakeBlock[]): Uint8Array[] {
  return blocks.flatMap((block, index) => {
    if (block.type === "text")
      return [
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
        // Two pieces, so a client sees a stream rather than one chunk.
        ...[
          block.text.slice(0, Math.ceil(block.text.length / 2)),
          block.text.slice(Math.ceil(block.text.length / 2)),
        ]
          .filter((t) => t !== "")
          .map((t) =>
            sse("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: t },
            }),
          ),
        sse("content_block_stop", { type: "content_block_stop", index }),
      ];
    if (block.type === "thinking")
      return [
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        }),
        sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        }),
        sse("content_block_stop", { type: "content_block_stop", index }),
      ];
    return [
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    ];
  });
}

function messageStart(model: string, u?: FakeUsage) {
  const usage = usageJson(u);
  return sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 1, output_tokens_details: null },
    },
  });
}

function streamReply(reply: FakeReply, model: string, signal: AbortSignal): Response {
  if (reply.kind === "http_error") {
    const error = {
      type: reply.type,
      message: reply.message ?? reply.type,
      ...(reply.errorCode === undefined ? {} : { details: { error_code: reply.errorCode } }),
    };
    return Response.json(
      { type: "error", error },
      {
        status: reply.status,
        headers: reply.retryAfter === undefined ? {} : { "retry-after": reply.retryAfter },
      },
    );
  }
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunks: readonly Uint8Array[]) => {
        for (const c of chunks) controller.enqueue(c);
      };
      if (reply.kind === "hang") {
        send([messageStart(model, reply.usage)]);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        return controller.close();
      }
      send([
        messageStart(model, reply.kind === "message" ? reply.usage : undefined),
        ...blockEvents(reply.blocks),
      ]);
      if (reply.kind === "stream_error") {
        send([sse("error", { type: "error", error: { type: reply.type, message: reply.type } })]);
        return controller.close();
      }
      if (reply.kind === "disconnect") return controller.close();
      const stop =
        reply.stop ?? (reply.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
      const usage = usageJson(reply.usage);
      send([
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage,
        }),
        sse("message_stop", { type: "message_stop" }),
      ]);
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function modelsPage(models: readonly FakeModel[], url: URL): Response {
  const limit = Number(url.searchParams.get("limit") ?? "20");
  const after = url.searchParams.get("after_id");
  const start = after === null ? 0 : models.findIndex((m) => m.id === after) + 1;
  const page = models.slice(start, start + limit).map((m) => ({
    type: "model",
    id: m.id,
    display_name: m.display_name ?? m.id,
    created_at: "2026-01-01T00:00:00Z",
    lifecycle: m.lifecycle ?? "active",
    retires_at: m.retires_at ?? null,
    deprecated_at: null,
    line: null,
    max_input_tokens: m.max_input_tokens ?? null,
    max_tokens: m.max_tokens ?? null,
    capabilities: m.capabilities ?? null,
  }));
  return Response.json({
    data: page,
    has_more: start + limit < models.length,
    first_id: page[0]?.id ?? null,
    last_id: page.at(-1)?.id ?? null,
  });
}

/** Capabilities as the models endpoint reports them, for the given levels and thinking types. */
export function capabilities(
  efforts: readonly string[],
  thinking: readonly string[] = ["adaptive", "disabled"],
) {
  const support = (on: boolean) => ({ supported: on });
  const level = (l: string) => support(efforts.includes(l));
  return {
    effort: {
      supported: efforts.length > 0,
      low: level("low"),
      medium: level("medium"),
      high: level("high"),
      xhigh: efforts.includes("xhigh") ? support(true) : null,
      max: level("max"),
    },
    thinking: {
      supported: thinking.length > 0,
      types: {
        adaptive: support(thinking.includes("adaptive")),
        between_tools: support(thinking.includes("between_tools")),
        disabled: support(thinking.includes("disabled")),
        enabled: support(thinking.includes("enabled")),
      },
    },
  };
}

export function startFakeAnthropic(): FakeAnthropic {
  const requests: RecordedRequest[] = [];
  const queue: FakeReply[] = [];
  const fake: FakeAnthropic = {
    url: "",
    requests,
    messages: () => requests.filter((r) => r.path === "/v1/messages"),
    reply: (...replies) => void queue.push(...replies),
    models: [],
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
      if (req.method === "GET" && url.pathname === "/v1/models")
        return modelsPage(fake.models, url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages")
        return new Response("not found", { status: 404 });
      const reply = queue.shift() ?? fake.handler?.(body);
      if (reply === undefined)
        return Response.json(
          { type: "error", error: { type: "api_error", message: "fake: no reply queued" } },
          { status: 500 },
        );
      return streamReply(reply, String(body.model), req.signal);
    },
  });
  return Object.assign(fake, { url: `http://127.0.0.1:${server.port}` });
}
