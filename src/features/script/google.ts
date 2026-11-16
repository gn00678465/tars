import { isRecord } from "./metadata.ts";

/** Where tars talks to Google. Production values live in runtime.ts; only tests pass others. */
export interface GoogleEndpoints {
  readonly auth: string;
  readonly token: string;
  readonly timeoutMs: number;
}

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const DEFAULT_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned.readonly";

declare const credentialBrand: unique symbol;

/** The value of a google-oauth secret. Only parseGoogleCredential makes one. */
export interface GoogleCredential {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** Space-delimited, as the token endpoint reported it at login. */
  readonly scope: string;
  readonly [credentialBrand]: true;
}

const FIELDS = ["client_id", "client_secret", "refresh_token", "scope"] as const;

/** The Error names fields and never holds a value. */
export function parseGoogleCredential(value: string): GoogleCredential | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed))
    return new Error(
      `the secret must be a JSON object with the string fields ${FIELDS.map((f) => `"${f}"`).join(", ")}`,
    );
  for (const field of FIELDS) {
    const v = parsed[field];
    if (typeof v !== "string" || v.trim() === "")
      return new Error(`the secret's "${field}" must be a non-empty string`);
  }
  const [clientId, clientSecret, refreshToken, scope] = FIELDS.map((f) => parsed[f] as string);
  return { clientId, clientSecret, refreshToken, scope } as GoogleCredential;
}

export function credentialJson(
  c: Pick<GoogleCredential, "clientId" | "clientSecret" | "refreshToken" | "scope">,
): string {
  return JSON.stringify({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    scope: c.scope,
  });
}

const OAUTH_ERRORS = [
  "access_denied",
  "admin_policy_enforced",
  "deleted_client",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "org_internal",
  "unauthorized_client",
  "unsupported_grant_type",
] as const;
export type OAuthError = (typeof OAUTH_ERRORS)[number] | "other";

/** Anything outside the list becomes "other", so text Google or an impostor sent is never repeated. */
export function oauthError(value: unknown): OAuthError {
  return OAUTH_ERRORS.find((code) => code === value) ?? "other";
}

/** Why a token request gave no token. No variant carries anything the endpoint sent but its status. */
export type TokenFailure =
  | { readonly kind: "unreachable" }
  | { readonly kind: "timeout"; readonly ms: number }
  | { readonly kind: "refused"; readonly status: number; readonly error: OAuthError }
  /** A 2xx answer tars cannot use; `detail` names the field. */
  | { readonly kind: "unusable"; readonly detail: string };

export function tokenFailureText(failure: TokenFailure): string {
  switch (failure.kind) {
    case "unreachable":
      return "could not reach Google's token endpoint";
    case "timeout":
      return `Google's token endpoint did not answer within ${failure.ms / 1000} s`;
    case "refused":
      return `Google's token endpoint answered HTTP ${failure.status} (${failure.error})`;
    case "unusable":
      return `Google's token answer ${failure.detail}`;
  }
}

export interface Token {
  readonly accessToken: string;
  /** Seconds. */
  readonly expiresIn: number;
  readonly scope: string;
  /** Only the authorization-code exchange returns one. */
  readonly refreshToken?: string;
}

export const isTokenFailure = (value: Token | TokenFailure): value is TokenFailure =>
  "kind" in value;

const scopes = (text: string) => new Set(text.split(/\s+/).filter((s) => s !== ""));

/**
 * One form POST to the token endpoint. The answer must be a Bearer token whose scope holds every
 * scope in `wanted`: Google may grant less than was asked, and a script must never get more.
 */
export async function requestToken(
  endpoints: GoogleEndpoints,
  form: Readonly<Record<string, string>>,
  wanted: string,
): Promise<Token | TokenFailure> {
  let status: number;
  let text: string;
  try {
    const res = await fetch(endpoints.token, {
      method: "POST",
      body: new URLSearchParams(form),
      // A redirect would send the form, with the refresh token in it, to wherever it points.
      redirect: "manual",
      signal: AbortSignal.timeout(endpoints.timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    return (err as Error).name === "TimeoutError"
      ? { kind: "timeout", ms: endpoints.timeoutMs }
      : { kind: "unreachable" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (status < 200 || status > 299)
    return { kind: "refused", status, error: oauthError(isRecord(body) ? body.error : undefined) };
  if (!isRecord(body)) return { kind: "unusable", detail: "is not a JSON object" };
  const unusable = (detail: string): TokenFailure => ({ kind: "unusable", detail });
  const { access_token, token_type, expires_in, scope, refresh_token } = body;
  if (typeof token_type !== "string" || token_type.toLowerCase() !== "bearer")
    return unusable('has a "token_type" other than Bearer');
  if (typeof access_token !== "string" || access_token === "")
    return unusable('has no "access_token"');
  if (typeof expires_in !== "number" || !Number.isInteger(expires_in) || expires_in <= 0)
    return unusable('has no positive whole "expires_in"');
  if (typeof scope !== "string") return unusable('has no "scope"');
  const granted = scopes(scope);
  if ([...scopes(wanted)].some((s) => !granted.has(s)))
    return unusable('has a "scope" that does not cover what was asked for');
  if (refresh_token !== undefined && (typeof refresh_token !== "string" || refresh_token === ""))
    return unusable('has an empty "refresh_token"');
  return {
    accessToken: access_token,
    expiresIn: expires_in,
    scope,
    ...(refresh_token === undefined ? {} : { refreshToken: refresh_token }),
  };
}

/** Trades the refresh token for a short-lived access token limited to the credential's scope. */
export function refreshAccessToken(
  credential: GoogleCredential,
  endpoints: GoogleEndpoints,
): Promise<Token | TokenFailure> {
  return requestToken(
    endpoints,
    {
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      scope: credential.scope,
    },
    credential.scope,
  );
}
