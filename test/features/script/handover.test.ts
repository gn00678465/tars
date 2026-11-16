import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handOver } from "../../../src/features/script/execute.ts";
import { requireScriptMeta } from "../../../src/features/script/metadata.ts";
import { redact, REDACTED } from "../../../src/features/script/redact.ts";
import { fakeSecrets, tempHome } from "../../helpers.ts";
import {
  ACCESS_TOKEN,
  CLIENT_SECRET,
  CREDENTIAL,
  fakeGoogle,
  granted,
  REFRESH_TOKEN,
  refused,
  SCOPE,
  type FakeGoogle,
} from "./fake-google.ts";
import { sampleScript } from "./sample.ts";

const meta = (domains = '["www.googleapis.com"]', secret = "gcal") =>
  requireScriptMeta(
    sampleScript({
      tarsLines: [
        'name = "probe"',
        'summary = "s"',
        `secret = "${secret}"`,
        `domains = ${domains}`,
        'effects = "read-only"',
        'args = "a"',
        'outputs = "o"',
        'exit = { 0 = "ok" }',
      ],
    }),
  );

let google: FakeGoogle | undefined;
afterEach(() => {
  google?.stop();
  google = undefined;
});

function setup(
  stored: string | null = CREDENTIAL,
  reply?: Parameters<typeof fakeGoogle>[0],
  type = "google-oauth",
) {
  const scriptsDir = tempHome();
  mkdirSync(join(scriptsDir, "secrets"));
  writeFileSync(join(scriptsDir, "secrets", "gcal.json"), JSON.stringify({ type }));
  google = fakeGoogle(reply);
  const secrets = fakeSecrets(stored === null ? {} : { "script:gcal": stored });
  return { scriptsDir, secrets, google: google.endpoints };
}

const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, "LEAK-CANARY"];

async function refusal(run: Promise<unknown>): Promise<string> {
  const message = await run.then(
    () => undefined,
    (err: Error) => err.message,
  );
  if (message === undefined) throw new Error("the secret was handed over");
  for (const leak of SECRETS) expect(message).not.toContain(leak);
  return message;
}

describe("handing over a google-oauth secret", () => {
  test("the script's secret is the access token, traded for with the stored scope", async () => {
    const handover = await handOver(meta(), 120_000, setup());
    expect(handover?.value).toBe(ACCESS_TOKEN);
    expect(handover?.hosts).toEqual([]);
    expect(google?.requests.map((r) => r.form)).toEqual([
      {
        client_id: "fake-client.apps.example",
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        scope: SCOPE,
      },
    ]);
  });

  test("the access token, the refresh token and the client secret are masked in every encoding", async () => {
    const handover = await handOver(meta(), 120_000, setup());
    const mask = (text: string) => redact(text, handover?.needles ?? []);
    for (const value of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET])
      for (const form of [
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString("base64"),
        Buffer.from(value).toString("base64url"),
      ])
        expect(mask(`Authorization: Bearer ${form} end`)).toBe(
          `Authorization: Bearer ${REDACTED} end`,
        );
  });

  test("a client secret shorter than the JSON field limit is masked too", async () => {
    const short = JSON.stringify({ ...JSON.parse(CREDENTIAL), client_secret: "s3cr" });
    const handover = await handOver(meta(), 120_000, setup(short));
    expect(redact("id s3cr end", handover?.needles ?? [])).toBe(`id ${REDACTED} end`);
  });

  test("a revoked sign-in points the user to tars secret login", async () => {
    const message = await refusal(
      handOver(
        meta(),
        120_000,
        setup(CREDENTIAL, () => refused(400, "invalid_grant")),
      ),
    );
    expect(message).toContain("HTTP 400 (invalid_grant)");
    expect(message).toContain("tars secret login gcal");
  });

  test.each(["invalid_client", "deleted_client"])(
    "%s says the OAuth client is wrong or deleted",
    async (error) => {
      const message = await refusal(
        handOver(
          meta(),
          120_000,
          setup(CREDENTIAL, () => refused(401, error)),
        ),
      );
      expect(message).toContain(`HTTP 401 (${error})`);
      expect(message).toContain("OAuth client is wrong or was deleted");
    },
  );

  test.each([
    ["a 5xx", () => new Response("LEAK-CANARY", { status: 500 }), "HTTP 500 (other)"],
    ["a scope short of the stored one", () => granted({ scope: "openid" }), '"scope"'],
    ["a token that is not Bearer", () => granted({ token_type: "MAC" }), '"token_type"'],
  ])("%s refuses the run", async (_name, reply, expected) => {
    expect(await refusal(handOver(meta(), 120_000, setup(CREDENTIAL, reply)))).toContain(expected);
  });

  test("a time limit longer than the token lasts is refused", async () => {
    const ctx = setup(CREDENTIAL, () => granted({ expires_in: 60 }));
    const message = await refusal(handOver(meta(), 61_000, ctx));
    expect(message).toContain("lasts 60 s");
    expect(await handOver(meta(), 60_000, ctx)).toBeDefined();
  });

  test("a stored value that is not a credential is refused before any request", async () => {
    const message = await refusal(handOver(meta(), 120_000, setup(`{"key":"${CLIENT_SECRET}"}`)));
    expect(message).toContain('"client_id"');
    expect(message).toContain("tars secret login gcal");
    expect(google?.requests).toEqual([]);
  });

  test("a missing one points to tars secret login", async () => {
    const message = await refusal(handOver(meta(), 120_000, setup(null)));
    expect(message).toContain("tars secret login gcal");
    expect(message).not.toContain("tars secret set");
  });

  test('a script that declares "secret:url" is refused before any request', async () => {
    const message = await refusal(handOver(meta('["secret:url"]'), 120_000, setup()));
    expect(message).toContain("google-oauth");
    expect(google?.requests).toEqual([]);
  });
});

describe("handing over a static secret", () => {
  test("the value goes over whole and no token is requested", async () => {
    const ctx = setup("plain-static-value", undefined, "static");
    const handover = await handOver(meta(), 120_000, ctx);
    expect(handover?.value).toBe("plain-static-value");
    expect(google?.requests).toEqual([]);
  });

  test("a missing one points to tars secret set", async () => {
    const message = await refusal(handOver(meta(), 120_000, setup(null, undefined, "static")));
    expect(message).toContain("tars secret set gcal");
  });

  test('"secret:url" opens the host in the value', async () => {
    const ctx = setup('{"url":"https://push.example:8443/x","key":"k"}', undefined, "static");
    expect((await handOver(meta('["secret:url"]'), 120_000, ctx))?.hosts).toEqual([
      "push.example:8443",
    ]);
  });
});
