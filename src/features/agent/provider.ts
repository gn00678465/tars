import { TarsError } from "../../core/exit.ts";
import type { Env } from "../../core/paths.ts";
import type { Provider } from "../../core/secrets.ts";
import type { ListedModel, ModelRequest, ProviderEvent } from "./types.ts";

export interface ProviderAdapter {
  readonly provider: Provider;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  listModels(signal: AbortSignal): Promise<readonly ListedModel[]>;
}

export type ProviderErrorKind =
  | "spend_limit"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "connection"
  | "auth"
  | "bad_request"
  | "aborted";

export interface ProviderErrorInit {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly receivedStart: boolean;
  readonly receivedContent: boolean;
  readonly detail?: string;
  /** See ProviderError.mayHaveRun. */
  readonly mayHaveRun?: boolean;
  /** See ProviderError.callBytes. */
  readonly callBytes?: number;
}

/**
 * The message carries only the kind and the status: it may reach the log. `detail`, the
 * provider's own complaint about a bad request, goes only to the frontend and the error item.
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly receivedStart: boolean;
  readonly receivedContent: boolean;
  readonly detail?: string;
  /**
   * No start, yet the upstream may have run the request: set by the compatible adapter, whose
   * start waits for the first chunk, when the headers came and the body broke off, or on abort.
   * A reasoning model may think for minutes before that chunk.
   */
  readonly mayHaveRun?: boolean;
  /** The compatible adapter's end-event callBytes so far: a broken stream's output too. */
  readonly callBytes?: number;

  constructor(
    readonly kind: ProviderErrorKind,
    init: ProviderErrorInit,
  ) {
    super(init.status === undefined ? kind : `${kind} (HTTP ${init.status})`);
    this.name = "ProviderError";
    this.receivedStart = init.receivedStart;
    this.receivedContent = init.receivedContent;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.detail !== undefined) this.detail = init.detail;
    if (init.mayHaveRun === true) this.mayHaveRun = true;
    if (init.callBytes !== undefined && init.callBytes > 0) this.callBytes = init.callBytes;
  }
}

export const ANTHROPIC_API = "https://api.anthropic.com";
/** Kept here rather than in openai-compat.ts so naming them does not load the SDK. */
export const COMPAT_ENDPOINTS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openrouter: "https://openrouter.ai/api/v1",
} as const;
export const E2E_BASE_URL_VAR = "TARS_E2E_ANTHROPIC_BASE_URL";

/** The variables that point a provider at an e2e fake; each can send a key elsewhere. */
export const E2E_BASE_URL_VARS: Readonly<Record<Provider, string>> = {
  anthropic: E2E_BASE_URL_VAR,
  gemini: "TARS_E2E_GEMINI_BASE_URL",
  openrouter: "TARS_E2E_OPENROUTER_BASE_URL",
};

/**
 * undefined or "": undefined. Anything else must be <scheme>://127.0.0.1:<port>, or this throws.
 * Two independent checks: the regex alone would let "http://127.0.0.1:80@host" through a sloppy
 * URL parser, the parser alone would accept paths and credentials.
 */
export function loopbackUrl(
  varName: string,
  value: string | undefined,
  scheme: "http" | "ws",
): string | undefined {
  if (value === undefined || value === "") return undefined;
  const refuse = () =>
    new TarsError(`${varName} must be ${scheme}://127.0.0.1:<port>, nothing else`);
  const port = new RegExp(`^${scheme}://127\\.0\\.0\\.1:([1-9]\\d{0,4})$`).exec(value)?.[1];
  if (port === undefined || Number(port) > 65535) throw refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse();
  }
  const clean =
    url.protocol === `${scheme}:` &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!clean) throw refuse();
  return value;
}

/**
 * The real endpoint, or the e2e fake its variable names. The fake is announced on stderr for
 * every provider alike: the variable sends the key wherever it points.
 */
export function baseUrlFor(provider: Provider, env: Env, warn: (line: string) => void): string {
  const name = E2E_BASE_URL_VARS[provider];
  const fake = loopbackUrl(name, env[name], "http");
  if (fake === undefined)
    return provider === "anthropic" ? ANTHROPIC_API : COMPAT_ENDPOINTS[provider];
  warn(`${name} 把 ${provider} 導到 ${fake}`);
  return fake;
}

export function resolveAnthropicBaseUrl(env: Env): string {
  return loopbackUrl(E2E_BASE_URL_VAR, env[E2E_BASE_URL_VAR], "http") ?? ANTHROPIC_API;
}

export type AdapterFor = (
  provider: Provider,
  apiKey: string,
  env: Env,
  warn: (line: string) => void,
) => Promise<ProviderAdapter>;

/** The SDK is imported on demand: loaded at the top it adds ~30 ms to every other command (P5). */
export const adapterFor: AdapterFor = async (provider, apiKey, env, warn) => {
  if (provider !== "anthropic") {
    const compat = await import("./openai-compat.ts");
    return compat.createCompatAdapter({
      provider,
      apiKey,
      baseURL: baseUrlFor(provider, env, warn),
      warn,
    });
  }
  const baseURL = baseUrlFor(provider, env, warn);
  return (await import("./anthropic.ts")).createAnthropicAdapter({ apiKey, baseURL, warn });
};
