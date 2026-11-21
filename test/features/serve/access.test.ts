import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { AccessVerifier, Registry } from "../../../src/features/serve/access.ts";
import { manualTimers } from "./fixture.ts";

const TEAM = "team.example.test";
const AUD = "aud-0001";
const OWNER = "owner@example.test";
const NOW = 1_800_000_000_000;

async function keyPair(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { jwk, privateKey, kid };
}
type Pair = Awaited<ReturnType<typeof keyPair>>;

const sign = (pair: Pair, claims: Record<string, unknown> = {}, at = NOW) =>
  new SignJWT({
    email: OWNER,
    iss: `https://${TEAM}`,
    aud: AUD,
    iat: Math.floor(at / 1000),
    exp: Math.floor(at / 1000) + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: pair.kid })
    .sign(pair.privateKey);

function verifier(keys: () => JWK[] | Error, clock = { t: NOW }) {
  const fetches: string[] = [];
  const v = new AccessVerifier(
    {
      teamDomain: TEAM,
      aud: AUD,
      ownerEmail: OWNER,
      certsUrl: `https://${TEAM}/cdn-cgi/access/certs`,
    },
    async (url) => {
      fetches.push(url);
      const k = keys();
      if (k instanceof Error) throw k;
      return { keys: k };
    },
    () => clock.t,
  );
  return { v, fetches, clock };
}

describe("AccessVerifier", () => {
  test("the owner's JWT passes, its exp in ms", async () => {
    const a = await keyPair("k1");
    const { v } = verifier(() => [a.jwk]);
    expect(await v.verify(await sign(a))).toEqual({
      ok: true,
      exp: (Math.floor(NOW / 1000) + 3600) * 1000,
    });
  });

  test("the email compares without case", async () => {
    const a = await keyPair("k1");
    const { v } = verifier(() => [a.jwk]);
    expect((await v.verify(await sign(a, { email: "Owner@Example.TEST" }))).ok).toBe(true);
  });

  test.each([
    ["another email", { email: "someone@example.test" }],
    ["no email", { email: undefined }],
    ["another aud", { aud: "aud-other" }],
    ["another issuer", { iss: "https://other.example.test" }],
    ["expired past the tolerance", { exp: Math.floor(NOW / 1000) - 61 }],
    ["not valid yet", { nbf: Math.floor(NOW / 1000) + 120 }],
  ])("%s: denied", async (_, claims) => {
    const a = await keyPair("k1");
    const { v } = verifier(() => [a.jwk]);
    expect(await v.verify(await sign(a, claims))).toEqual({ ok: false, reason: "denied" });
  });

  test("expired within the 60 s tolerance still passes", async () => {
    const a = await keyPair("k1");
    const { v } = verifier(() => [a.jwk]);
    expect((await v.verify(await sign(a, { exp: Math.floor(NOW / 1000) - 30 }))).ok).toBe(true);
  });

  test("an HS256 token, or garbage, is denied", async () => {
    const a = await keyPair("k1");
    const { v } = verifier(() => [a.jwk]);
    const hs = await new SignJWT({
      email: OWNER,
      iss: `https://${TEAM}`,
      aud: AUD,
      exp: Math.floor(NOW / 1000) + 60,
    })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .sign(new TextEncoder().encode("x".repeat(32)));
    expect(await v.verify(hs)).toEqual({ ok: false, reason: "denied" });
    expect(await v.verify("not.a.jwt")).toEqual({ ok: false, reason: "denied" });
  });

  test("keys that cannot be fetched: keys_unavailable, not denied", async () => {
    const a = await keyPair("k1");
    const { v } = verifier(() => new Error("offline"));
    expect(await v.verify(await sign(a))).toEqual({ ok: false, reason: "keys_unavailable" });
    expect(v.available).toBe(false);
  });

  test("a new kid refetches once; at most one fetch a minute", async () => {
    const a = await keyPair("k1");
    const b = await keyPair("k2");
    let served = [a.jwk];
    const { v, fetches, clock } = verifier(() => served);
    expect((await v.verify(await sign(a))).ok).toBe(true);
    expect(fetches).toHaveLength(1);
    served = [a.jwk, b.jwk];
    // Within the minute: no refetch, so the rotated key is not known yet.
    expect(await v.verify(await sign(b))).toEqual({ ok: false, reason: "denied" });
    expect(fetches).toHaveLength(1);
    clock.t += 61_000;
    expect((await v.verify(await sign(b, {}, clock.t))).ok).toBe(true);
    expect(fetches).toHaveLength(2);
  });

  test("keys from a failed refetch stay in use for a day, not longer", async () => {
    const a = await keyPair("k1");
    let fail = false;
    const { v, clock } = verifier(() => (fail ? new Error("offline") : [a.jwk]));
    expect(await v.refresh()).toBe(true);
    fail = true;
    clock.t += 23 * 3600_000;
    expect((await v.verify(await sign(a, {}, clock.t))).ok).toBe(true);
    clock.t += 2 * 3600_000;
    expect(await v.verify(await sign(a, {}, clock.t))).toEqual({
      ok: false,
      reason: "keys_unavailable",
    });
  });
});

describe("Registry", () => {
  test("a connection is dropped at its exp and is gone from every list", () => {
    const timers = manualTimers(NOW);
    const expired: string[] = [];
    const r = new Registry(timers, timers.now, (c) => void expired.push(c));
    r.add({ conn: "a", exp: NOW + 1000 });
    r.get("a")!.hello = true;
    expect(r.valid("a")).toBe(true);
    expect(r.ready().map((x) => x.conn)).toEqual(["a"]);
    timers.advance(1000);
    expect(expired).toEqual(["a"]);
    expect(r.get("a")).toBeUndefined();
    expect(r.ready()).toEqual([]);
    expect(r.size).toBe(0);
  });

  test("an exp beyond setTimeout's limit waits in pieces", () => {
    const timers = manualTimers(NOW);
    const expired: string[] = [];
    const r = new Registry(timers, timers.now, (c) => void expired.push(c));
    const far = NOW + 2 ** 31 + 5000;
    r.add({ conn: "a", exp: far });
    timers.advance(2 ** 31 - 1);
    expect(expired).toEqual([]);
    expect(r.valid("a")).toBe(true);
    timers.advance(6000);
    expect(expired).toEqual(["a"]);
  });

  test("hello is false until said; adding again replaces and re-arms", () => {
    const timers = manualTimers(NOW);
    const expired: string[] = [];
    const r = new Registry(timers, timers.now, (c) => void expired.push(c));
    r.add({ conn: "a", exp: NOW + 1000 });
    expect(r.get("a")!.hello).toBe(false);
    expect(r.ready()).toEqual([]);
    r.add({ conn: "a", exp: NOW + 5000 });
    timers.advance(1000);
    expect(expired).toEqual([]);
    expect(timers.pending()).toBe(1);
  });

  test("clear removes everything and its timers; remove is quiet", () => {
    const timers = manualTimers(NOW);
    const expired: string[] = [];
    const r = new Registry(timers, timers.now, (c) => void expired.push(c));
    r.add({ conn: "a", exp: NOW + 1000 });
    r.add({ conn: "b", exp: NOW + 1000 });
    r.clear();
    expect(r.size).toBe(0);
    expect(timers.pending()).toBe(0);
    timers.advance(2000);
    expect(expired).toEqual([]);
  });
});
