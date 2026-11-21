import { afterEach, describe, expect, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { PROTOCOL_VERSION } from "@tars/protocol";
import { resolvePaths, type Env } from "../../../src/core/paths.ts";
import { CONFIG_TEMPLATE } from "../../../src/features/agent/config.ts";
import { E2E_ACCESS_CERTS_URL_VAR, E2E_LINK_URL_VAR } from "../../../src/features/serve/command.ts";
import { readStatus } from "../../../src/features/serve/status-file.ts";
import { run } from "../../../src/main.ts";
import { startFakeRelay, type FakeRelay } from "../../fakes/relay.ts";
import { fakeSecrets, tempHome, testDeps, TEST_NOW, type TestDeps } from "../../helpers.ts";

const TEAM = "team.example.test";
const AUD = "aud-0001";
const OWNER = "owner@example.test";
const CONN = "11111111-1111-4111-8111-111111111111";

const LINK = `
[link]
url = "wss://link.example.test/link"
access_team_domain = "${TEAM}"
access_aud = "${AUD}"
owner_email = "${OWNER}"
`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

async function certsServer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/cdn-cgi/access/certs"
        ? Response.json({ keys: [jwk] })
        : new Response("no", { status: 404 }),
  });
  cleanups.push(() => server.stop(true));
  const sign = (email = OWNER) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setIssuedAt(Math.floor(TEST_NOW / 1000))
      .setExpirationTime(Math.floor(TEST_NOW / 1000) + 3600)
      .sign(privateKey);
  return { url: `http://127.0.0.1:${server.port}`, sign };
}

interface Setup {
  deps: TestDeps;
  env: Env;
  relay: FakeRelay;
  certs: Awaited<ReturnType<typeof certsServer>>;
}

async function setup(opts: { config?: string; keys?: boolean; env?: Env } = {}): Promise<Setup> {
  const home = tempHome();
  const relay = startFakeRelay();
  cleanups.push(() => relay.stop());
  const certs = await certsServer();
  const env: Env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "cfg"),
    TARS_DATA_DIR: join(home, "data"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    [E2E_LINK_URL_VAR]: relay.url,
    [E2E_ACCESS_CERTS_URL_VAR]: certs.url,
    ...opts.env,
  };
  const paths = resolvePaths(env);
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(paths.configFile, opts.config ?? `${CONFIG_TEMPLATE}${LINK}`);
  const secrets = fakeSecrets(
    opts.keys === false ? {} : { "link:cert": "CERT-" + "PEM", "link:key": "KEY-" + "PEM" },
  );
  const deps = testDeps({ env, secrets });
  return { deps, env, relay, certs };
}

/** Starts tars serve; the returned function stops it with SIGINT and gives its exit code. */
function serve(s: Setup) {
  const exit = run(["serve"], s.deps);
  let stopped = false;
  const stop = async () => {
    if (!stopped) (s.deps.signals as EventEmitter).emit("SIGINT");
    stopped = true;
    return exit;
  };
  cleanups.push(async () => void (await stop()));
  return { exit, stop };
}

describe("tars serve", () => {
  test("connects with tars's User-Agent, says so in serve.json, answers a checked browser, stops on SIGINT", async () => {
    const s = await setup();
    const { stop } = serve(s);
    await s.relay.waitConnections(1);
    expect(s.relay.upgrades[0]?.get("user-agent")).toBe("tars-serve/0.0.1");
    const paths = resolvePaths(s.env);
    await waitUntil(async () => (await readStatus(paths.serveStatus))?.link.state === "connected");
    expect(s.deps.io.stderr.join("\n")).toContain(`${E2E_LINK_URL_VAR} 生效`);
    expect(s.deps.io.stderr.join("\n")).toContain(`${E2E_ACCESS_CERTS_URL_VAR} 生效`);

    const status = testDeps({ env: s.env });
    expect(await run(["serve", "status", "--json"], status)).toBe(0);
    expect(JSON.parse(status.io.stdout.join(""))).toMatchObject({
      running: true,
      link: { state: "connected" },
      accessKeys: "ok",
    });

    s.relay.send({
      t: "open",
      conn: CONN,
      jwt: await s.certs.sign(),
      country: "TW",
      ua: "Firefox",
    });
    s.relay.send({
      t: "msg",
      conn: CONN,
      m: { v: PROTOCOL_VERSION, id: "h-1", kind: "hello", p: {} },
    });
    const hello = await s.relay.waitFor(
      (f) => f.t === "msg" && (f.m as { kind?: string }).kind === "hello",
    );
    expect(hello).toMatchObject({ to: CONN, m: { re: "h-1", p: { tars: "0.0.1" } } });

    s.relay.send({ t: "probe" });
    await s.relay.waitFor((f) => f.t === "probe.ok");

    expect(await stop()).toBe(0);
  });

  test("a browser whose login fails is dropped 4003 and gets nothing", async () => {
    const s = await setup();
    serve(s);
    await s.relay.waitConnections(1);
    await waitUntil(
      async () => (await readStatus(resolvePaths(s.env).serveStatus))?.link.state === "connected",
    );
    s.relay.send({ t: "open", conn: CONN, jwt: await s.certs.sign("someone@example.test") });
    const drop = await s.relay.waitFor((f) => f.t === "drop");
    expect(drop).toEqual({ t: "drop", conn: CONN, code: 4003 });
    expect(s.relay.frames.filter((f) => (f as { t: string }).t === "msg")).toEqual([]);
  });

  test("without the certificate in the keyring: no connection, serve.json says keyring", async () => {
    const s = await setup({ keys: false });
    serve(s);
    const paths = resolvePaths(s.env);
    await waitUntil(async () => (await readStatus(paths.serveStatus))?.link.state === "keyring");
    expect(s.relay.connected()).toBe(false);
    const status = testDeps({ env: s.env });
    expect(await run(["serve", "status"], status)).toBe(1);
    expect(status.io.stdout.join("\n")).toContain("keyring 讀不到");
  });

  test("a second tars serve is refused while the first holds the lock", async () => {
    const s = await setup();
    serve(s);
    await s.relay.waitConnections(1);
    const second = testDeps({ env: s.env, secrets: s.deps.secrets });
    expect(await run(["serve"], second)).toBe(1);
    expect(second.io.stderr.join("\n")).not.toBe("");
  });

  test.each([
    ["no [link]", CONFIG_TEMPLATE, "[link] 還缺"],
    [
      "a placeholder left",
      `${CONFIG_TEMPLATE}${LINK.replace(TEAM, "<TEAM>.cloudflareaccess.com")}`,
      "access_team_domain",
    ],
  ])("%s: exit 1 naming what is missing", async (_, config, words) => {
    const s = await setup({ config });
    expect(await run(["serve"], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain(words);
  });

  test("an e2e override that is not 127.0.0.1 is refused", async () => {
    const s = await setup({ env: { [E2E_LINK_URL_VAR]: "ws://example.com:80" } });
    expect(await run(["serve"], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain(E2E_LINK_URL_VAR);
  });

  test("refused inside a tars session", async () => {
    const s = await setup({ env: { TARS_IN_SESSION: "1" } });
    expect(await run(["serve"], s.deps)).toBe(1);
    expect(await run(["serve", "status"], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain("只能在你自己的終端執行");
  });

  test("serve status reads serve.json: replaced says so; a stale file means not running", async () => {
    const s = await setup();
    const paths = resolvePaths(s.env);
    mkdirSync(dirname(paths.serveStatus), { recursive: true });
    const base = {
      pid: 1,
      startedAt: TEST_NOW - 3600_000,
      version: "0.0.1",
      browsers: 0,
      pendingApprovals: 0,
      turnRunning: false,
      accessKeys: "ok",
      notify: "ok",
    };
    writeFileSync(
      paths.serveStatus,
      JSON.stringify({
        ...base,
        updatedAt: TEST_NOW - 1000,
        link: {
          state: "replaced",
          since: TEST_NOW - 600_000,
          replacedSince: TEST_NOW - 600_000,
          replacedNotified: true,
        },
      }),
    );
    expect(await run(["serve", "status"], s.deps)).toBe(1);
    expect(s.deps.io.stdout[0]).toBe(
      "本機端連線被另一台取代，已持續 10 分鐘；推播已送出。請到 Cloudflare 撤銷憑證",
    );
    writeFileSync(
      paths.serveStatus,
      JSON.stringify({
        ...base,
        updatedAt: TEST_NOW - 16_000,
        link: { state: "connected", since: 0 },
      }),
    );
    const stale = testDeps({ env: s.env });
    expect(await run(["serve", "status"], stale)).toBe(1);
    expect(stale.io.stderr.join("\n")).toContain("tars serve 沒有在執行");
  });

  test("serve status with nothing running: exit 1", async () => {
    const s = await setup();
    expect(await run(["serve", "status", "--json"], s.deps)).toBe(1);
    expect(JSON.parse(s.deps.io.stdout.join(""))).toEqual({ running: false });
  });
});

async function waitUntil(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
