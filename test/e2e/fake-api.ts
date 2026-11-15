/** What the fake model answers to the main agent request of a step. */
export type Reply = { readonly kind: "text" } | { readonly kind: "run"; readonly command: string };

export interface Captured {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeApi {
  readonly url: string;
  /** Starts a new capture with the given reply policy; the returned array fills as requests arrive. */
  begin(reply: Reply): Captured[];
  stop(): void;
}

export const TOOL_USE_ID = "toolu_e2e_memory";

/**
 * One loopback server for both protocols: Anthropic Messages (claude) and Gemini
 * generateContent (agy with GOOGLE_GEMINI_BASE_URL). A "run" reply asks for the shell tool
 * once; the follow-up request that carries the tool's result gets plain text, ending the turn.
 */
export function startFakeApi(): FakeApi {
  let reply: Reply = { kind: "text" };
  let captured: Captured[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      captured.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers),
        body,
      });
      const json = parseObject(body);
      const path = url.pathname;
      if (path.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 1 });
      if (path.endsWith("/messages")) return anthropic(json, reply);
      if (path.includes(":countTokens")) return Response.json({ totalTokens: 1 });
      if (path.includes(":generateContent")) return Response.json(gemini(json, reply));
      if (path.includes(":streamGenerateContent")) {
        const chunk = gemini(json, reply);
        return url.searchParams.get("alt") === "sse"
          ? sse([[null, chunk]])
          : Response.json([chunk]);
      }
      return Response.json({ error: { message: "fake api: unknown path" } }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    begin(next) {
      reply = next;
      captured = [];
      return captured;
    },
    stop: () => void server.stop(true),
  };
}

type Json = Record<string, unknown>;

function parseObject(text: string): Json {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Json) : {};
  } catch {
    return {};
  }
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

function sse(events: readonly (readonly [string | null, unknown])[]): Response {
  const text = events
    .map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function anthropic(json: Json, reply: Reply): Response {
  const offersBash = list(json.tools).some((tool) => tool.name === "Bash");
  const answered = list(json.messages).some((message) =>
    list(message.content).some((block) => block.tool_use_id === TOOL_USE_ID),
  );
  const block =
    reply.kind === "run" && offersBash && !answered
      ? {
          type: "tool_use",
          id: TOOL_USE_ID,
          name: "Bash",
          input: { command: reply.command, description: "Record a memory entry" },
        }
      : { type: "text", text: "OK" };
  const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = {
    id: "msg_e2e",
    type: "message",
    role: "assistant",
    model: typeof json.model === "string" ? json.model : "fake",
    content: [] as unknown[],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (json.stream !== true) {
    return Response.json({ ...message, content: [block], stop_reason: stop });
  }
  const delta =
    block.type === "tool_use"
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: "OK" };
  const start = block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" };
  return sse([
    ["message_start", { type: "message_start", message }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: start }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function gemini(json: Json, reply: Reply): Json {
  const offersShell = list(json.tools).some((tool) =>
    list(tool.functionDeclarations).some((fn) => fn.name === "run_command"),
  );
  const answered = list(json.contents).some((content) =>
    list(content.parts).some((part) => part.functionResponse !== undefined),
  );
  const part =
    reply.kind === "run" && offersShell && !answered
      ? {
          functionCall: {
            name: "run_command",
            args: {
              CommandLine: reply.command,
              toolSummary: "Memory write",
              WaitMsBeforeAsync: 10000,
            },
          },
        }
      : { text: "OK" };
  return {
    candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    modelVersion: "fake",
  };
}
