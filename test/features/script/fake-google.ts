import type { GoogleEndpoints } from "../../../src/features/script/google.ts";

export const SCOPE = "https://www.googleapis.com/auth/calendar.events.owned.readonly";
export const CLIENT_ID = "fake-client.apps.example";
export const CLIENT_SECRET = "FAKE-CLIENT-SECRET-0123456789";
export const REFRESH_TOKEN = "FAKE-REFRESH-TOKEN/with+chars=0123456789";
export const ACCESS_TOKEN = "FAKE-ACCESS-TOKEN/with+chars=0123456789";

export const CREDENTIAL = JSON.stringify({
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  refresh_token: REFRESH_TOKEN,
  scope: SCOPE,
});

export interface TokenRequest {
  readonly method: string;
  readonly contentType: string;
  readonly form: Readonly<Record<string, string>>;
}

export interface FakeGoogle {
  readonly endpoints: GoogleEndpoints;
  /** Every request to the token endpoint, in order. */
  readonly requests: TokenRequest[];
  stop(): void;
}

/** A refresh answer shaped like Google's: no refresh_token, the granted scope repeated. */
export const granted = (extra: Record<string, unknown> = {}) =>
  Response.json({
    access_token: ACCESS_TOKEN,
    expires_in: 3599,
    scope: SCOPE,
    token_type: "Bearer",
    ...extra,
  });

/** Google's error answer: JSON with `error` and a description tars must never repeat. */
export const refused = (status: number, error: string) =>
  Response.json({ error, error_description: `LEAK-CANARY description for ${error}` }, { status });

/** Google's token endpoint on 127.0.0.1. `reply` answers every POST to /token. */
export function fakeGoogle(
  reply: (request: TokenRequest) => Response | Promise<Response> = () => granted(),
  timeoutMs = 5000,
): FakeGoogle {
  const requests: TokenRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/token") return new Response("", { status: 404 });
      const request = {
        method: req.method,
        contentType: req.headers.get("content-type") ?? "",
        form: Object.fromEntries(new URLSearchParams(await req.text())),
      };
      requests.push(request);
      return reply(request);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    endpoints: { auth: `${base}/auth`, token: `${base}/token`, timeoutMs },
    requests,
    stop: () => void server.stop(true),
  };
}
