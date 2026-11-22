import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { PROTOCOL_VERSION } from "@tars/protocol";
import { E2E_BASE_URL_VAR } from "../../src/features/agent/provider.ts";
import { E2E_ACCESS_CERTS_URL_VAR, E2E_LINK_URL_VAR } from "../../src/features/serve/command.ts";
import { capabilities, startFakeAnthropic, tarsCall, text } from "../fakes/anthropic.ts";
import { startFakeRelay } from "../fakes/relay.ts";
import { runDialog } from "./pty.ts";
import {
  EXIT_SKIP,
  finishChecks,
  printChecks,
  spawnStep,
  type Check,
  type Running,
} from "./sandbox.ts";
import { enterScriptNetns, install, scriptHost } from "./script-host.ts";

const INNER = "TARS_E2E_SERVE_INNER";
const MODEL = "model-e2e";
const KEY = "sk-e2e-fake-key";
const TEAM = "team.example.test";
const AUD = "aud-e2e";
const OWNER = "owner@example.test";

const LINK = `
[link]
url = "wss://link.example.test/link"
access_team_domain = "${TEAM}"
access_aud = "${AUD}"
owner_email = "${OWNER}"
`;

const pusher = `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "pusher"
# summary = "e2e pusher"
# domains = ["example.com"]
# effects = "external-write"
# args = "<anything>"
# outputs = "one line"
# exit = { 0 = "ok" }
# ///
print("PUSHED")
`;

/** Browser connection ids, as the DO makes them. */
const conn = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

type Frame = Record<string, unknown>;
type Msg = { kind: string; id: string; re?: string; conv?: string; p: Record<string, unknown> };

async function inner(): Promise<number> {
  const openssl = Bun.which("openssl");
  if (openssl === null) {
    console.error("e2e:serve SKIP, missing: openssl");
    return EXIT_SKIP;
  }
  const { host, python, step } = scriptHost("tars-e2e-serve-");
  const fake = startFakeAnthropic();
  fake.models = [
    {
      id: MODEL,
      display_name: "Model E2E",
      max_input_tokens: 200000,
      max_tokens: 32000,
      capabilities: capabilities(["low", "medium", "high"]),
    },
  ];
  const relay = startFakeRelay();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "e2e-1", alg: "RS256" };
  const certs = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/cdn-cgi/access/certs"
        ? Response.json({ keys: [jwk] })
        : new Response("no", { status: 404 }),
  });
  const env = {
    [E2E_BASE_URL_VAR]: fake.url,
    [E2E_LINK_URL_VAR]: relay.url,
    [E2E_ACCESS_CERTS_URL_VAR]: `http://127.0.0.1:${certs.port}`,
  };
  /** An Access JWT as the team would sign it; `exp` in seconds from now. */
  const jwt = (opts: { email?: string; exp?: number } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: opts.email ?? OWNER })
      .setProtectedHeader({ alg: "RS256", kid: "e2e-1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.exp ?? 3600))
      .sign(privateKey);
  };

  const run = (name: string, command: string) => step(name, command, env);
  const checks: Check[] = [];
  const check = (id: string, claim: string, pass: boolean, evidence: string) =>
    checks.push({ id, claim, pass, evidence });
  const brief = (r: { exitCode: number | null; stdout: string; stderr: string }) =>
    `exit ${r.exitCode}; stdout ${JSON.stringify(r.stdout.slice(0, 200))}; stderr ${JSON.stringify(r.stderr.slice(-400))}`;
  const data = join(host.fakeHome, ".local/share/tars");
  const query = <T>(sql: string, ...params: string[]) => {
    const db = new Database(join(data, "agent/agent.db"), { readonly: true });
    try {
      return db.query(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  };

  // What the local end sent to one browser connection, from `from` on.
  const msgsTo = (c: string, from = 0) =>
    relay.frames
      .slice(from)
      .filter((f): f is Frame => (f as Frame).t === "msg" && (f as Frame).to === c)
      .map((f) => f.m as Msg);
  const waitMsg = (c: string, pred: (m: Msg) => boolean, ms = 15_000, from = 0) =>
    relay
      .waitFor(
        (f) => f.t === "msg" && f.to === c && pred(f.m as Msg) && relay.frames.indexOf(f) >= from,
        ms,
      )
      .then((f) => f.m as Msg);
  const waitDrop = (c: string, ms = 15_000) =>
    relay.waitFor((f) => f.t === "drop" && f.conn === c, ms);
  let ids = 0;
  const send = (c: string, kind: string, p: unknown = {}, extra: Record<string, unknown> = {}) => {
    const id = `e2e-${++ids}`;
    relay.send({ t: "msg", conn: c, m: { v: PROTOCOL_VERSION, id, kind, p, ...extra } });
    return id;
  };
  const reply = (c: string, re: string, ms?: number) => waitMsg(c, (m) => m.re === re, ms);
  const open = async (c: string, token: Promise<string> = jwt()) =>
    relay.send({ t: "open", conn: c, jwt: await token, country: "TW", ua: "e2e" });
  /** open + hello; resolves with the hello reply. */
  const ready = async (c: string) => {
    await open(c);
    return reply(c, send(c, "hello"));
  };
  const turnEnd = (c: string, requestId: string, ms = 30_000) =>
    waitMsg(
      c,
      (m) => m.kind === "turn" && m.p.requestId === requestId && m.p.state !== "started",
      ms,
    );

  let serving: Running | undefined;
  const startServe = (name: string) => {
    serving = spawnStep(host, {
      name,
      argv: ["sh", "-c", "exec tars serve"],
      cwd: host.home,
      env,
      timeoutMs: 600_000,
    });
    return serving;
  };

  try {
    // --- Setup: install, a model, the key, an approvable script, [link] and the certificate.
    const fixtures = join(host.work, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, "SOUL.md"), "# Soul\n");
    writeFileSync(join(fixtures, "MEMORY.md"), "# Memory\n");
    const setup = await run(
      "setup",
      [
        `tars install --soul ${fixtures}/SOUL.md --memory ${fixtures}/MEMORY.md --no-modify-path`,
        "tars config init",
      ].join(" && "),
    );
    if (setup.exitCode !== 0) throw new Error(`setup failed: ${brief(setup)}`);
    const key = await runDialog(host, {
      name: "llm-key-set",
      command: "tars llm key set anthropic",
      tty: true,
      env,
      turns: [{ expect: "API 金鑰：", send: `${KEY}\n` }],
    });
    if (key.exitCode !== 0) throw new Error(`llm key set failed: ${brief(key)}`);
    const models = await run(
      "models",
      `tars models refresh && tars models set anthropic/${MODEL} --input 3 --output 15 --cache-read 0.3 --cache-write 3.75 && tars models enable anthropic/${MODEL} && tars models default anthropic/${MODEL}`,
    );
    if (models.exitCode !== 0) throw new Error(`models failed: ${brief(models)}`);
    const script = install(host, "pusher", pusher);
    const venv = await run("venv", `python3 -m venv --without-pip ${script}/venv-${python}`);
    if (venv.exitCode !== 0) throw new Error(`venv failed: ${brief(venv)}`);
    appendFileSync(join(host.fakeHome, ".config/tars/config.toml"), LINK);
    // A throwaway self-signed pair: the link is ws:// here, so it never leaves the keyring.
    const made = Bun.spawnSync(
      [
        openssl,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(host.work, "client.key"),
        "-out",
        join(host.work, "client.pem"),
        "-days",
        "30",
        "-subj",
        "/CN=tars-e2e",
      ],
      { stderr: "pipe" },
    );
    if (made.exitCode !== 0) throw new Error(`openssl failed: ${made.stderr.toString()}`);
    const linkSetup = await runDialog(host, {
      name: "link-setup",
      command: `tars link setup --cert ${host.work}/client.pem --key ${host.work}/client.key`,
      tty: true,
      env,
      turns: [{ expect: "確定？輸入 yes 或 no：", send: "yes\n" }],
    });
    check(
      "link-setup",
      "tars link setup checks the pair, asks on the tty and stores it",
      linkSetup.exitCode === 0 && linkSetup.stdout.includes("請刪除原始的私鑰檔"),
      brief(linkSetup),
    );

    // --- tars serve connects to the fake relay with tars's User-Agent.
    startServe("serve-1");
    await relay.waitConnections(1, 20_000);
    check(
      "connect",
      "tars serve connects to the relay with User-Agent tars-serve/<version>",
      /^tars-serve\/\S+$/.test(relay.upgrades[0]?.get("user-agent") ?? ""),
      `user-agent ${relay.upgrades[0]?.get("user-agent")}`,
    );

    // --- 1. open + hello: hello and status.
    const A = conn(1);
    const B = conn(2);
    const hello = await ready(A);
    const status = await waitMsg(A, (m) => m.kind === "status");
    check(
      "hello",
      "open with a valid JWT, then hello: hello and status",
      hello.kind === "hello" && typeof hello.p.epoch === "string" && status.p.turnRunning === false,
      JSON.stringify(hello),
    );
    await ready(B);

    // --- The knowledge base, read only: a page file is shown, a symlink in its place is not.
    mkdirSync(join(data, "wiki/people"), { recursive: true });
    writeFileSync(
      join(data, "wiki/people/wang.md"),
      "---\ntitle: 王小明\ntype: people\ncreated: 2026-11-01\nupdated: 2026-11-02\n---\n## 事實\n- [i1] 搬到台中。\n",
    );
    symlinkSync(join(data, "MEMORY.md"), join(data, "wiki/people/linked.md"));
    const wikiStatus = await reply(A, send(A, "wiki.status"));
    const wikiPage = await reply(A, send(A, "wiki.page", { path: "people/wang" }));
    const wikiLinked = await reply(A, send(A, "wiki.page", { path: "people/linked" }));
    check(
      "wiki",
      "wiki.status before any sync, wiki.page reads a page file and refuses a symlink",
      wikiStatus.kind === "wiki.status.result" &&
        wikiStatus.p.synced === false &&
        wikiPage.p.state === "ok" &&
        wikiPage.p.title === "王小明" &&
        wikiLinked.p.state === "missing",
      `${JSON.stringify(wikiStatus.p)}; ${JSON.stringify(wikiPage.p).slice(0, 200)}; ${JSON.stringify(wikiLinked.p)}`,
    );

    // --- 2. A message: ack, started, the user item, delta, the reply, completed.
    fake.reply(text("你好，這裡是 tars"));
    const from2 = relay.frames.length;
    const s2 = send(A, "turn.submit", { requestId: "req-1", text: "你好" });
    await turnEnd(A, "req-1");
    const kinds = msgsTo(A, from2).map((m) =>
      m.kind === "turn"
        ? `turn:${m.p.state}`
        : m.kind === "item"
          ? `item:${(m.p.item as { kind: string }).kind}`
          : m.kind,
    );
    const order = ["ack", "turn:started", "item:user", "delta", "item:assistant", "turn:completed"];
    let at = 0;
    for (const k of kinds) if (k === order[at]) at++;
    check(
      "turn",
      "turn.submit: ack, turn started, the user item, delta, the reply, turn completed",
      at === order.length && msgsTo(A, from2)[0]?.re === s2,
      kinds.join(" "),
    );
    const conv =
      query<{ conv_id: string }>("SELECT conv_id FROM turns WHERE request_id = 'req-1'")[0]
        ?.conv_id ?? "";

    // --- 3 to 5. An approval: both see it; a wrong hash; a late device; first decision wins.
    fake.reply(tarsCall("p1", ["script", "run", "pusher", "--", "x"]), text("推好了"));
    send(A, "turn.submit", { requestId: "req-2", text: "推播" }, { conv });
    const reqA = await waitMsg(A, (m) => m.kind === "approval.request", 30_000);
    const reqB = await waitMsg(B, (m) => m.kind === "approval.request");
    const approval = reqA.p.approval as { approvalId: string; hash: string };
    check(
      "approval-both",
      "both connections get the approval.request",
      (reqB.p.approval as { approvalId: string }).approvalId === approval.approvalId,
      approval.approvalId,
    );

    const bad = await reply(
      A,
      send(A, "approval.decide", {
        approvalId: approval.approvalId,
        decision: "approved",
        hash: "0".repeat(64),
      }),
    );
    const stillPending = query<{ state: string }>(
      "SELECT state FROM approvals WHERE id = ?",
      approval.approvalId,
    )[0]?.state;
    check(
      "hash-mismatch",
      "a decision with the wrong hash gets hash_mismatch; the approval still waits (S3 acceptance 4)",
      bad.kind === "nack" && bad.p.reason === "hash_mismatch" && stillPending === "pending",
      `${JSON.stringify(bad.p)}; state ${stillPending}`,
    );

    const C = conn(3);
    await ready(C);
    const reqC = await waitMsg(C, (m) => m.kind === "approval.request");
    check(
      "late-device",
      "a connection that says hello while it waits gets the same approval.request",
      (reqC.p.approval as { approvalId: string }).approvalId === approval.approvalId,
      JSON.stringify(reqC.p).slice(0, 120),
    );

    const ok = await reply(
      A,
      send(A, "approval.decide", {
        approvalId: approval.approvalId,
        decision: "approved",
        hash: approval.hash,
      }),
    );
    const resolvedB = await waitMsg(B, (m) => m.kind === "approval.resolved");
    const late = await reply(
      B,
      send(B, "approval.decide", {
        approvalId: approval.approvalId,
        decision: "denied",
        hash: approval.hash,
      }),
    );
    await turnEnd(A, "req-2");
    const decided = query<{ state: string; decided_via: string }>(
      "SELECT state, decided_via FROM approvals WHERE id = ?",
      approval.approvalId,
    )[0];
    check(
      "two-devices",
      "A approves; B hears approval.resolved and its own decision gets already_decided (S3 acceptance 3)",
      ok.kind === "ack" &&
        resolvedB.p.state === "approved" &&
        late.kind === "nack" &&
        late.p.reason === "already_decided" &&
        decided?.state === "approved" &&
        decided.decided_via === "remote",
      `${ok.kind}; ${JSON.stringify(resolvedB.p)}; ${JSON.stringify(late.p)}; ${JSON.stringify(decided)}`,
    );

    // --- 7. Logins that fail: dropped 4003, and nothing more reaches them.
    const E = conn(4);
    const F = conn(5);
    await open(E, jwt({ email: "someone@example.test" }));
    await open(F, jwt({ exp: -120 }));
    const dropE = await waitDrop(E);
    const dropF = await waitDrop(F);
    const quietE = msgsTo(E).length;
    const quietF = msgsTo(F).length;
    // The relay closes a dropped browser; one that sends anyway gets one refusal and another drop.
    const refused = async (c: string) => {
      const from = relay.frames.length;
      const nack = await reply(c, send(c, "hello"));
      const drop = await relay.waitFor(
        (f) => f.t === "drop" && f.conn === c && relay.frames.indexOf(f) >= from,
      );
      return { nack, drop, to: msgsTo(c, from) };
    };
    const refusedE = await refused(E);
    const refusedF = await refused(F);

    // --- 8. A login that ends while connected: dropped at exp, and the next deltas skip it.
    const D = conn(6);
    await open(D, jwt({ exp: 3 }));
    await reply(D, send(D, "hello"));
    await reply(D, send(D, "conv.open", {}, { conv }));
    const dropD = await waitDrop(D, 20_000);
    const afterD = relay.frames.indexOf(dropD);
    fake.reply(text("第三則回覆"));
    send(A, "turn.submit", { requestId: "req-3", text: "再一則" }, { conv });
    // --- 10. The same requestId again while it runs: one turn.
    const again = send(A, "turn.submit", { requestId: "req-3", text: "再一則" }, { conv });
    const againReply = await reply(A, again);
    await turnEnd(A, "req-3");
    check(
      "bad-logins",
      "an email that does not match and an expired JWT: drop 4003, and no message to either (S3 acceptance 4)",
      dropE.code === 4003 && dropF.code === 4003 && quietE === 0 && quietF === 0,
      `E ${JSON.stringify(dropE)}, F ${JSON.stringify(dropF)}; to E ${quietE}, to F ${quietF}`,
    );
    check(
      "refused-message",
      "a message from a refused connection: one not_allowed, then drop 4003",
      [refusedE, refusedF].every(
        (r) =>
          r.to.length === 1 &&
          r.nack.kind === "nack" &&
          (r.nack.p as { reason?: string }).reason === "not_allowed" &&
          (r.drop as { code?: number }).code === 4003,
      ),
      JSON.stringify(
        [refusedE, refusedF].map((r) => ({ to: r.to.length, nack: r.nack.p, drop: r.drop })),
      ),
    );
    check(
      "login-expires",
      "a login that expires while connected: drop 4003 at exp, then no deltas for it",
      dropD.code === 4003 &&
        msgsTo(D, afterD).length === 0 &&
        msgsTo(A, afterD).some((m) => m.kind === "delta"),
      `drop ${JSON.stringify(dropD)}; to D after ${msgsTo(D, afterD).length}`,
    );
    const turns3 = query<{ n: number }>(
      "SELECT count(*) AS n FROM turns WHERE request_id = 'req-3'",
    )[0]?.n;
    check(
      "dedupe",
      "the same requestId sent twice: acked, and agent.db has one turn",
      againReply.kind === "ack" && turns3 === 1,
      `${againReply.kind}; turns ${turns3}`,
    );

    // --- Archive: put away from a page, not opened or continued, taken back at once.
    const archived = await reply(A, send(A, "conv.archive", { archived: true }, { conv }));
    const archivedAt = query<{ at: number | null }>(
      `SELECT archived_at AS at FROM conversations WHERE id = '${conv}'`,
    )[0]?.at;
    const listAfter = await reply(A, send(A, "conv.list", {}));
    const openArchived = await reply(A, send(A, "conv.open", {}, { conv }));
    const submitArchived = await reply(
      A,
      send(A, "turn.submit", { requestId: "req-arch", text: "還能說嗎" }, { conv }),
    );
    const restored = await reply(A, send(A, "conv.archive", { archived: false }, { conv }));
    const openRestored = await reply(A, send(A, "conv.open", {}, { conv }));
    check(
      "archive",
      "conv.archive: acked and archived_at set; the list lacks it; conv.open and turn.submit get conv_archived; taking it back reopens it",
      archived.kind === "ack" &&
        typeof archivedAt === "number" &&
        !((listAfter.p.convs ?? []) as { id: string }[]).some((c) => c.id === conv) &&
        openArchived.p.reason === "conv_archived" &&
        submitArchived.p.reason === "conv_archived" &&
        restored.kind === "ack" &&
        openRestored.kind === "conv.snapshot",
      `${archived.kind}; at ${archivedAt}; ${openArchived.p.reason}; ${submitArchived.p.reason}; ${restored.kind}; ${openRestored.kind}`,
    );

    // --- 9. Another protocol version.
    const v2 = `e2e-${++ids}`;
    relay.send({ t: "msg", conn: A, m: { v: PROTOCOL_VERSION + 1, id: v2, kind: "hello", p: {} } });
    const version = await reply(A, v2);
    check(
      "version",
      "hello with another v gets nack version (S3 acceptance 4)",
      version.kind === "nack" && version.p.reason === "version",
      JSON.stringify(version.p),
    );

    // --- 6. Killed and started again: it reconnects; a new open gets the snapshot.
    serving?.child.kill("SIGKILL");
    await serving?.result;
    startServe("serve-2");
    await relay.waitConnections(2, 20_000);
    const A2 = conn(7);
    await ready(A2);
    const snap = await reply(A2, send(A2, "conv.open", {}, { conv }));
    const items = (snap.p.items ?? []) as { kind: string }[];
    check(
      "restart",
      "tars serve killed and started again reconnects; conv.open gets the snapshot (S3 acceptance 2, the local half)",
      snap.kind === "conv.snapshot" &&
        items.some((i) => i.kind === "user") &&
        items.some((i) => i.kind === "assistant"),
      `${snap.kind}; ${items.map((i) => i.kind).join(",")}`,
    );

    // --- 11. Replaced: still running, and serve status says so.
    relay.close(4002, "replaced");
    let replaced: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const st = await run(`serve-status-${i}`, "tars serve status --json");
      try {
        replaced = JSON.parse(st.stdout) as Record<string, unknown>;
      } catch {
        replaced = {};
      }
      if ((replaced.link as { state?: string } | undefined)?.state === "replaced") break;
      await Bun.sleep(200);
    }
    const stillRunning = serving?.child.exitCode === null;
    check(
      "replaced",
      "closed with 4002: tars serve keeps running and serve status shows replaced",
      stillRunning && (replaced.link as { state?: string } | undefined)?.state === "replaced",
      JSON.stringify(replaced).slice(0, 300),
    );
  } catch (err) {
    check("run", "the suite ran to the end", false, String(err));
  } finally {
    serving?.child.kill("SIGKILL");
    const last = await serving?.result;
    if (last !== undefined && checks.some((c) => !c.pass))
      console.log(`tars serve stderr:\n${last.stderr.slice(-2000)}`);
    await relay.stop();
    await certs.stop(true);
    await fake.stop();
  }
  printChecks(checks);
  return finishChecks(checks, host.work);
}

if (import.meta.main)
  process.exitCode = process.env[INNER]
    ? await inner()
    : enterScriptNetns(import.meta.path, INNER, "e2e:serve");
