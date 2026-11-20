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
  }
}

export const ANTHROPIC_API = "https://api.anthropic.com";
export const E2E_BASE_URL_VAR = "TARS_E2E_ANTHROPIC_BASE_URL";

const LOOPBACK = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

/**
 * Only a loopback http address may replace the real endpoint, and only for the e2e fake. Two
 * independent checks: the regex alone would let "http://127.0.0.1:80@host" through a sloppy URL
 * parser, the parser alone would accept paths and credentials.
 */
export function resolveAnthropicBaseUrl(env: Env): string {
  const value = env[E2E_BASE_URL_VAR] ?? "";
  if (value === "") return ANTHROPIC_API;
  const refuse = () =>
    new TarsError(`${E2E_BASE_URL_VAR} must be http://127.0.0.1:<port>, nothing else`);
  const port = LOOPBACK.exec(value)?.[1];
  if (port === undefined || Number(port) > 65535) throw refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse();
  }
  const clean =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!clean) throw refuse();
  return value;
}

export type AdapterFor = (
  provider: Provider,
  apiKey: string,
  env: Env,
  warn: (line: string) => void,
) => Promise<ProviderAdapter>;

/** The SDK is imported on demand: loaded at the top it adds ~30 ms to every other command (P5). */
export const adapterFor: AdapterFor = async (provider, apiKey, env, warn) => {
  if (provider !== "anthropic")
    throw new TarsError(`${provider} is not supported yet; only anthropic is`);
  const baseURL = resolveAnthropicBaseUrl(env);
  return (await import("./anthropic.ts")).createAnthropicAdapter({ apiKey, baseURL, warn });
};
