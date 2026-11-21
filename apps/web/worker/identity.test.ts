// @vitest-environment node
// jose fails in jsdom: its key types come from another realm.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { accessJwt, checkAccessJwt, checkLinkIdentity, type TlsClientAuth } from "./identity.ts";

const TEAM = "team.example.test";
const AUD = "aud-for-tests";
const EMAIL = "owner@example.test";
const CFG = { teamDomain: TEAM, aud: AUD, ownerEmail: EMAIL };

let keys: ReturnType<typeof createLocalJWKSet>;
let sign: (claims: JWTPayload, opts?: { alg?: string; key?: CryptoKey }) => Promise<string>;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
  // Defaults first, so a test's claim replaces one.
  sign = (claims, opts = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      email: EMAIL,
      iss: `https://${TEAM}`,
      aud: AUD,
      iat: now,
      exp: now + 3600,
      ...claims,
    })
      .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: "k1" })
      .sign(opts.key ?? pair.privateKey);
  };
});

const withHeader = (jwt: string) =>
  new Request("https://app.example.test/ws", { headers: { "Cf-Access-Jwt-Assertion": jwt } });

describe("checkAccessJwt", () => {
  test("a good JWT passes and is returned", async () => {
    const jwt = await sign({});
    expect(await checkAccessJwt(withHeader(jwt), CFG, keys)).toBe(jwt);
  });

  test("the email is compared without case", async () => {
    const jwt = await sign({ email: "Owner@Example.Test" });
    expect(await checkAccessJwt(withHeader(jwt), CFG, keys)).toBe(jwt);
  });

  test.each([
    ["a wrong signature", async () => sign({}, { key: otherKey })],
    ["a wrong aud", async () => sign({ aud: "other" })],
    ["a wrong iss", async () => sign({ iss: "https://other.example.test" })],
    ["an expired one", async () => sign({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ["nbf in the future", async () => sign({ nbf: Math.floor(Date.now() / 1000) + 3600 })],
    ["another email", async () => sign({ email: "someone@example.test" })],
    ["no email", async () => sign({ email: undefined })],
  ])("%s is refused", async (_, make) => {
    expect(await checkAccessJwt(withHeader(await make()), CFG, keys)).toBeUndefined();
  });

  test("alg none and HS256 are refused", async () => {
    const enc = (o: object) =>
      btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const now = Math.floor(Date.now() / 1000);
    const body = enc({ email: EMAIL, iss: `https://${TEAM}`, aud: AUD, exp: now + 3600 });
    const none = `${enc({ alg: "none", kid: "k1" })}.${body}.`;
    expect(await checkAccessJwt(withHeader(none), CFG, keys)).toBeUndefined();
    const secret = new TextEncoder().encode("a-shared-secret-of-enough-length!!");
    const hs = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setExpirationTime("1h")
      .sign(secret);
    expect(await checkAccessJwt(withHeader(hs), CFG, keys)).toBeUndefined();
  });

  test("without the header the CF_Authorization cookie is read", async () => {
    const jwt = await sign({});
    const request = new Request("https://app.example.test/ws", {
      headers: { Cookie: `theme=dark; CF_Authorization=${jwt}; other=1` },
    });
    expect(accessJwt(request)).toBe(jwt);
    expect(await checkAccessJwt(request, CFG, keys)).toBe(jwt);
  });

  test("with neither, nothing to check", async () => {
    expect(
      await checkAccessJwt(new Request("https://app.example.test/ws"), CFG, keys),
    ).toBeUndefined();
  });
});

describe("checkLinkIdentity", () => {
  const FP = "ab".repeat(32);
  const FP2 = "cd".repeat(32);
  const good: TlsClientAuth = {
    certPresented: "1",
    certVerified: "SUCCESS",
    certRevoked: "0",
    certFingerprintSHA256: FP,
  };

  test("a presented, verified, unrevoked certificate on the list passes", () => {
    expect(checkLinkIdentity(good, FP)).toBe(true);
  });

  test('no certificate, as Cloudflare sends it ("0", "NONE", "0"), is refused', () => {
    const none = {
      certPresented: "0",
      certVerified: "NONE",
      certRevoked: "0",
      certFingerprintSHA256: "",
    };
    expect(checkLinkIdentity(none, FP)).toBe(false);
    expect(checkLinkIdentity(undefined, FP)).toBe(false);
  });

  test.each([
    ["not verified", { certVerified: "FAILED:self signed certificate" }],
    ["revoked", { certRevoked: "1" }],
    ["certRevoked missing", { certRevoked: undefined }],
    ["a fingerprint not on the list", { certFingerprintSHA256: "ef".repeat(32) }],
  ])("%s is refused", (_, change) => {
    expect(checkLinkIdentity({ ...good, ...change } as TlsClientAuth, FP)).toBe(false);
  });

  test("with two fingerprints both pass; three, or none, is a broken secret and nothing passes", () => {
    expect(checkLinkIdentity(good, `${FP2}, ${FP}`)).toBe(true);
    expect(checkLinkIdentity({ ...good, certFingerprintSHA256: FP2 }, `${FP2},${FP}`)).toBe(true);
    expect(checkLinkIdentity(good, `${FP2},${FP},${"ef".repeat(32)}`)).toBe(false);
    expect(checkLinkIdentity(good, "")).toBe(false);
  });

  test("fingerprints are compared without case", () => {
    expect(checkLinkIdentity({ ...good, certFingerprintSHA256: FP.toUpperCase() }, FP)).toBe(true);
  });
});
