import OpenAI, { APIConnectionError, APIError, APIUserAbortError, OpenAIError } from "openai";
import { clipToolResult, cutUtf8, utf8Bytes } from "./bytes.ts";
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

export type CompatProvider = "gemini" | "openrouter";

export interface CompatAdapterOptions {
  readonly provider: CompatProvider;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly warn: (line: string) => void;
}

export { COMPAT_ENDPOINTS as ENDPOINTS } from "./provider.ts";

const DETAIL_LIMIT = 500;
const INVALID_ARGUMENTS_BYTES = 2000;
/** D31: a Gemini signature above this fails the response rather than being dropped. */
export const SIGNATURE_LIMIT = 16384;
const DATA_POLICY_DETAIL =
  "OpenRouter 沒有符合資料政策的上游能服務這個模型。換一個模型，或檢查 OpenRouter 帳號的資料政策設定";

/**
 * The SDK falls back to OPENAI_* variables (base URL, organization, log level, custom headers)
 * for any option left out, so a setting left in the parent shell could send the key elsewhere.
 * They are removed from this process, and every option is passed explicitly.
 */
export function createCompatAdapter(opts: CompatAdapterOptions): ProviderAdapter {
  const ignored = Object.keys(process.env).filter((k) => k.startsWith("OPENAI_"));
  for (const k of ignored) delete process.env[k];
  if (ignored.length > 0) opts.warn(`已忽略這些環境變數：${ignored.join(", ")}`);
  const client = new OpenAI({
    apiKey: opts.apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: opts.baseURL,
    maxRetries: 0,
    logLevel: "off",
    fetch: unwrapArrayErrors,
  });
  const { provider, apiKey } = opts;
  return {
    provider,
    stream: (req, signal) => streamChat(client, provider, apiKey, req, signal),
    listModels: async (signal) => {
      const raw: unknown[] = [];
      try {
        for await (const m of client.models.list({ signal })) raw.push(m);
      } catch (err) {
        throw toProviderError(
          err,
          provider,
          signal,
          { receivedStart: false, receivedContent: false },
          apiKey,
        );
      }
      return provider === "openrouter" ? listOpenRouter(raw, new Date()) : listGemini(raw);
    },
  };
}

/**
 * Gemini answers errors with a JSON array, `[{ "error": … }]`, which the SDK cannot read: it
 * reports "status code (no body)" and the message, the one way to tell a bad key, is lost. The
 * first element is handed to the SDK instead.
 */
async function unwrapArrayErrors(input: string | URL | Request, init?: RequestInit) {
  const res = await fetch(input, init);
  if (res.ok) return res;
  const text = await res.text();
  let body = text;
  try {
    const json: unknown = JSON.parse(text);
    if (Array.isArray(json) && json.length > 0) body = JSON.stringify(json[0]);
  } catch {
    // Not JSON: the SDK reports the text as it is.
  }
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

// --- Request.

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  extra_content?: { google: { thought_signature: string } };
}

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function requestBody(req: ModelRequest, provider: CompatProvider): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toChatMessages(req),
    stream: true,
    max_tokens: req.maxOutputTokens,
  };
  if (req.tools.length > 0) body.tools = req.tools.map(toFunctionTool);
  Object.assign(body, effortParams(req, provider));
  if (provider === "gemini") body.stream_options = { include_usage: true };
  // D27: no upstream that keeps or trains on the content.
  if (provider === "openrouter") body.provider = { data_collection: "deny" };
  return body;
}

export const toFunctionTool = (t: ModelRequest["tools"][number]) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
});

/**
 * "off" sends the off setting only to a model listed as able to turn reasoning off; one that is
 * not would answer 400 (P2 item 5), so it gets its lowest level instead (D32), or nothing.
 */
function effortParams(req: ModelRequest, provider: CompatProvider): Record<string, unknown> {
  const level = (e: Effort) =>
    provider === "gemini" ? { reasoning_effort: e } : { reasoning: { effort: e } };
  if (req.effort === undefined) return {};
  if (req.effort !== "off") return level(req.effort);
  if (req.capabilities.thinkingTypes.includes("disabled"))
    return provider === "gemini" ? { reasoning_effort: "none" } : { reasoning: { enabled: false } };
  const lowest = EFFORTS.find((e) => req.capabilities.effortLevels.includes(e));
  return lowest === undefined ? {} : level(lowest);
}

/**
 * Converts each item, then merges neighbours of the same role (the carried text, the wiki index
 * and the message; the summary and the first kept message; a message after a failed turn), so
 * the history the endpoint sees is always well formed.
 */
export function toChatMessages(req: ModelRequest): ChatMessage[] {
  const history = req.history;
  const providerIds = new Map<string, string>();
  for (const item of history)
    if (item.kind === "tool_call") providerIds.set(item.body.callId, item.body.providerCallId);
  const currentTurn = history.findLastIndex((i) => i.kind === "user");
  const messages: ChatMessage[] = [];
  const system = req.system.map((b) => b.text).join("\n\n");
  if (system !== "") messages.push({ role: "system", content: system });
  const push = (m: ChatMessage) => {
    const last = messages.at(-1);
    if (m.role === "user" && last?.role === "user")
      last.content = `${last.content}\n\n${m.content}`;
    else if (m.role === "assistant" && last?.role === "assistant") {
      const texts = [last.content, m.content].filter((t): t is string => t !== null && t !== "");
      last.content = texts.length === 0 ? null : texts.join("\n\n");
      if (m.tool_calls !== undefined) last.tool_calls = m.tool_calls;
    } else messages.push(m);
  };
  for (const [i, item] of history.entries()) {
    if (item.kind === "user") push({ role: "user", content: item.body.text });
    else if (item.kind === "assistant") {
      const stored = item.body.native?.[0] as ChatMessage | undefined;
      if (stored !== undefined && stored.role === "assistant")
        push(
          stale(item, i, currentTurn, req.thinkingKey) ? withoutSignatures(stored) : clone(stored),
        );
      else if (item.body.text !== "") push({ role: "assistant", content: item.body.text });
    } else if (item.kind === "tool_result") {
      const { text } = clipToolResult(item.body.text, req.toolResultBytes);
      push({
        role: "tool",
        tool_call_id: providerIds.get(item.body.callId) ?? item.body.callId,
        content: text,
      });
    }
  }
  return messages;
}

/**
 * Gemini checks signatures only in the current turn, the part after the last user message (P2
 * item 7, note 13.4). A finished turn made under another thinkingKey sends its calls without
 * them: they were made against a context that changed, and sent without one is known to pass.
 */
const stale = (item: Item, i: number, currentTurn: number, thinkingKey: string) =>
  i < currentTurn && item.kind === "assistant" && item.body.thinkingKey !== thinkingKey;

const clone = (m: Extract<ChatMessage, { role: "assistant" }>): ChatMessage => ({
  ...m,
  ...(m.tool_calls === undefined ? {} : { tool_calls: m.tool_calls.map((c) => ({ ...c })) }),
});

function withoutSignatures(m: Extract<ChatMessage, { role: "assistant" }>): ChatMessage {
  if (m.tool_calls === undefined) return { ...m };
  return {
    ...m,
    tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: c.type, function: c.function })),
  };
}

// --- Stream.

/** As the upstream sent it: any field may be missing or of another type. */
interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  cost?: unknown;
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: { google?: { thought_signature?: unknown } };
}

interface RawChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: unknown;
      reasoning_content?: unknown;
      reasoning_details?: unknown;
      tool_calls?: RawToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
  error?: unknown;
}

interface PartialCall {
  id: string;
  name: string;
  args: string;
  signature?: string;
}

async function* streamChat(
  client: OpenAI,
  provider: CompatProvider,
  apiKey: string,
  req: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const seen = { receivedStart: false, receivedContent: false, responded: false };
  try {
    const stream = (await client.chat.completions.create(
      requestBody(req, provider) as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal },
    )) as unknown as AsyncIterable<RawChunk>;
    seen.responded = true;
    let text = "";
    let thinking = false;
    let finish: string | undefined;
    let usage: RawUsage | undefined;
    const calls = new Map<number, PartialCall>();
    for await (const chunk of stream) {
      if (!seen.receivedStart) {
        seen.receivedStart = true;
        yield { type: "start" };
      }
      if (chunk.error !== undefined && chunk.error !== null)
        throw new ProviderError("server", { ...seen });
      // Gemini sends the running totals on every chunk, OpenRouter once at the end: the last wins.
      if (chunk.usage != null) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;
      const delta = choice.delta ?? {};
      if (!thinking && hasReasoning(delta)) {
        thinking = true;
        yield { type: "thinking" };
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        seen.receivedContent = true;
        text += delta.content;
        yield { type: "text", delta: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        seen.receivedContent = true;
        const at = tc.index ?? 0;
        const call = calls.get(at) ?? { id: "", name: "", args: "" };
        calls.set(at, call);
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name = tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
        const signature = tc.extra_content?.google?.thought_signature;
        // A later chunk for the same call replaces an earlier signature [unconfirmed: P2 did not
        // see whether one is ever split].
        if (provider === "gemini" && typeof signature === "string") call.signature = signature;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (finish === undefined)
      throw new ProviderError("connection", { ...seen, mayHaveRun: !seen.receivedStart });
    const complete = [...calls.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([, c]) => c)
      .filter((c) => c.id !== "" && c.name !== "");
    const stop = stopOf(finish, complete.length > 0);
    const kept = stop === "tool_use" ? complete : [];
    for (const c of kept)
      if (c.signature !== undefined && utf8Bytes(c.signature) > SIGNATURE_LIMIT)
        throw new ProviderError("bad_request", { ...seen, detail: "thought_signature 超過上限" });
    for (const c of kept)
      yield {
        type: "tool_call",
        providerCallId: c.id,
        name: c.name,
        input: parseArguments(c.args),
      };
    const toolCalls = kept.map((c): ChatToolCall => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args },
      ...(c.signature === undefined
        ? {}
        : { extra_content: { google: { thought_signature: c.signature } } }),
    }));
    const native: ChatMessage[] =
      text === "" && toolCalls.length === 0
        ? []
        : [
            {
              role: "assistant",
              content: text === "" ? null : text,
              ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
            },
          ];
    const settled = usage === undefined ? undefined : usageOf(provider, usage);
    yield {
      type: "end",
      stop,
      ...(settled === undefined ? {} : { usage: settled.usage }),
      ...(settled?.costUsd === undefined ? {} : { costUsd: settled.costUsd }),
      native,
    };
  } catch (err) {
    throw toProviderError(err, provider, signal, seen, apiKey);
  }
}

const hasReasoning = (delta: NonNullable<NonNullable<RawChunk["choices"]>[number]["delta"]>) =>
  [delta.reasoning, delta.reasoning_content].some((v) => typeof v === "string" && v !== "") ||
  (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0);

/**
 * Gemini streams tool calls with finish_reason "stop" (P2 item 13): complete calls are run
 * whichever of the two it is, or they would be dropped without a word.
 */
function stopOf(finish: string, hasCalls: boolean): StopReason {
  if ((finish === "tool_calls" || finish === "stop") && hasCalls) return "tool_use";
  if (finish === "stop") return "end";
  if (finish === "length") return "max_tokens";
  return "other";
}

/** Invalid JSON reaches the tool as is, so its input check fails and the model sees what it sent. */
function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    const cut = cutUtf8(args, INVALID_ARGUMENTS_BYTES);
    return { _invalid_arguments: cut };
  }
}

const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** An optional field: undefined when absent (undefined or null), null when present but invalid. */
const optional = (v: unknown): number | undefined | null =>
  v === undefined || v === null ? undefined : amount(v) ? v : null;

/**
 * undefined when the usage cannot price the request: the caller then settles it as an estimate
 * that keeps its reservation, rather than at zero. Output tokens include thinking for every
 * provider. Gemini's completion_tokens leaves its thinking out and total − prompt puts it back
 * (P2 item 4), so without total_tokens Gemini's thinking is unknown. OpenRouter's reasoning
 * tokens are already inside completion_tokens.
 */
export function usageOf(
  provider: CompatProvider,
  u: RawUsage,
): { usage: Usage; costUsd?: number } | undefined {
  const prompt = u.prompt_tokens;
  const completion = u.completion_tokens;
  const total = optional(u.total_tokens);
  const cached = optional(u.prompt_tokens_details?.cached_tokens);
  const written = optional(u.prompt_tokens_details?.cache_write_tokens);
  const reasoning = optional(u.completion_tokens_details?.reasoning_tokens);
  const cost = provider === "openrouter" ? optional(u.cost) : undefined;
  if (!amount(prompt) || !amount(completion)) return undefined;
  if (total === null || cached === null || written === null || reasoning === null || cost === null)
    return undefined;
  if (provider === "gemini" && total === undefined) return undefined;
  const outputTokens =
    provider === "gemini" && total !== undefined
      ? Math.max(completion, total - prompt)
      : completion;
  const usage: Usage = {
    uncachedInputTokens: Math.max(0, prompt - (cached ?? 0) - (written ?? 0)),
    cacheReadTokens: cached ?? 0,
    cacheWriteTokens: written ?? 0,
    outputTokens,
    thinkingTokens: provider === "gemini" ? outputTokens - completion : (reasoning ?? 0),
  };
  return cost === undefined ? { usage } : { usage, costUsd: cost };
}

// --- Errors.

/** The error classes in the order the design's table checks them; the first match wins. */
export function toProviderError(
  err: unknown,
  provider: CompatProvider,
  signal: AbortSignal,
  seen: { receivedStart: boolean; receivedContent: boolean; responded?: boolean },
  apiKey: string,
): unknown {
  const status = err instanceof APIError ? err.status : undefined;
  const make = (
    kind: ProviderErrorKind,
    extra: { retryAfterMs?: number; detail?: string; mayHaveRun?: boolean } = {},
  ) =>
    new ProviderError(kind, {
      receivedStart: seen.receivedStart,
      receivedContent: seen.receivedContent,
      ...(status === undefined ? {} : { status }),
      ...extra,
    });
  // Sent and not refused, but no start: an abort, or a body that broke off after the headers.
  const unseen = { mayHaveRun: !seen.receivedStart };
  // First: an abort can end the SDK's stream quietly, which then reads as a missing finish.
  if (err instanceof APIUserAbortError || signal.aborted) return make("aborted", unseen);
  if (err instanceof ProviderError) return err;
  if (err instanceof APIError) {
    const message = messageOf(err) ?? "";
    const says = (words: string) => message.toLowerCase().includes(words);
    if (status === 402) return make("spend_limit");
    if (status === 401 || status === 403) return make("auth");
    if (provider === "gemini" && status === 400 && says("api key")) return make("auth");
    if (provider === "openrouter" && status === 404 && says("data policy"))
      return make("bad_request", { detail: DATA_POLICY_DETAIL });
    if (status === 429) {
      const retryAfterMs = retryAfter(err.headers);
      return make("rate_limit", retryAfterMs === undefined ? {} : { retryAfterMs });
    }
    if (status === 503 || status === 529) return make("overloaded");
    if (status === 408) return make("connection");
    if (status !== undefined && status >= 500) return make("server");
    if (err instanceof APIConnectionError)
      return make("connection", seen.responded === true ? unseen : {});
    if (status !== undefined) {
      const detail = detailOf(err, apiKey);
      return make("bad_request", detail === undefined ? {} : { detail });
    }
  }
  if (err instanceof OpenAIError) return make("connection", seen.responded === true ? unseen : {});
  return err;
}

/**
 * The detail is stored in the error item and shown on the terminal, and an upstream may echo the
 * request back. Only the body's error.message is kept: never metadata.raw, the rest of the body,
 * or a body that is not JSON. The key is taken out of it as sent and in the two encodings an echo
 * may carry, before the cut, so the cut cannot leave part of it. A key the upstream itself cut
 * short inside error.message is not found.
 */
function detailOf(err: APIError, apiKey: string): string | undefined {
  const message = messageOf(err);
  if (message === undefined) return undefined;
  const base64 = Buffer.from(apiKey).toString("base64");
  const forms = [
    apiKey,
    encodeURIComponent(apiKey),
    base64,
    base64.replace(/=+$/, ""),
    Buffer.from(apiKey).toString("base64url"),
  ];
  let out = message;
  if (apiKey !== "") for (const form of forms) out = out.replaceAll(form, "[金鑰已遮蔽]");
  return out.slice(0, DETAIL_LIMIT);
}

/** The provider's own words: error.message of the body, when it is a string. */
function messageOf(err: APIError): string | undefined {
  const inner = (err.error as { message?: unknown } | undefined)?.message;
  return typeof inner === "string" ? inner : undefined;
}

function retryAfter(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value == null || !/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  return Math.round(Number(value) * 1000);
}

// --- Model lists.

const PER_MILLION = 1_000_000;
const OPENROUTER_LEVELS: readonly Effort[] = ["low", "medium", "high"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const positiveInt = (v: unknown) =>
  Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined;
const perMillion = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * PER_MILLION * 1e6) / 1e6 : undefined;
};

/**
 * OpenRouter's list carries prices and limits. Whether a model can turn reasoning off is not in
 * it, so thinkingTypes is left for the owner; effortLevels is a guess from supported_parameters.
 */
export function listOpenRouter(raw: readonly unknown[], now: Date): ListedModel[] {
  return raw.filter(isObject).flatMap((m): ListedModel[] => {
    if (typeof m.id !== "string" || m.id === "") return [];
    const pricing = isObject(m.pricing) ? m.pricing : {};
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    const price =
      input === undefined || output === undefined
        ? undefined
        : {
            input,
            output,
            cacheRead: perMillion(pricing.input_cache_read) ?? input,
            cacheWrite: perMillion(pricing.input_cache_write) ?? input,
          };
    const top = isObject(m.top_provider) ? m.top_provider : {};
    const contextWindow = positiveInt(m.context_length);
    const maxOutput = positiveInt(top.max_completion_tokens);
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const expires =
      typeof m.expiration_date === "string" ? Date.parse(m.expiration_date) : Number.NaN;
    const lifecycle = Number.isNaN(expires)
      ? "active"
      : expires <= now.getTime()
        ? "retired"
        : "deprecated";
    return [
      {
        id: m.id,
        label: typeof m.name === "string" && m.name !== "" ? m.name : m.id,
        lifecycle,
        ...(lifecycle === "deprecated" ? { retiresAt: m.expiration_date as string } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutput === undefined ? {} : { maxOutput }),
        effortLevels: params.includes("reasoning") ? OPENROUTER_LEVELS : [],
        inferred: ["effortLevels"],
        ...(price === undefined ? {} : { price, priceSource: "openrouter" as const }),
      },
    ];
  });
}

/** Gemini's compatible list has only id, owned_by and display_name (P2 item 6). */
export function listGemini(raw: readonly unknown[]): ListedModel[] {
  return raw.filter(isObject).flatMap((m): ListedModel[] => {
    if (typeof m.id !== "string" || m.id === "") return [];
    const id = m.id.startsWith("models/") ? m.id.slice("models/".length) : m.id;
    const name = m.display_name;
    return [{ id, label: typeof name === "string" && name !== "" ? name : id }];
  });
}
