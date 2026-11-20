import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlockParam,
  Usage as AnthropicUsage,
} from "@anthropic-ai/sdk/resources/messages";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";
import { clipToolResult } from "./bytes.ts";
import { ProviderError, type ProviderAdapter, type ProviderErrorKind } from "./provider.ts";
import {
  EFFORTS,
  type Effort,
  type Item,
  type ListedModel,
  type ModelRequest,
  type ProviderEvent,
  type StopReason,
  type Usage,
} from "./types.ts";

export interface AnthropicAdapterOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly warn: (line: string) => void;
}

const DETAIL_LIMIT = 500;

/**
 * The SDK falls back to ANTHROPIC_* variables (base URL, log level, custom headers, telemetry)
 * for any option left out, so a proxy setting left in the parent shell could send the key
 * elsewhere. They are removed from this process, and every option is passed explicitly.
 */
export function createAnthropicAdapter(opts: AnthropicAdapterOptions): ProviderAdapter {
  const ignored = Object.keys(process.env).filter((k) => k.startsWith("ANTHROPIC_"));
  for (const k of ignored) delete process.env[k];
  if (ignored.length > 0) opts.warn(`已忽略這些環境變數：${ignored.join(", ")}`);
  const client = new Anthropic({
    apiKey: opts.apiKey,
    authToken: null,
    baseURL: opts.baseURL,
    maxRetries: 0,
    logLevel: "off",
    openTelemetry: false,
  });
  return {
    provider: "anthropic",
    stream: (req, signal) => streamMessages(client, req, signal),
    listModels: async (signal) => {
      const models: ListedModel[] = [];
      try {
        for await (const m of client.models.list({ limit: 100 }, { signal }))
          models.push(listed(m));
      } catch (err) {
        throw toProviderError(err, signal, { receivedStart: false, receivedContent: false });
      }
      return models;
    },
  };
}

async function* streamMessages(
  client: Anthropic,
  req: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const seen = { receivedStart: false, receivedContent: false };
  try {
    const stream = client.messages.stream(requestBody(req), { signal });
    for await (const ev of stream) {
      if (ev.type === "message_start") {
        seen.receivedStart = true;
        yield { type: "start", usage: usageOf(ev.message.usage) };
      } else if (ev.type === "content_block_start") {
        const block = ev.content_block.type;
        if (block === "thinking" || block === "redacted_thinking") yield { type: "thinking" };
        if (block === "tool_use") seen.receivedContent = true;
      } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        seen.receivedContent = true;
        yield { type: "text", delta: ev.delta.text };
      }
    }
    // An error that arrives while no read is pending ends the iteration quietly; finalMessage
    // still rejects with it.
    const message = await stream.finalMessage();
    const stop = stopOf(message.stop_reason);
    // Tool calls exist only when the model stopped for them: a tool_use cut off by max_tokens
    // has no result to pair with, and stored it would make every later request a 400.
    const kept =
      stop === "tool_use" ? message.content : message.content.filter((b) => b.type !== "tool_use");
    for (const block of kept)
      if (block.type === "tool_use")
        yield { type: "tool_call", providerCallId: block.id, name: block.name, input: block.input };
    yield {
      type: "end",
      stop,
      usage: usageOf(message.usage),
      // Thinking alone is not a message the API takes back; nothing is replayed then.
      native: kept.some((b) => b.type === "text" || b.type === "tool_use") ? kept : [],
    };
  } catch (err) {
    throw toProviderError(err, signal, seen);
  }
}

export function requestBody(req: ModelRequest): MessageCreateParamsNonStreaming {
  const cacheControl = { type: "ephemeral" as const, ttl: req.cacheTtl };
  const body: MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    system: req.system.map((b): TextBlockParam => ({
      type: "text",
      text: b.text,
      ...(b.cache ? { cache_control: cacheControl } : {}),
    })),
    messages: toMessages(
      req.history,
      req.toolResultBytes,
      req.cacheHistory ? cacheControl : null,
      req.thinkingKey,
    ),
  };
  if (req.tools.length > 0)
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as { type: "object" },
    }));
  const thinking = req.capabilities.thinkingTypes;
  if (req.effort === "off") {
    if (thinking.includes("disabled")) body.thinking = { type: "disabled" };
  } else if (req.effort !== undefined) {
    body.output_config = { effort: req.effort };
    if (thinking.includes("adaptive")) body.thinking = { type: "adaptive" };
  }
  return body;
}

/**
 * Converts each item, then merges neighbours of the same role: tool results of one step, a
 * user message after tool results or after a failed turn, and the summary before the first
 * kept user message all become one message, so roles alternate and the first one is the user's.
 */
export function toMessages(
  history: readonly Item[],
  toolResultBytes: number,
  cacheControl: { type: "ephemeral"; ttl: "5m" | "1h" } | null,
  thinkingKey: string,
): MessageParam[] {
  const providerIds = new Map<string, string>();
  for (const item of history)
    if (item.kind === "tool_call") providerIds.set(item.body.callId, item.body.providerCallId);
  const messages: MessageParam[] = [];
  const push = (role: "user" | "assistant", content: ContentBlockParam[]) => {
    const last = messages.at(-1);
    if (last?.role === role) (last.content as ContentBlockParam[]).push(...content);
    else messages.push({ role, content: [...content] });
  };
  const stale = lastStaleThinking(history, thinkingKey);
  for (const [i, item] of history.entries()) {
    if (item.kind === "user") push("user", [{ type: "text", text: item.body.text }]);
    else if (item.kind === "assistant") {
      const native = item.body.native as ContentBlockParam[] | null;
      const kept = native !== null && i <= stale ? native.filter((b) => !isThinking(b)) : native;
      if (kept !== null && kept.length > 0) push("assistant", kept);
      else if (item.body.text !== "") push("assistant", [{ type: "text", text: item.body.text }]);
    } else if (item.kind === "tool_result") {
      const { text } = clipToolResult(item.body.text, toolResultBytes);
      push("user", [
        {
          type: "tool_result",
          tool_use_id: providerIds.get(item.body.callId) ?? item.body.callId,
          content: text,
          ...(item.body.status === "done" ? {} : { is_error: true }),
        },
      ]);
    }
  }
  const last = messages.at(-1);
  if (cacheControl !== null && last !== undefined) {
    const content = last.content as ContentBlockParam[];
    const block = content.at(-1);
    if (block !== undefined)
      content[content.length - 1] = { ...block, cache_control: cacheControl } as ContentBlockParam;
  }
  return messages;
}

const isThinking = (b: unknown) =>
  (b as { type?: unknown }).type === "thinking" ||
  (b as { type?: unknown }).type === "redacted_thinking";

/**
 * Index of the last assistant item whose thinking was made under another key, or -1. The
 * provider accepts a history with a leading run of thinking blocks removed but not one with a
 * block removed from the middle, so every thinking block up to this one goes.
 */
function lastStaleThinking(history: readonly Item[], thinkingKey: string): number {
  let stale = -1;
  for (const [i, item] of history.entries())
    if (
      item.kind === "assistant" &&
      item.body.thinkingKey !== thinkingKey &&
      (item.body.native ?? []).some(isThinking)
    )
      stale = i;
  return stale;
}

const usageOf = (u: AnthropicUsage): Usage => ({
  uncachedInputTokens: u.input_tokens ?? 0,
  cacheReadTokens: u.cache_read_input_tokens ?? 0,
  cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  outputTokens: u.output_tokens ?? 0,
  thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
});

const stopOf = (reason: string | null): StopReason =>
  reason === "end_turn"
    ? "end"
    : reason === "tool_use"
      ? "tool_use"
      : reason === "max_tokens"
        ? "max_tokens"
        : "other";

/** The error classes in the order the design's table checks them; the first match wins. */
export function toProviderError(
  err: unknown,
  signal: AbortSignal,
  seen: { receivedStart: boolean; receivedContent: boolean },
): unknown {
  const make = (kind: ProviderErrorKind, extra: { retryAfterMs?: number; detail?: string } = {}) =>
    new ProviderError(kind, {
      ...seen,
      ...(err instanceof APIError && err.status !== undefined ? { status: err.status } : {}),
      ...extra,
    });
  if (err instanceof APIUserAbortError || signal.aborted) return make("aborted");
  if (err instanceof APIError) {
    const { status, type } = err;
    if (err.errorCode === "enforced_spend_limit_reached") return make("spend_limit");
    if (status === 429 || type === "rate_limit_error") {
      const retryAfterMs = retryAfter(err.headers);
      return make("rate_limit", retryAfterMs === undefined ? {} : { retryAfterMs });
    }
    if (status === 529 || type === "overloaded_error") return make("overloaded");
    if (status === 408) return make("connection");
    if ((status !== undefined && status >= 500) || type === "api_error") return make("server");
    if (status === 401 || status === 403) return make("auth");
    if (err instanceof APIConnectionError) return make("connection");
    const detail = err.apiMessage?.slice(0, DETAIL_LIMIT);
    return make("bad_request", detail === undefined ? {} : { detail });
  }
  if (err instanceof AnthropicError) return make("connection");
  return err;
}

function retryAfter(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value == null || !/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  return Math.round(Number(value) * 1000);
}

function listed(m: ModelInfo): ListedModel {
  const caps = m.capabilities;
  const effort = caps?.effort;
  return {
    id: m.id,
    label: m.display_name,
    lifecycle: m.lifecycle,
    ...(m.retires_at ? { retiresAt: m.retires_at } : {}),
    ...(m.max_input_tokens != null ? { contextWindow: m.max_input_tokens } : {}),
    ...(m.max_tokens != null ? { maxOutput: m.max_tokens } : {}),
    ...(caps == null
      ? {}
      : {
          effortLevels:
            effort?.supported === true
              ? EFFORTS.filter((level: Effort) => effort[level]?.supported === true)
              : [],
          thinkingTypes: Object.entries(caps.thinking?.types ?? {})
            .filter(([, support]) => support?.supported === true)
            .map(([name]) => name),
        }),
  };
}
