// @vitest-environment node
import wranglerConfig from "../wrangler.jsonc?raw";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";

// The DO's base class exists only in workerd; the handler under test never constructs one.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const keys = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("./identity.ts", async (original) => {
  const real = await original<typeof import("./identity.ts")>();
  // The test's own keys in place of Access's endpoint.
  return {
    ...real,
    checkAccessJwt: (r: Request, cfg: Parameters<typeof real.checkAccessJwt>[1]) =>
      real.checkAccessJwt(r, cfg, keys.current as Parameters<typeof real.checkAccessJwt>[2]),
  };
});

const { handle } = await import("./index.ts");

const APP = "app.example.test";
const LINK = "link.example.test";
const TEAM = "team.example.test";
const FP = "ab".repeat(32);

interface Seen {
  role: string | null;
  conn: string | null;
  jwt: string | null;
  headers: Headers;
}

function env() {
  const seen: Seen[] = [];
  const e = {
    APP_HOST: APP,
    LINK_HOST: LINK,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: "aud",
    OWNER_EMAIL: "owner@example.test",
    LINK_CERT_FINGERPRINTS: FP,
    ASSETS: { fetch: async () => new Response("asset") },
    RELAY: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (r: Request) => {
          seen.push({
            role: r.headers.get("X-Relay-Role"),
            conn: r.headers.get("X-Relay-Conn"),
            jwt: r.headers.get("X-Relay-Jwt"),
            headers: r.headers,
          });
          return new Response("relayed");
        },
      }),
    },
  };
  return { env: e as unknown as Env, seen };
}

let jwt: string;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  keys.current = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
  jwt = await new SignJWT({ email: "owner@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience("aud")
    .setExpirationTime("1h")
    .sign(pair.privateKey);
});

const ws = (host: string, path: string, headers: Record<string, string> = {}, cf?: object) => {
  const r = new Request(`https://${host}${path}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
  if (cf !== undefined) Object.defineProperty(r, "cf", { value: cf });
  return r;
};

const browser = (extra: Record<string, string> = {}) =>
  ws(APP, "/ws", { Origin: `https://${APP}`, "Cf-Access-Jwt-Assertion": jwt, ...extra });

const CERT = {
  tlsClientAuth: {
    certPresented: "1",
    certVerified: "SUCCESS",
    certRevoked: "0",
    certFingerprintSHA256: FP,
  },
};

describe("the Worker's paths", () => {
  test("/ws on APP_HOST with the Origin and the JWT goes to the DO as a browser", async () => {
    const { env: e, seen } = env();
    const res = await handle(browser({ "X-Relay-Role": "local", "User-Agent": "Mozilla/5.0" }), e);
    expect(await res.text()).toBe("relayed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.role).toBe("browser");
    expect(seen[0]?.conn).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]?.jwt).toBe(jwt);
    // Nothing the client sent reaches the DO but what the checks vouch for.
    expect(seen[0]?.headers.get("Cf-Access-Jwt-Assertion")).toBeNull();
    expect(seen[0]?.headers.get("X-Relay-Ua")).toBe("Mozilla/5.0");
  });

  test("/link on LINK_HOST with a good certificate goes to the DO as the local end", async () => {
    const { env: e, seen } = env();
    const res = await handle(ws(LINK, "/link", { "X-Relay-Role": "browser" }, CERT), e);
    expect(await res.text()).toBe("relayed");
    expect(seen.map((s) => s.role)).toEqual(["local"]);
  });

  test("a wrong Origin, no JWT, no upgrade or no certificate: 403 with the same words", async () => {
    const { env: e, seen } = env();
    const refused = [
      browser({ Origin: "https://evil.example.test" }),
      ws(APP, "/ws", { Origin: `https://${APP}` }),
      new Request(`https://${APP}/ws`, {
        headers: { Origin: `https://${APP}`, "Cf-Access-Jwt-Assertion": jwt },
      }),
      ws(LINK, "/link"),
      ws(
        LINK,
        "/link",
        {},
        { tlsClientAuth: { ...CERT.tlsClientAuth, certFingerprintSHA256: "ef".repeat(32) } },
      ),
    ];
    for (const r of refused) {
      const res = await handle(r, e);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("forbidden");
    }
    expect(seen).toEqual([]);
  });

  test("a host that does not match its path is 404: /ws on LINK_HOST, /link on APP_HOST", async () => {
    const { env: e, seen } = env();
    expect(
      (
        await handle(
          ws(LINK, "/ws", { Origin: `https://${APP}`, "Cf-Access-Jwt-Assertion": jwt }),
          e,
        )
      ).status,
    ).toBe(404);
    expect((await handle(ws(APP, "/link", {}, CERT), e)).status).toBe(404);
    expect(seen).toEqual([]);
  });

  test("anything else is a static file", async () => {
    const { env: e } = env();
    expect(await (await handle(new Request(`https://${APP}/c/abc`), e)).text()).toBe("asset");
  });

  test("a missing file under /assets/ is 404, not the page that _headers would cache a year", async () => {
    const { env: e } = env();
    const r = await handle(new Request(`https://${APP}/assets/A2uiCard-old12345.js`), e);
    expect(r.status).toBe(404);
    expect(await (await handle(new Request(`https://${APP}/assetsx`), e)).text()).toBe("asset");
  });
});

test("wrangler.jsonc's vars are exactly the four the design lists", () => {
  const json = JSON.parse(
    wranglerConfig.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
  ) as {
    vars: Record<string, string>;
  };
  expect(Object.keys(json.vars).toSorted()).toEqual([
    "ACCESS_AUD",
    "ACCESS_TEAM_DOMAIN",
    "APP_HOST",
    "LINK_HOST",
  ]);
  // Placeholders only: the repo is public.
  for (const value of Object.values(json.vars)) expect(value).toMatch(/<[A-Z_]+>/);
});
