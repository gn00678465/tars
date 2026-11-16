import { afterEach, describe, expect, test } from "bun:test";
import {
  isTokenFailure,
  parseGoogleCredential,
  refreshAccessToken,
  tokenFailureText,
  type GoogleCredential,
} from "../../../src/features/script/google.ts";
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  CREDENTIAL,
  fakeGoogle,
  granted,
  REFRESH_TOKEN,
  refused,
  SCOPE,
  type FakeGoogle,
} from "./fake-google.ts";

const credential = parseGoogleCredential(CREDENTIAL) as GoogleCredential;

describe("parseGoogleCredential", () => {
  test("reads the four fields", () => {
    expect(credential).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
      scope: SCOPE,
    } as GoogleCredential);
  });

  test.each([
    ["not json", "must be a JSON object"],
    ["[1]", "must be a JSON object"],
    ['"a string"', "must be a JSON object"],
    [JSON.stringify({ ...JSON.parse(CREDENTIAL), refresh_token: undefined }), '"refresh_token"'],
    [JSON.stringify({ ...JSON.parse(CREDENTIAL), client_secret: "" }), '"client_secret"'],
    [JSON.stringify({ ...JSON.parse(CREDENTIAL), client_id: 7 }), '"client_id"'],
    [JSON.stringify({ ...JSON.parse(CREDENTIAL), scope: "  " }), '"scope"'],
  ])("%p is refused by field name, without its values", (value, message) => {
    const result = parseGoogleCredential(value);
    expect(result).toBeInstanceOf(Error);
    const text = (result as Error).message;
    expect(text).toContain(message);
    for (const v of [CLIENT_SECRET, REFRESH_TOKEN, CLIENT_ID]) expect(text).not.toContain(v);
  });
});

describe("refreshAccessToken", () => {
  let google: FakeGoogle | undefined;
  afterEach(() => google?.stop());

  const refresh = async (reply?: Parameters<typeof fakeGoogle>[0], timeoutMs?: number) => {
    google = fakeGoogle(reply, timeoutMs);
    return refreshAccessToken(credential, google.endpoints);
  };

  test("POSTs the form Google documents, scope included, and returns the access token", async () => {
    const token = await refresh();
    expect(token).toEqual({ accessToken: ACCESS_TOKEN, expiresIn: 3599, scope: SCOPE });
    expect(google?.requests).toEqual([
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        form: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: REFRESH_TOKEN,
          scope: SCOPE,
        },
      },
    ]);
  });

  test("token_type is compared without case, and unknown fields are ignored", async () => {
    const token = await refresh(() => granted({ token_type: "bearer", id_token: "x" }));
    expect(isTokenFailure(token)).toBe(false);
  });

  test("a granted scope listed among others, in any order, is enough", async () => {
    const token = await refresh(() => granted({ scope: `openid  ${SCOPE}` }));
    expect(isTokenFailure(token)).toBe(false);
  });

  const failureText = async (reply: Parameters<typeof fakeGoogle>[0], timeoutMs?: number) => {
    const token = await refresh(reply, timeoutMs);
    if (!isTokenFailure(token)) throw new Error("the refresh was accepted");
    const text = tokenFailureText(token);
    for (const leak of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, "LEAK-CANARY"])
      expect(text).not.toContain(leak);
    return text;
  };

  test.each([
    [400, "invalid_grant", "HTTP 400 (invalid_grant)"],
    [401, "invalid_client", "HTTP 401 (invalid_client)"],
    [401, "deleted_client", "HTTP 401 (deleted_client)"],
    [400, `made-up ${REFRESH_TOKEN}`, "HTTP 400 (other)"],
  ])("HTTP %i %s is reported as %s", async (status, error, expected) => {
    expect(await failureText(() => refused(status, error))).toContain(expected);
  });

  test("a 5xx that is not JSON is reported by status alone", async () => {
    expect(
      await failureText(() => new Response("<html>LEAK-CANARY</html>", { status: 503 })),
    ).toContain("HTTP 503 (other)");
  });

  test("a redirect is not followed with the form", async () => {
    let followed = 0;
    const elsewhere = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => (followed++, granted()),
    });
    try {
      const text = await failureText(() =>
        Response.redirect(`http://127.0.0.1:${elsewhere.port}/token`, 307),
      );
      expect(text).toContain("HTTP 307");
      expect(followed).toBe(0);
    } finally {
      void elsewhere.stop(true);
    }
  });

  test.each([
    ["a 200 that is not JSON", () => new Response("LEAK-CANARY"), "not a JSON object"],
    ["a JSON array", () => Response.json([1]), "not a JSON object"],
    ["no access_token", () => granted({ access_token: undefined }), '"access_token"'],
    ["an empty access_token", () => granted({ access_token: "" }), '"access_token"'],
    ["a token_type that is not Bearer", () => granted({ token_type: "MAC" }), '"token_type"'],
    ["no token_type", () => granted({ token_type: undefined }), '"token_type"'],
    ["no expires_in", () => granted({ expires_in: undefined }), '"expires_in"'],
    ["expires_in of zero", () => granted({ expires_in: 0 }), '"expires_in"'],
    ["a fractional expires_in", () => granted({ expires_in: 1.5 }), '"expires_in"'],
    ["a string expires_in", () => granted({ expires_in: "3599" }), '"expires_in"'],
    ["no scope", () => granted({ scope: undefined }), '"scope"'],
    ["another scope", () => granted({ scope: "openid" }), '"scope"'],
    [
      "a scope that only contains the wanted one as a substring",
      () => granted({ scope: `${SCOPE}.extra x${SCOPE}` }),
      '"scope"',
    ],
  ])("%s is refused", async (_name, reply, expected) => {
    expect(await failureText(reply)).toContain(expected);
  });

  test("an endpoint that never answers is given up on after the timeout", async () => {
    const text = await failureText(() => new Promise<Response>(() => {}), 200);
    expect(text).toContain("did not answer within 0.2 s");
  });

  test("an endpoint that is not there is reported as unreachable", async () => {
    const token = await refreshAccessToken(credential, {
      auth: "http://127.0.0.1:9/auth",
      token: "http://127.0.0.1:9/token",
      timeoutMs: 5000,
    });
    expect(token).toEqual({ kind: "unreachable" });
  });
});
