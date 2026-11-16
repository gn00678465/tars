import { TarsError } from "../../core/exit.ts";
import {
  credentialJson,
  GOOGLE_ISSUER,
  isTokenFailure,
  oauthError,
  parseGoogleCredential,
  requestToken,
  tokenFailureText,
  type GoogleCredential,
  type GoogleEndpoints,
  type OAuthError,
} from "./google.ts";

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** RFC 7636 S256. */
export function pkceChallenge(verifier: string): string {
  return base64url(new Bun.CryptoHasher("sha256").update(verifier).digest());
}

export type Callback =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "denied"; readonly error: OAuthError }
  | { readonly kind: "issuer" }
  | { readonly kind: "empty" };

/**
 * What a request to the loopback listener means. undefined for anything that does not carry this
 * login's state: a favicon request, a port scan, or another local process guessing.
 */
export function readCallback(url: URL, state: string): Callback | undefined {
  if (url.pathname !== "/" || url.searchParams.get("state") !== state) return undefined;
  const q = url.searchParams;
  const error = q.get("error");
  if (error !== null) return { kind: "denied", error: oauthError(error) };
  const iss = q.get("iss");
  if (iss !== null && iss !== GOOGLE_ISSUER) return { kind: "issuer" };
  const code = q.get("code");
  return code === null || code === "" ? { kind: "empty" } : { kind: "code", code };
}

function callbackText(
  callback: Exclude<Callback, { kind: "code" }> | { kind: "silence" },
  waitMs: number,
): string {
  switch (callback.kind) {
    case "silence":
      return `no sign-in answer within ${Math.round(waitMs / 1000)} s`;
    case "denied":
      return `Google did not grant access (${callback.error})`;
    case "issuer":
      return "the sign-in answer names an issuer other than Google";
    case "empty":
      return "the sign-in answer has neither a code nor an error";
  }
}

export interface LoginClient {
  readonly id: string;
  readonly secret: string;
}

export interface LoginDeps {
  readonly endpoints: GoogleEndpoints;
  /** Shows the user the address to open. */
  show(text: string): void;
  /** How long to wait for the browser to come back. */
  readonly waitMs: number;
}

/**
 * The installed-app flow: a listener on a loopback port of its own, PKCE S256, and one answer.
 * Nothing it receives is printed; a failure names a status or a known OAuth error code.
 */
export async function googleLogin(
  client: LoginClient,
  scope: string,
  deps: LoginDeps,
): Promise<GoogleCredential> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const answered = Promise.withResolvers<Callback>();
  let settled = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const callback = settled ? undefined : readCallback(new URL(req.url), state);
      if (callback === undefined) return new Response("", { status: 404 });
      settled = true;
      answered.resolve(callback);
      return new Response(
        callback.kind === "code"
          ? "tars has the sign-in answer. You can close this tab.\n"
          : "The sign-in did not complete. See the terminal.\n",
      );
    },
  });
  const redirect = `http://127.0.0.1:${server.port}`;
  let callback: Callback | { readonly kind: "silence" };
  let timer: Timer | undefined;
  try {
    const url = new URL(deps.endpoints.auth);
    url.search = new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirect,
      response_type: "code",
      scope,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state,
    }).toString();
    deps.show(`Open this address in your browser and allow access:\n\n${url.href}\n\n`);
    callback = await Promise.race([
      answered.promise,
      new Promise<{ kind: "silence" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "silence" }), deps.waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Not stop(true): the browser is still reading the page that tells the user what happened.
    void server.stop();
  }
  if (callback.kind !== "code")
    throw new TarsError(`${callbackText(callback, deps.waitMs)}; nothing saved`);
  const token = await requestToken(
    deps.endpoints,
    {
      client_id: client.id,
      client_secret: client.secret,
      code: callback.code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    },
    scope,
  );
  if (isTokenFailure(token)) throw new TarsError(`${tokenFailureText(token)}; nothing saved`);
  if (token.refreshToken === undefined)
    throw new TarsError('Google\'s token answer has no "refresh_token"; nothing saved');
  // The scope Google reports can be spelled differently from the one asked for; later refreshes
  // must ask for what was actually granted.
  const credential = parseGoogleCredential(
    credentialJson({
      clientId: client.id,
      clientSecret: client.secret,
      refreshToken: token.refreshToken,
      scope: token.scope,
    }),
  );
  if (credential instanceof Error) throw new TarsError(`${credential.message}; nothing saved`);
  return credential;
}
