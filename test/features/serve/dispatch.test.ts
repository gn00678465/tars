import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseServer,
  PROTOCOL_VERSION,
  SKILL_TEXT,
  SNAPSHOT_BYTES,
  type FrameToRelay,
  type ServerMessage,
} from "@tars/protocol";
import { loadConfig } from "../../../src/features/agent/config.ts";
import * as store from "../../../src/features/agent/store.ts";
import { Dispatch, DROP } from "../../../src/features/serve/dispatch.ts";
import type { Verdict } from "../../../src/features/serve/access.ts";
import { tarsCall, text } from "../../fakes/anthropic.ts";
import { tempHome } from "../../helpers.ts";
import {
  engineHarness,
  MODEL_ENTRY,
  type EngineHarness,
  type HarnessOptions,
} from "../agent/engine-fixture.ts";
import { installSample, sampleScript } from "../script/sample.ts";
import {
  CONN_A,
  CONN_B,
  manualTimers,
  recordedLog,
  testHub,
  type RecordedLog,
  type ManualTimers,
  type TestHub,
} from "./fixture.ts";

const VERSION = "0123456789abcdef";
const harnesses: EngineHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
});

function fakeTars(body: string): string {
  const path = join(tempHome(), "fake-tars");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

interface Setup {
  h: EngineHarness;
  hub: TestHub;
  d: Dispatch;
  frames: FrameToRelay[];
  /** Finishes the checks waiting on jwt "held". */
  release(): void;
  /** How many checks are waiting on jwt "held". */
  checking(): number;
  log: RecordedLog;
  db: Database;
  reconciled: string[];
  /** Sends a client message from `conn`. */
  msg(conn: string, kind: string, p: unknown, extra?: Record<string, unknown>): Promise<string>;
  open(conn: string, jwt?: string): Promise<void>;
  /** open + hello. */
  ready(conn: string): Promise<void>;
}

let ids = 0;
const CERT_EXPIRES = 1_900_000_000_000;
/** A skill in the local end's skills directory, as tars install leaves it. */
function skillIn(s: Setup, name: string, description: string): void {
  mkdirSync(join(s.h.paths.skills, name), { recursive: true });
  writeFileSync(
    join(s.h.paths.skills, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
}

async function setup(extra: Omit<HarnessOptions, "selfCommand"> = {}): Promise<Setup> {
  const h = await engineHarness({ selfCommand: [fakeTars('echo "ran $*"')], ...extra });
  harnesses.push(h);
  const timers = manualTimers(h.clock.now().getTime());
  const log = recordedLog();
  const hub = testHub({ timers, log });
  const frames: FrameToRelay[] = [];
  const reconciled: string[] = [];
  const held: (() => void)[] = [];
  const verdicts: Record<string, Verdict> = {
    good: { ok: true, exp: Number.MAX_SAFE_INTEGER },
    short: { ok: true, exp: timers.now() + 1000 },
    bad: { ok: false, reason: "denied" },
    nokeys: { ok: false, reason: "keys_unavailable" },
  };
  const d = new Dispatch({
    db: h.db,
    paths: h.paths,
    engine: h.engine,
    verifier: {
      verify: async (jwt) => {
        if (jwt === "throw") throw new Error("boom");
        // Access's keys still on their way: the test lets the check finish.
        if (jwt === "held") await new Promise<void>((done) => held.push(done));
        return verdicts[jwt === "held" ? "good" : jwt] ?? { ok: false, reason: "denied" };
      },
    },
    hub,
    version: "0.0.1",
    log,
    now: timers.now,
    sendFrame: (f) => {
      frames.push(f);
      if (f.t === "drop") hub.registry.remove(f.conn);
    },
    config: async () => (await loadConfig(h.paths)).config,
    reconcile: async (p) => void reconciled.push(p),
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    changed: () => undefined,
    certExpiresAt: () => CERT_EXPIRES,
    secrets: h.secrets,
  });
  const s: Setup = {
    h,
    hub,
    d,
    frames,
    release: () => {
      for (const done of held.splice(0)) done();
    },
    log,
    checking: () => held.length,
    db: h.db,
    reconciled,
    async msg(conn, kind, p, extra = {}) {
      const id = `c-${++ids}`;
      await d.onFrame({ t: "msg", conn, m: { v: PROTOCOL_VERSION, id, kind, p, ...extra } });
      return id;
    },
    open: (conn, jwt = "good") => d.onFrame({ t: "open", conn, jwt, country: "TW", ua: "Firefox" }),
    async ready(conn) {
      await s.open(conn);
      await s.msg(conn, "hello", {});
    },
  };
  return s;
}

const wireBytesOf = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
const reply = (s: Setup, conn: string, re: string) => s.hub.to(conn).find((m) => m.re === re);
const reason = (m: ServerMessage | undefined) => (m?.p as { reason?: string } | undefined)?.reason;
const allValid = (s: Setup) => {
  const bad = s.hub.sent.filter((x) => !parseServer(JSON.stringify(x.m)).ok).map((x) => x.m);
  expect(bad).toEqual([]);
};
const ended = (s: Setup, conn: string) =>
  s.hub.to(conn, "turn").some((m) => (m.p as { state: string }).state !== "started");

describe("Dispatch: connections", () => {
  test("open: checked here; a bad login is dropped 4003, unfetchable keys 4004", async () => {
    const s = await setup();
    await s.open(CONN_A);
    expect(s.hub.registry.get(CONN_A)).toMatchObject({
      country: "TW",
      ua: "Firefox",
      hello: false,
    });
    await s.open(CONN_B, "bad");
    await s.open("33333333-3333-4333-8333-333333333333", "nokeys");
    expect(s.frames).toEqual([
      { t: "drop", conn: CONN_B, code: DROP.auth },
      { t: "drop", conn: "33333333-3333-4333-8333-333333333333", code: DROP.keys },
    ]);
    expect(s.hub.registry.get(CONN_B)).toBeUndefined();
  });

  test("a message from a connection this side never checked gets not_allowed and a drop", async () => {
    const s = await setup();
    await s.msg(CONN_A, "conv.list", {});
    expect(s.frames).toHaveLength(2);
    expect(s.frames[0]).toMatchObject({
      t: "msg",
      to: CONN_A,
      m: { kind: "nack", p: { reason: "not_allowed" } },
    });
    expect(s.frames[1]).toEqual({ t: "drop", conn: CONN_A, code: DROP.auth });
  });

  test("before hello only hello is answered; hello gives epoch, status, pending approvals", async () => {
    const s = await setup();
    await s.open(CONN_A);
    const early = await s.msg(CONN_A, "conv.list", {});
    expect(reply(s, CONN_A, early)?.p).toEqual({ reason: "version", need: "client" });
    const hi = await s.msg(CONN_A, "hello", {});
    expect(reply(s, CONN_A, hi)).toMatchObject({
      kind: "hello",
      p: { epoch: store.readEpoch(s.db), tars: "0.0.1" },
    });
    expect(s.hub.to(CONN_A).map((m) => m.kind)).toEqual(["nack", "hello", "status"]);
    allValid(s);
  });

  test("a malformed message is bad_message; a newer version asks for a newer local end", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    const bad = await s.msg(CONN_A, "conv.list", { extra: 1 });
    expect(reason(reply(s, CONN_A, bad))).toBe("bad_message");
    await s.d.onFrame({
      t: "msg",
      conn: CONN_A,
      m: { v: PROTOCOL_VERSION + 1, id: "v-1", kind: "hello", p: {} },
    });
    expect(reply(s, CONN_A, "v-1")?.p).toEqual({ reason: "version", need: "local" });
  });

  test("SIGINT's stop aborts the turn and waits for its cleanup", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    s.h.fake.reply({ kind: "hang" });
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    await until(() => s.d.current?.frontend.turnId !== undefined);
    await s.d.stop(5000);
    expect(s.d.current).toBeUndefined();
  });

  test("a failing handler is logged, not thrown, with where it failed and nothing personal", async () => {
    const s = await setup();
    await s.open(CONN_A, "throw");
    expect(s.hub.registry.size).toBe(0);
    expect(s.log.lines.filter((l) => l.event === "warning")).toEqual([
      {
        event: "warning",
        fields: { connId: store.shortId(CONN_A), frame: "open", errorName: "Error" },
      },
    ]);
  });

  test("a connection with 32 frames waiting is dropped 4005; what it queued does nothing", async () => {
    const s = await setup();
    const waiting = [s.open(CONN_A, "held")];
    for (let i = 0; i < 31; i++) waiting.push(s.msg(CONN_A, "hello", {}).then(() => undefined));
    expect(s.frames).toEqual([]);
    waiting.push(s.msg(CONN_A, "conv.list", {}).then(() => undefined));
    waiting.push(s.msg(CONN_A, "conv.list", {}).then(() => undefined));
    expect(s.frames).toEqual([{ t: "drop", conn: CONN_A, code: DROP.flood }]);
    s.release();
    await Promise.all(waiting);
    expect(s.hub.registry.get(CONN_A)).toBeUndefined();
    expect(s.hub.sent).toEqual([]);
    expect(s.frames).toHaveLength(1);
    expect(s.log.lines).toContainEqual({
      event: "conn",
      fields: { state: "closed", connId: store.shortId(CONN_A), code: DROP.flood, count: 32 },
    });
    // Another connection never waited on it.
    await s.ready(CONN_B);
    expect(s.hub.to(CONN_B).map((m) => m.kind)).toEqual(["hello", "status"]);
  });

  describe("dropped 4005 while its open is already being checked", () => {
    async function floodWhileChecking(s: Setup) {
      const waiting = [s.open(CONN_A, "held")];
      await until(() => s.checking() === 1);
      for (let i = 0; i < 30; i++) waiting.push(s.msg(CONN_A, "hello", {}).then(() => undefined));
      waiting.push(
        s
          .msg(CONN_A, "turn.submit", { requestId: "r-flood", text: "不該執行" })
          .then(() => undefined),
      );
      waiting.push(s.msg(CONN_A, "conv.list", {}).then(() => undefined));
      expect(s.frames).toEqual([{ t: "drop", conn: CONN_A, code: DROP.flood }]);
      return waiting;
    }
    const nothingRan = (s: Setup) => {
      expect(s.hub.registry.get(CONN_A)).toBeUndefined();
      expect(s.hub.sent).toEqual([]);
      expect(s.d.current).toBeUndefined();
      expect(store.findTurnByRequest(s.db, "r-flood")).toBeUndefined();
      expect(s.frames).toHaveLength(1);
    };

    test("the check finishing afterwards does not register it again", async () => {
      const s = await setup();
      const waiting = await floodWhileChecking(s);
      s.release();
      await Promise.all(waiting);
      nothingRan(s);
    });

    test("the relay's close arriving first does not bring its queue back", async () => {
      const s = await setup();
      const waiting = await floodWhileChecking(s);
      await s.d.onFrame({ t: "close", conn: CONN_A });
      s.release();
      await Promise.all(waiting);
      nothingRan(s);
    });
  });

  test("a message right behind its open waits for the check, not refused", async () => {
    const s = await setup();
    const open = s.open(CONN_A);
    const hi = s.msg(CONN_A, "hello", {});
    await Promise.all([open, hi]);
    expect(s.hub.to(CONN_A).map((m) => m.kind)).toEqual(["hello", "status"]);
    expect(s.frames).toEqual([]);
  });

  test("a link that reset while an open was being checked: the open and what queued behind it do nothing", async () => {
    const s = await setup();
    const open = s.open(CONN_A, "held");
    const hi = s.msg(CONN_A, "hello", {});
    const sub = s.msg(CONN_A, "turn.submit", { requestId: "r-old", text: "舊的" });
    await until(() => s.hub.registry.size === 0 && s.frames.length === 0);
    s.d.reset();
    s.release();
    await Promise.all([open, hi, sub]);
    expect(s.hub.registry.get(CONN_A)).toBeUndefined();
    expect(s.d.current).toBeUndefined();
    expect(s.hub.sent).toEqual([]);
    expect(s.frames).toEqual([]);
    expect(store.findTurnByRequest(s.db, "r-old")).toBeUndefined();
  });

  test("close unregisters", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    await s.d.onFrame({ t: "close", conn: CONN_A });
    expect(s.hub.registry.get(CONN_A)).toBeUndefined();
  });
});

describe("Dispatch: turns", () => {
  test("a new conversation: ack, started, the user item, the reply, the end, status for everyone", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    await s.ready(CONN_B);
    s.h.fake.reply(text("你好，我是 tars"));
    const id = await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    expect(reply(s, CONN_A, id)?.kind).toBe("ack");
    await until(() => ended(s, CONN_A));
    await until(() => s.d.current === undefined);
    await s.d.running;
    const kinds = s.hub.to(CONN_A).map((m) => m.kind);
    expect(kinds.slice(kinds.indexOf("ack"))).toEqual([
      "ack",
      "turn",
      "item",
      "delta",
      "item",
      "item",
      "turn",
      "status",
    ]);
    const items = s.hub
      .to(CONN_A, "item")
      .map((m) => (m.p as { item: { kind: string } }).item.kind);
    expect(items).toEqual(["user", "usage", "assistant"]);
    expect(s.hub.to(CONN_B, "item")).toEqual([]);
    expect(s.hub.to(CONN_B, "turn").map((m) => (m.p as { state: string }).state)).toEqual([
      "started",
      "completed",
    ]);
    expect(s.hub.to(CONN_B, "status").length).toBeGreaterThanOrEqual(2);
    expect(s.reconciled).toEqual(["anthropic"]);
    const turnId = (s.hub.to(CONN_A, "turn")[0]!.p as { turn: string }).turn;
    expect(store.findTurnByRequest(s.db, "r-1")?.id).toBe(turnId);
    allValid(s);
  });

  test("a resend of a finished request is acked with its turn and not run again; other text is refused", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    s.h.fake.reply(text("一"));
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    await until(() => ended(s, CONN_A));
    await s.d.running;
    const turnId = store.findTurnByRequest(s.db, "r-1")?.id;
    const again = await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    expect(reply(s, CONN_A, again)).toMatchObject({ kind: "ack", p: { turn: turnId } });
    const other = await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "別的" });
    expect(reason(reply(s, CONN_A, other))).toBe("bad_message");
    expect(s.h.fake.messages()).toHaveLength(1);
  });

  test("the resend's ack names the conversation too, for a page that missed the turn's start", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    s.h.fake.reply(text("一"));
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    await until(() => ended(s, CONN_A));
    await s.d.running;
    const turn = store.findTurnByRequest(s.db, "r-1");
    await s.ready(CONN_B);
    const again = await s.msg(CONN_B, "turn.submit", { requestId: "r-1", text: "嗨" });
    expect(reply(s, CONN_B, again)).toMatchObject({
      kind: "ack",
      conv: turn?.convId,
      p: { turn: turn?.id },
    });
    allValid(s);
  });

  describe("a failure before the turn exists", () => {
    async function failsThenRuns(s: Setup, fix: () => void) {
      await s.msg(CONN_A, "turn.submit", { requestId: "r-x", text: "嗨" });
      await s.d.running;
      expect(s.hub.to(CONN_A, "turn").map((m) => m.p)).toEqual([
        { requestId: "r-x", state: "failed" },
      ]);
      expect(s.d.current).toBeUndefined();
      fix();
      // The page's resend of the same request is taken as new, not answered from memory.
      s.h.fake.reply(text("好"));
      const again = await s.msg(CONN_A, "turn.submit", { requestId: "r-x", text: "嗨" });
      expect(reply(s, CONN_A, again)).toMatchObject({ kind: "ack", p: {} });
      await s.d.running;
      expect(store.findTurnByRequest(s.db, "r-x")).toBeDefined();
      allValid(s);
    }

    test("the notification it waits for throws", async () => {
      const s = await setup();
      await s.ready(CONN_A);
      const idle = s.hub.notifier.idle.bind(s.hub.notifier);
      let fail = true;
      s.hub.notifier.idle = async () => {
        if (fail) throw new Error("notify");
        return idle();
      };
      await failsThenRuns(s, () => (fail = false));
    });

    test("config.toml cannot be read", async () => {
      const s = await setup();
      await s.ready(CONN_A);
      const file = s.h.paths.configFile;
      const good = readFileSync(file, "utf8");
      writeFileSync(file, "[providers\n");
      await failsThenRuns(s, () => writeFileSync(file, good));
    });
  });

  describe("a failure after the turn exists", () => {
    test("between the commit and turn_start: the failure names the turn and its conversation", async () => {
      const s = await setup();
      await s.ready(CONN_A);
      const run = s.h.engine.runTurn.bind(s.h.engine);
      s.h.engine.runTurn = (input, frontend, signal) =>
        run(
          input,
          {
            ...frontend,
            emit: (e) => {
              if (e.type === "turn_start") throw new Error("after commit");
              frontend.emit(e);
            },
          } as typeof frontend,
          signal,
        );
      await s.msg(CONN_A, "turn.submit", { requestId: "r-y", text: "嗨" });
      await s.d.running;
      const row = store.findTurnByRequest(s.db, "r-y");
      expect(row).toBeDefined();
      const sent = s.hub.to(CONN_A, "turn");
      expect(sent.map((m) => m.p)).toEqual([{ turn: row?.id, requestId: "r-y", state: "failed" }]);
      expect(sent[0]?.conv).toBe(row?.convId);
      expect(s.d.current).toBeUndefined();
      // The request stays known: its resend is acked with the same turn, not run again.
      const again = await s.msg(CONN_A, "turn.submit", { requestId: "r-y", text: "嗨" });
      expect(reply(s, CONN_A, again)).toMatchObject({ kind: "ack", p: { turn: row?.id } });
    });

    test("the database lookup in the catch throws too: still forgotten, still failed", async () => {
      const s = await setup();
      await s.ready(CONN_A);
      s.hub.notifier.idle = async () => {
        throw new Error("notify");
      };
      const find = store.findTurnByRequest;
      // The resend check before the run still works; the database is gone by the catch.
      let calls = 0;
      const spied = spyOn(store, "findTurnByRequest").mockImplementation((db, id) => {
        if (++calls === 1) return find(db, id);
        throw new Error("db gone");
      });
      try {
        await s.msg(CONN_A, "turn.submit", { requestId: "r-z", text: "嗨" });
        await s.d.running;
      } finally {
        spied.mockRestore();
      }
      expect(calls).toBe(2);
      expect(s.hub.to(CONN_A, "turn").map((m) => m.p)).toEqual([
        { requestId: "r-z", state: "failed" },
      ]);
      expect(s.d.current).toBeUndefined();
    });
  });

  test("continuing a conversation uses its own model; an unknown conversation is not_found", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    s.h.fake.reply(text("一"), text("二"));
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    await until(() => ended(s, CONN_A));
    await s.d.running;
    const conv = store.findTurnByRequest(s.db, "r-1")!.convId;
    await s.msg(CONN_A, "turn.submit", { requestId: "r-2", text: "再一次" }, { conv });
    await until(() => s.d.current === undefined && s.h.fake.messages().length === 2);
    expect(store.findTurnByRequest(s.db, "r-2")?.convId).toBe(conv);
    const lost = await s.msg(
      CONN_A,
      "turn.submit",
      { requestId: "r-3", text: "x" },
      { conv: "no-such-conv" },
    );
    expect(reason(reply(s, CONN_A, lost))).toBe("not_found");
  });

  test("no usable default model: rejected, with the reason", async () => {
    const s = await setup();
    writeFileSync(s.h.paths.modelsFile, JSON.stringify({ version: 1, models: [] }));
    await s.ready(CONN_A);
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    await until(() => s.d.current === undefined);
    await s.d.running;
    expect(s.hub.to(CONN_A, "turn")[0]?.p).toMatchObject({
      requestId: "r-1",
      state: "rejected",
      reason: "unknown_model",
    });
    expect(s.d.pending.size).toBe(0);
  });

  test("an expired login cannot submit", async () => {
    const s = await setup();
    await s.open(CONN_A, "short");
    await s.msg(CONN_A, "hello", {});
    (s.hub.timers as ManualTimers).advance(1000);
    expect(s.hub.registry.get(CONN_A)).toBeUndefined();
    // Gone from the registry: the next message is not_allowed, and nothing runs.
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨" });
    expect(s.frames.at(-1)).toEqual({ t: "drop", conn: CONN_A, code: DROP.auth });
    expect(s.d.current).toBeUndefined();
  });
});

describe("Dispatch: approvals while a turn runs", () => {
  async function waiting() {
    const s = await setup();
    installSample(
      s.h.paths.scripts,
      "push",
      sampleScript({
        name: "push",
        tarsLines: [
          'name = "push"',
          'summary = "推播"',
          'domains = ["api.example.com"]',
          'effects = "external-write"',
          'args = "--city <名稱>"',
          'outputs = "一行"',
          'exit = { 0 = "成功" }',
        ],
      }),
      VERSION,
    );
    await s.ready(CONN_A);
    await s.ready(CONN_B);
    s.h.fake.reply(
      tarsCall("tu1", ["script", "run", "push", "--", "--city", "Taipei"]),
      text("送出了"),
    );
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "推播" });
    await until(() => s.hub.to(CONN_B, "approval.request").length === 1);
    const req = s.hub.to(CONN_B, "approval.request")[0]!.p as {
      approval: { approvalId: string; hash: string };
    };
    return { s, approval: req.approval };
  }

  test("another device approves; the decision is recorded via remote and everyone hears it", async () => {
    const { s, approval } = await waiting();
    const busy = await s.msg(CONN_B, "turn.submit", { requestId: "r-2", text: "另一件" });
    expect(reason(reply(s, CONN_B, busy))).toBe("busy");
    const d = await s.msg(CONN_B, "approval.decide", {
      approvalId: approval.approvalId,
      decision: "approved",
      hash: approval.hash,
    });
    expect(reply(s, CONN_B, d)?.kind).toBe("ack");
    await until(() => ended(s, CONN_A));
    await s.d.running;
    for (const conn of [CONN_A, CONN_B])
      expect(s.hub.to(conn, "approval.resolved")[0]?.p).toEqual({
        approvalId: approval.approvalId,
        state: "approved",
        via: "remote",
      });
    expect(s.db.query("SELECT state, decided_via FROM approvals").all()).toEqual([
      { state: "approved", decided_via: "remote" },
    ]);
    allValid(s);
  });

  test("a device that says hello while it waits gets the pending request", async () => {
    const { s } = await waiting();
    const late = "44444444-4444-4444-8444-444444444444";
    await s.ready(late);
    expect(s.hub.to(late).map((m) => m.kind)).toEqual(["hello", "status", "approval.request"]);
    expect(
      s.hub.to(late, "status")[0]!.p as { pendingApprovals: number; turnRunning: boolean },
    ).toMatchObject({ pendingApprovals: 1, turnRunning: true });
    s.d.current?.controller.abort();
    await until(() => s.d.current === undefined);
    await s.d.running;
  });

  test("turn.abort for the running conversation cancels the approval and ends the turn", async () => {
    const { s, approval } = await waiting();
    const conv = s.d.current!.frontend.convId!;
    const id = await s.msg(CONN_B, "turn.abort", {}, { conv });
    expect(reply(s, CONN_B, id)?.kind).toBe("ack");
    await until(() => s.d.current === undefined);
    await s.d.running;
    expect(s.hub.to(CONN_A, "approval.resolved")[0]?.p).toMatchObject({
      approvalId: approval.approvalId,
      state: "cancelled",
      via: "abort",
    });
    expect(s.hub.to(CONN_A, "turn").at(-1)?.p).toMatchObject({ state: "aborted" });
  });

  test("a decision with no turn running is already_decided", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    const d = await s.msg(CONN_A, "approval.decide", {
      approvalId: "x",
      decision: "approved",
      hash: "a".repeat(64),
    });
    expect(reason(reply(s, CONN_A, d))).toBe("already_decided");
  });
});

describe("Dispatch: snapshots", () => {
  const withItems = (n: number, size: number) =>
    withReplies(Array.from({ length: n }, (_, i) => `${i}:${"字".repeat(size)}`));

  async function withReplies(replies: string[]) {
    const s = await setup();
    const n = replies.length;
    s.h.fake.reply(...replies.map((r) => text(r)));
    let conv: string | undefined;
    for (let i = 0; i < n; i++) {
      const out = await s.h.engine.runTurn(
        {
          provider: "anthropic",
          model: "model-a",
          effort: "medium",
          text: `q${i}`,
          ...(conv === undefined ? {} : { convId: conv }),
        },
        s.h.frontend,
        new AbortController().signal,
      );
      if (out.kind !== "ended") throw new Error("turn did not end");
      conv = out.convId;
    }
    await s.ready(CONN_A);
    return { s, conv: conv as string };
  }

  test("the newest items, oldest first, with more when older ones exist", async () => {
    const { s, conv } = await withItems(30, 10);
    const id = await s.msg(CONN_A, "conv.open", {}, { conv });
    const snap = reply(s, CONN_A, id)!;
    expect(snap.kind).toBe("conv.snapshot");
    const p = snap.p as { items: { seq: number }[]; more: boolean; epoch: string };
    expect(p.items).toHaveLength(50);
    expect(p.more).toBe(true);
    const seqs = p.items.map((i) => i.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(s.hub.registry.get(CONN_A)!.subscribed).toBe(conv);
    const older = await s.msg(CONN_A, "conv.open", { before: seqs[0] }, { conv });
    const q = reply(s, CONN_A, older)!.p as { items: { seq: number }[] };
    expect(Math.max(...q.items.map((i) => i.seq))).toBeLessThan(seqs[0]!);
    allValid(s);
  });

  test("the byte budget keeps the snapshot under SNAPSHOT_BYTES", async () => {
    const { s, conv } = await withItems(12, 10_000);
    const id = await s.msg(CONN_A, "conv.open", {}, { conv });
    const snap = reply(s, CONN_A, id)!;
    expect(
      Buffer.byteLength(JSON.stringify((snap.p as { items: unknown[] }).items)),
    ).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    expect((snap.p as { more: boolean }).more).toBe(true);
  });

  test("a newest item that JSON escapes to over the budget still comes, so paging can go on", async () => {
    const { s, conv } = await withReplies(["早的", "\u0001".repeat(60_000)]);
    const id = await s.msg(CONN_A, "conv.open", {}, { conv });
    const snap = reply(s, CONN_A, id)!;
    const p = snap.p as {
      items: { seq: number; kind: string; truncated?: boolean }[];
      more: boolean;
    };
    expect(p.items.at(-1)).toMatchObject({ kind: "assistant", truncated: true });
    expect(wireBytesOf(p.items)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    const older = await s.msg(CONN_A, "conv.open", { before: p.items[0]!.seq }, { conv });
    expect(reply(s, CONN_A, older)?.kind).toBe("conv.snapshot");
    allValid(s);
  });

  test("status lists the skills for the / menu, local-only marked, and the certificate's expiry", async () => {
    const s = await setup();
    skillIn(s, "demo", "長".repeat(400));
    skillIn(s, "memory", "記憶");
    await s.open(CONN_A, "good");
    await s.msg(CONN_A, "hello", {});
    const st = await s.msg(CONN_A, "status.get", {});
    const p = reply(s, CONN_A, st)!.p as {
      skills: { name: string; description: string; localOnly: boolean }[];
      certExpiresAt: number;
    };
    expect(p.skills.map((k) => [k.name, k.localOnly])).toEqual([
      ["demo", false],
      ["memory", true],
    ]);
    // Cut to what the protocol takes, and said to be cut.
    expect(p.skills[0]!.description).toHaveLength(SKILL_TEXT);
    expect(p.skills[0]!.description.endsWith("…")).toBe(true);
    expect(p.certExpiresAt).toBe(CERT_EXPIRES);
    allValid(s);
  });

  test("status reads the skills at most once a minute: one added shows on the next read", async () => {
    const s = await setup();
    skillIn(s, "demo", "示範");
    await s.open(CONN_A, "good");
    await s.msg(CONN_A, "hello", {});
    const names = async () =>
      (
        (
          reply(s, CONN_A, await s.msg(CONN_A, "status.get", {}))?.p as
            | { skills: { name: string }[] }
            | undefined
        )?.skills ?? []
      ).map((k) => k.name);
    expect(await names()).toEqual(["demo"]);
    skillIn(s, "memory", "記憶");
    (s.hub.timers as ManualTimers).advance(59_000);
    expect(await names()).toEqual(["demo"]);
    (s.hub.timers as ManualTimers).advance(1_000);
    expect(await names()).toEqual(["demo", "memory"]);
  });

  test("an unknown conversation is not_found; conv.list lists them", async () => {
    const { s, conv } = await withItems(1, 1);
    const id = await s.msg(CONN_A, "conv.open", {}, { conv: "nope" });
    expect(reason(reply(s, CONN_A, id))).toBe("not_found");
    const list = await s.msg(CONN_A, "conv.list", {});
    expect(
      (reply(s, CONN_A, list)!.p as { convs: { id: string }[] }).convs.map((c) => c.id),
    ).toEqual([conv]);
    const st = await s.msg(CONN_A, "status.get", {});
    expect(reply(s, CONN_A, st)?.kind).toBe("status");
    allValid(s);
  });
});

describe("another model: models.get, a new conversation on it, a continuation", () => {
  const SMALL = "small-model";
  const models = {
    extraModels: [
      // A window so small that one turn of text is too long to carry.
      { ...MODEL_ENTRY, id: SMALL, label: "Small", default: false, contextWindow: 200 },
      { ...MODEL_ENTRY, provider: "gemini" as const, id: "g", label: "G", default: false },
    ],
  };
  // The same model under another id, with a window a turn fits in.
  const wide = { extraModels: [{ ...MODEL_ENTRY, id: SMALL, label: "Small", default: false }] };
  const B = { provider: "anthropic", id: SMALL };
  const turnOf = (s: Setup, conn: string, requestId: string) =>
    s.hub
      .to(conn, "turn")
      .map((m) => m.p as { requestId?: string; state: string; reason?: string })
      .find((p) => p.requestId === requestId && p.state !== "started");

  async function firstConversation(s: Setup): Promise<string> {
    s.h.fake.reply(text("一"));
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "嗨".repeat(200) });
    await until(() => ended(s, CONN_A));
    await s.d.running;
    return store.findTurnByRequest(s.db, "r-1")?.convId as string;
  }

  test("models.get: every active model, the default marked, the unusable with their reason", async () => {
    const s = await setup(models);
    await s.ready(CONN_A);
    const id = await s.msg(CONN_A, "models.get", {});
    const r = reply(s, CONN_A, id);
    expect(r?.kind).toBe("models.result");
    type Listed = { id: string; isDefault: boolean; window?: number; unusable?: string };
    const listed = (r?.p as { models?: Listed[] } | undefined)?.models ?? [];
    expect(listed.map((m) => [m.id, m.isDefault, m.unusable])).toEqual([
      [MODEL_ENTRY.id, true, undefined],
      [SMALL, false, undefined],
      ["g", false, "provider_disabled"],
    ]);
    expect(listed[1]?.window).toBe(200);
    expect(listed[2]?.window).toBeUndefined();
    allValid(s);
  });

  test("model alone: a new conversation on that model", async () => {
    const s = await setup(wide);
    await s.ready(CONN_A);
    s.h.fake.reply(text("好"));
    await s.msg(CONN_A, "turn.submit", { requestId: "r-b", text: "嗨", model: B });
    await until(() => ended(s, CONN_A));
    await s.d.running;
    const conv = store.getConversation(
      s.db,
      store.findTurnByRequest(s.db, "r-b")?.convId as string,
    );
    expect([conv.provider, conv.model, conv.parentId]).toEqual(["anthropic", SMALL, undefined]);
  });

  test("from: a new conversation that carries the text, keeps the level, and is resent as itself", async () => {
    const s = await setup(wide);
    await s.ready(CONN_A);
    const parent = await firstConversation(s);
    s.h.fake.reply(text("接續了"));
    const p = { requestId: "r-2", text: "繼續", model: B, from: parent };
    await s.msg(CONN_A, "turn.submit", p);
    await until(() => turnOf(s, CONN_A, "r-2") !== undefined);
    await s.d.running;
    const made = store.getConversation(
      s.db,
      store.findTurnByRequest(s.db, "r-2")?.convId as string,
    );
    expect([made.model, made.parentId, made.effort]).toEqual([
      SMALL,
      parent,
      store.getConversation(s.db, parent).effort,
    ]);
    const kinds = s.hub
      .to(CONN_A, "item")
      .filter((m) => m.conv === made.id)
      .map((m) => (m.p as { item: { kind: string } }).item.kind);
    expect(kinds.slice(0, 2)).toEqual(["carried", "user"]);
    const again = await s.msg(CONN_A, "turn.submit", p);
    expect(reply(s, CONN_A, again)?.kind).toBe("ack");
    const elsewhere = await s.msg(CONN_A, "turn.submit", {
      ...p,
      model: { provider: "anthropic", id: MODEL_ENTRY.id },
    });
    expect(reason(reply(s, CONN_A, elsewhere))).toBe("bad_message");
    allValid(s);
  });

  test("a carry too long for the model is refused with a code that says what to do", async () => {
    const s = await setup(models);
    await s.ready(CONN_A);
    const parent = await firstConversation(s);
    await s.msg(CONN_A, "turn.submit", { requestId: "r-3", text: "繼續", model: B, from: parent });
    await until(() => turnOf(s, CONN_A, "r-3") !== undefined);
    expect(turnOf(s, CONN_A, "r-3")).toMatchObject({
      state: "rejected",
      reason: "carry_turn_too_long",
    });
  });

  test("model or from on an open conversation, from that does not exist, a provider no one has", async () => {
    const s = await setup(models);
    await s.ready(CONN_A);
    const parent = await firstConversation(s);
    const onConv = await s.msg(
      CONN_A,
      "turn.submit",
      { requestId: "r-4", text: "x", model: B },
      { conv: parent },
    );
    expect(reason(reply(s, CONN_A, onConv))).toBe("bad_message");
    const missing = await s.msg(CONN_A, "turn.submit", {
      requestId: "r-5",
      text: "x",
      model: B,
      from: "nope",
    });
    expect(reason(reply(s, CONN_A, missing))).toBe("not_found");
    await s.msg(CONN_A, "turn.submit", {
      requestId: "r-6",
      text: "x",
      model: { provider: "nope", id: "m" },
    });
    await until(() => turnOf(s, CONN_A, "r-6") !== undefined);
    expect(turnOf(s, CONN_A, "r-6")).toMatchObject({ state: "rejected", reason: "unknown_model" });
    expect(s.h.fake.messages()).toHaveLength(1);
  });
});

describe("effort: the levels models.get lists, a turn's level, a conversation's", () => {
  const PLAIN = "plain-model";
  // A model that takes no level, and the default one that takes low, medium and high.
  const models = {
    extraModels: [{ ...MODEL_ENTRY, id: PLAIN, label: "Plain", default: false, effortLevels: [] }],
  };
  const turnOf = (s: Setup, requestId: string) =>
    s.hub
      .to(CONN_A, "turn")
      .map((m) => m.p as { requestId?: string; state: string; reason?: string })
      .find((p) => p.requestId === requestId && p.state !== "started");
  const turnEffort = (s: Setup, requestId: string) =>
    (
      s.db
        .query("SELECT effort FROM turns WHERE id = ?")
        .get(store.findTurnByRequest(s.db, requestId)?.id ?? "") as { effort: string | null }
    ).effort;
  async function send(s: Setup, p: Record<string, unknown>, conv?: string) {
    s.h.fake.reply(text("好"));
    await s.msg(CONN_A, "turn.submit", p, conv === undefined ? {} : { conv });
    await until(() => turnOf(s, p.requestId as string) !== undefined);
    await s.d.running;
    return turnOf(s, p.requestId as string);
  }

  test("models.get: each model's levels, lowest first, and the level a new conversation gets", async () => {
    const s = await setup(models);
    await s.ready(CONN_A);
    const r = reply(s, CONN_A, await s.msg(CONN_A, "models.get", {}));
    type Listed = { id: string; effortLevels?: string[]; defaultEffort?: string };
    const listed = (r?.p as { models: Listed[] } | undefined)?.models ?? [];
    expect(listed.map((m) => [m.id, m.effortLevels, m.defaultEffort])).toEqual([
      [MODEL_ENTRY.id, ["low", "medium", "high"], "medium"],
      [PLAIN, [], undefined],
    ]);
    allValid(s);
  });

  test("on a conversation: the level is sent from that turn on and kept; one the model does not take is refused", async () => {
    const s = await setup(models);
    await s.ready(CONN_A);
    await send(s, { requestId: "r-1", text: "嗨" });
    const conv = store.findTurnByRequest(s.db, "r-1")?.convId as string;
    expect(store.getConversation(s.db, conv).effort).toBe("medium");

    expect(await send(s, { requestId: "r-2", text: "再想想", effort: "high" }, conv)).toMatchObject(
      {
        state: "completed",
      },
    );
    expect(turnEffort(s, "r-2")).toBe("high");
    expect(store.getConversation(s.db, conv).effort).toBe("high");
    // The next turn, sent without one, keeps it.
    await send(s, { requestId: "r-3", text: "繼續" }, conv);
    expect(turnEffort(s, "r-3")).toBe("high");

    const calls = s.h.fake.messages().length;
    for (const [requestId, effort] of [
      ["r-4", "max"],
      ["r-5", "ultra"],
    ] as const)
      expect(await send(s, { requestId, text: "x", effort }, conv)).toMatchObject({
        state: "rejected",
        reason: "effort_unsupported",
      });
    expect(s.h.fake.messages()).toHaveLength(calls);
    expect(store.getConversation(s.db, conv).effort).toBe("high");

    s.hub.sent.length = 0;
    const listed = reply(s, CONN_A, await s.msg(CONN_A, "conv.list", {}));
    expect(
      (listed?.p as { convs: { id: string; effort?: string }[] } | undefined)?.convs ?? [],
    ).toContainEqual(expect.objectContaining({ id: conv, effort: "high" }));
    allValid(s);
  });

  test("a new conversation: its level with its model; any level on a model that takes none is refused", async () => {
    const s = await setup(models);
    await s.ready(CONN_A);
    await send(s, { requestId: "r-1", text: "嗨", effort: "low" });
    const made = store.findTurnByRequest(s.db, "r-1")?.convId as string;
    expect(store.getConversation(s.db, made).effort).toBe("low");
    expect(turnEffort(s, "r-1")).toBe("low");
    expect(
      await send(s, {
        requestId: "r-2",
        text: "嗨",
        model: { provider: "anthropic", id: PLAIN },
        effort: "low",
      }),
    ).toMatchObject({ state: "rejected", reason: "effort_unsupported" });
  });
});

describe("Dispatch: the knowledge base (wiki.*)", () => {
  test("each request gets its result, only to the page that asked, and no model runs", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    await s.ready(CONN_B);
    const asked: [string, object][] = [
      ["wiki.status", {}],
      ["wiki.list", {}],
      ["wiki.page", { path: "people/nobody" }],
      ["wiki.search", { query: "西屯" }],
      ["wiki.source", { ref: "deadbeef/deadbeef" }],
    ];
    for (const [kind, p] of asked) {
      const id = await s.msg(CONN_A, kind, p);
      expect(reply(s, CONN_A, id)?.kind).toBe(`${kind}.result` as ServerMessage["kind"]);
    }
    expect(reply(s, CONN_A, await s.msg(CONN_A, "wiki.status", {}))?.p).toMatchObject({
      synced: false,
      total: 0,
    });
    expect(s.hub.to(CONN_B).filter((m) => m.kind.startsWith("wiki."))).toEqual([]);
    expect(s.h.fake.messages()).toEqual([]);
    allValid(s);
  });

  test("a login run out gets auth_expired, and nothing is read", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    // Only the check before reading fails: the hub itself sends to a connection it still holds.
    spyOn(s.hub.registry, "valid").mockReturnValueOnce(false);
    const id = await s.msg(CONN_A, "wiki.status", {});
    expect(reply(s, CONN_A, id)?.kind).toBe("nack");
    expect(reason(reply(s, CONN_A, id))).toBe("auth_expired");
    expect(s.hub.to(CONN_A, "wiki.status.result")).toEqual([]);
  });

  test("a wiki.db from a newer tars: a version nack that asks for the local end", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    const { openWikiDb } = await import("../../../src/features/wiki/db.ts");
    const db = await openWikiDb(s.h.paths);
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db.close();
    const id = await s.msg(CONN_A, "wiki.list", {});
    expect(reply(s, CONN_A, id)?.p).toEqual({ reason: "version", need: "local" });
  });

  test("a request outside the rules is bad_message, as an older local end answers any wiki.*", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    const id = await s.msg(CONN_A, "wiki.page", { path: "people/../../MEMORY" });
    expect(reason(reply(s, CONN_A, id))).toBe("bad_message");
  });
});
