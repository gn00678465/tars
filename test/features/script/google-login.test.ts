import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  googleLogin,
  pkceChallenge,
  readCallback,
} from "../../../src/features/script/google-login.ts";
import { registerSecretCommands } from "../../../src/features/script/secret.ts";
import { run } from "../../../src/main.ts";
import { captureIo, fakeSecrets, scriptedTerminal, tempHome, testDeps } from "../../helpers.ts";
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  fakeGoogle,
  granted,
  REFRESH_TOKEN,
  refused,
  SCOPE,
  type FakeGoogle,
} from "./fake-google.ts";

const CODE = "FAKE-AUTH-CODE-0123456789";
const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, CODE, "LEAK-CANARY"];

test("pkceChallenge matches RFC 7636 appendix B", () => {
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

describe("readCallback", () => {
  const read = (query: string) => readCallback(new URL(`http://127.0.0.1:1${query}`), "S");

  test.each(["/?code=c", "/?code=c&state=other", "/favicon.ico?code=c&state=S", "/x?state=S"])(
    "%s is not this login's answer",
    (query) => {
      expect(read(query)).toBeUndefined();
    },
  );

  test("a code with the state, with or without Google's iss, is the answer", () => {
    expect(read("/?state=S&code=c")).toEqual({ kind: "code", code: "c" });
    expect(read("/?state=S&code=c&iss=https%3A%2F%2Faccounts.google.com")).toEqual({
      kind: "code",
      code: "c",
    });
  });

  test("an error ends the login, with only a known code repeated", () => {
    expect(read("/?state=S&error=access_denied")).toEqual({
      kind: "denied",
      error: "access_denied",
    });
    expect(read("/?state=S&error=LEAK&code=c")).toEqual({ kind: "denied", error: "other" });
  });

  test("another issuer, or neither code nor error, ends the login", () => {
    expect(read("/?state=S&code=c&iss=https%3A%2F%2Fevil.example")).toEqual({ kind: "issuer" });
    expect(read("/?state=S")).toEqual({ kind: "empty" });
  });
});

let google: FakeGoogle | undefined;
afterEach(() => {
  google?.stop();
  google = undefined;
});

const exchanged = () => granted({ refresh_token: REFRESH_TOKEN });

/** Plays the browser: reads the address login shows and comes back to the redirect with `answer`. */
function browser(answer: (auth: URL) => Record<string, string> | undefined) {
  const shown: URL[] = [];
  const visits: Promise<number>[] = [];
  return {
    shown,
    visits,
    show: (text: string) => {
      const auth = new URL(/https?:\/\/\S+/.exec(text)?.[0] ?? "");
      shown.push(auth);
      const query = answer(auth);
      if (query === undefined) return;
      const back = new URL(auth.searchParams.get("redirect_uri") ?? "");
      back.search = new URLSearchParams(query).toString();
      visits.push(fetch(back).then((res) => res.status));
    },
  };
}

const allow = (auth: URL) => ({ state: auth.searchParams.get("state") ?? "", code: CODE });

describe("googleLogin", () => {
  const login = (b: ReturnType<typeof browser>, waitMs = 5000) =>
    googleLogin({ id: CLIENT_ID, secret: CLIENT_SECRET }, SCOPE, {
      endpoints: (google ??= fakeGoogle(exchanged)).endpoints,
      show: b.show,
      waitMs,
    });

  const failure = async (attempt: Promise<unknown>) => {
    const message = await attempt.then(
      () => undefined,
      (err: Error) => err.message,
    );
    if (message === undefined) throw new Error("the login succeeded");
    for (const leak of SECRETS) expect(message).not.toContain(leak);
    return message;
  };

  test("asks with PKCE S256 and a state, then trades the code with the verifier", async () => {
    const b = browser(allow);
    const credential = await login(b);
    const auth = b.shown[0] as URL;
    const asked = Object.fromEntries(auth.searchParams);
    expect(auth.origin + auth.pathname).toBe(google?.endpoints.auth ?? "");
    expect(asked).toMatchObject({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: SCOPE,
      code_challenge_method: "S256",
    });
    expect(asked.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(asked.state?.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(asked)).not.toContain(CLIENT_SECRET);
    const form = google?.requests[0]?.form ?? {};
    expect(form).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: CODE,
      code_verifier: form.code_verifier ?? "",
      grant_type: "authorization_code",
      redirect_uri: asked.redirect_uri ?? "",
    });
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallenge(form.code_verifier ?? "")).toBe(asked.code_challenge ?? "");
    expect(credential).toMatchObject({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
      scope: SCOPE,
    });
    expect(await Promise.all(b.visits)).toEqual([200]);
  });

  test("stores the scope Google reports, not the one asked for", async () => {
    google = fakeGoogle(() => granted({ refresh_token: REFRESH_TOKEN, scope: `${SCOPE} openid` }));
    expect((await login(browser(allow))).scope).toBe(`${SCOPE} openid`);
  });

  test("requests without this login's state get 404 and the wait goes on", async () => {
    const strays: Promise<number>[] = [];
    const b = browser((auth) => {
      const redirect = auth.searchParams.get("redirect_uri") ?? "";
      for (const stray of ["/?code=x&state=wrong", "/?code=x", "/favicon.ico"])
        strays.push(fetch(redirect + stray).then((res) => res.status));
      return undefined;
    });
    const pending = login(b);
    expect(await Promise.all(strays)).toEqual([404, 404, 404]);
    const redirect = new URL(b.shown[0]?.searchParams.get("redirect_uri") ?? "");
    redirect.search = new URLSearchParams(allow(b.shown[0] as URL)).toString();
    expect((await fetch(redirect)).status).toBe(200);
    expect((await pending).refreshToken).toBe(REFRESH_TOKEN);
    expect(google?.requests.length).toBe(1);
  });

  test("the listener is gone once the answer is in", async () => {
    const b = browser(allow);
    await login(b);
    const redirect = b.shown[0]?.searchParams.get("redirect_uri") ?? "";
    expect(
      await fetch(redirect).then(
        () => "open",
        () => "closed",
      ),
    ).toBe("closed");
  });

  test("a denied consent fails without asking for a token", async () => {
    const b = browser((auth) => ({
      state: auth.searchParams.get("state") ?? "",
      error: "access_denied",
    }));
    expect(await failure(login(b))).toContain("did not grant access (access_denied)");
    expect(google?.requests).toEqual([]);
  });

  test("an answer from another issuer fails without asking for a token", async () => {
    const b = browser((auth) => ({ ...allow(auth), iss: "https://evil.example" }));
    expect(await failure(login(b))).toContain("issuer other than Google");
    expect(google?.requests).toEqual([]);
  });

  test("no answer within the wait fails", async () => {
    expect(
      await failure(
        login(
          browser(() => undefined),
          100,
        ),
      ),
    ).toContain("no sign-in answer");
  });

  test.each([
    ["no refresh_token", () => granted(), 'token answer has no "refresh_token"'],
    [
      "a scope without the one asked for",
      () => granted({ refresh_token: REFRESH_TOKEN, scope: "openid" }),
      '"scope"',
    ],
    ["a refused code", () => refused(400, "invalid_grant"), "HTTP 400 (invalid_grant)"],
  ])("a token answer with %s fails", async (_name, reply, expected) => {
    google = fakeGoogle(reply);
    expect(await failure(login(browser(allow)))).toContain(expected);
  });
});

describe("tars secret login", () => {
  function setup(reply: Parameters<typeof fakeGoogle>[0], answer: Parameters<typeof browser>[0]) {
    google = fakeGoogle(reply);
    const endpoints = google.endpoints;
    const scriptsDir = join(tempHome(), "scripts");
    const secrets = fakeSecrets({ "script:gcal": "the-value-before" });
    const io = captureIo();
    const b = browser(answer);
    const terminal = scriptedTerminal([`  ${CLIENT_ID} `, `${CLIENT_SECRET}\t`]);
    const program = new Command("tars").exitOverride();
    registerSecretCommands(program, {
      io,
      secrets,
      scriptsDir: () => scriptsDir,
      readSecret: () => Promise.reject(new Error("login must not read stdin")),
      google: () => endpoints,
      inSession: () => false,
      terminal: () => ({ ...terminal, write: (text) => (terminal.write(text), b.show(text)) }),
    });
    const login = (...args: string[]) =>
      program.parseAsync(["secret", "login", "gcal", ...args], { from: "user" });
    return { login, secrets, io, terminal, typeFile: join(scriptsDir, "secrets", "gcal.json") };
  }

  test("stores the four fields as a google-oauth secret and prints none of them", async () => {
    const { login, secrets, io, terminal, typeFile } = setup(exchanged, allow);
    await login();
    expect(JSON.parse(secrets.entries.get("script:gcal") ?? "")).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      scope: SCOPE,
    });
    expect(JSON.parse(readFileSync(typeFile, "utf8"))).toEqual({ type: "google-oauth" });
    expect(io.stdout).toEqual(["saved script:gcal (google-oauth)"]);
    const shown = [...io.stdout, ...io.stderr, ...terminal.transcript].join("\n");
    for (const leak of SECRETS) expect(shown).not.toContain(leak);
    expect(terminal.transcript.slice(0, 2)).toEqual(["OAuth client ID: ", "OAuth client secret: "]);
  });

  test("--scope is what the consent asks for", async () => {
    const other = "https://www.googleapis.com/auth/calendar.events.readonly";
    const { login, secrets } = setup(
      () => granted({ refresh_token: REFRESH_TOKEN, scope: other }),
      allow,
    );
    await login("--scope", other);
    expect(google?.requests.length).toBe(1);
    expect(JSON.parse(secrets.entries.get("script:gcal") ?? "").scope).toBe(other);
  });

  test.each([
    [
      "a denied consent",
      exchanged,
      (auth: URL) => ({ state: auth.searchParams.get("state") ?? "", error: "access_denied" }),
    ],
    ["no refresh_token", () => granted(), allow],
    [
      "a scope without the one asked for",
      () => granted({ refresh_token: REFRESH_TOKEN, scope: "openid" }),
      allow,
    ],
  ] as const)("%s leaves the keyring and the type file as they were", async (_n, reply, answer) => {
    const { login, secrets, io, typeFile } = setup(reply, answer);
    await expect(login()).rejects.toThrow("nothing saved");
    expect([...secrets.entries]).toEqual([["script:gcal", "the-value-before"]]);
    expect(existsSync(typeFile)).toBe(false);
    expect(io.stdout).toEqual([]);
  });

  test("refuses inside a tars session before it opens the terminal", async () => {
    const home = tempHome();
    const deps = testDeps({ env: { HOME: home, TARS_IN_SESSION: "1" } });
    expect(await run(["secret", "login", "gcal"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("outside the tars session");
  });

  test("without a terminal it fails rather than read stdin", async () => {
    const deps = testDeps({
      env: { HOME: tempHome() },
      openTerminal: () => {
        throw new Error("no terminal in this test");
      },
    });
    await expect(run(["secret", "login", "gcal"], deps)).rejects.toThrow("no terminal");
  });
});
