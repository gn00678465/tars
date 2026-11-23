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
  type WireStatus,
} from "@tars/protocol";
import { SUMMARY_HEADINGS } from "../../../src/features/agent/compaction.ts";
import { estimateTokens, utf8Bytes } from "../../../src/features/agent/bytes.ts";
import { loadConfig } from "../../../src/features/agent/config.ts";
import { adjust } from "../../../src/features/agent/ledger.ts";
import * as store from "../../../src/features/agent/store.ts";
import { Dispatch, DROP } from "../../../src/features/serve/dispatch.ts";
import { wireLookup } from "../../../src/features/serve/wire.ts";
import type { Verdict } from "../../../src/features/serve/access.ts";
import { tarsCall, text, toolUse } from "../../fakes/anthropic.ts";
import sample from "../../../apps/web/src/components/ledger-form.sample.json";
import { seedTurn } from "../agent/db-fixture.ts";
import { tempHome } from "../../helpers.ts";
import {
  configWith,
  engineHarness,
  writeCatalog,
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
  timers: ManualTimers;
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
  const hub = testHub({ timers, log, lookup: wireLookup(h.db) });
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
    timers,
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
      "turn.phase",
      "turn.phase",
      "delta",
      "item",
      "item",
      "turn",
      "conv.context",
      "status",
    ]);
    // Waiting on the model, then its first token; nothing to the device that has not opened it.
    expect(s.hub.to(CONN_A, "turn.phase").map((m) => (m.p as { phase: string }).phase)).toEqual([
      "thinking",
      "replying",
    ]);
    expect(s.hub.to(CONN_B, "turn.phase")).toEqual([]);
    expect(s.hub.to(CONN_A, "conv.context")[0]?.p).toMatchObject({
      contextLimit: 200_000,
      warnRatio: 0.6,
      stopRatio: 0.85,
    });
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
    // The first device, a moment late: told what was decided, and that it was not this one.
    const late = await s.msg(CONN_A, "approval.decide", {
      approvalId: approval.approvalId,
      decision: "denied",
      hash: approval.hash,
    });
    expect(reply(s, CONN_A, late)?.p).toEqual({
      reason: "already_decided",
      state: "approved",
      source: "other_device",
    });
    await until(() => ended(s, CONN_A));
    await s.d.running;
    const { decided_at: at } = s.db.query("SELECT decided_at FROM approvals").get() as {
      decided_at: number;
    };
    for (const [conn, source] of [
      [CONN_A, "other_device"],
      [CONN_B, "this"],
    ] as const)
      expect(s.hub.to(conn, "approval.resolved")[0]?.p).toEqual({
        approvalId: approval.approvalId,
        state: "approved",
        via: "remote",
        at,
        source,
      });
    // After the turn: the row says what was decided; which device, it does not know.
    const after = await s.msg(CONN_A, "approval.decide", {
      approvalId: approval.approvalId,
      decision: "denied",
      hash: approval.hash,
    });
    expect(reply(s, CONN_A, after)?.p).toEqual({ reason: "already_decided", state: "approved" });
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

describe("conv.compact: the terminal's /compact from a page", () => {
  // keep_recent 1,000 tokens: a few long turns leave earlier ones to replace.
  const SHORT_KEEP = configWith({ compact_keep_recent_tokens: 1000 });
  const SUMMARY = SUMMARY_HEADINGS.map((h) => `## ${h}\n- (none)`).join("\n\n");

  async function longConv(s: Setup): Promise<string> {
    let convId: string | undefined;
    for (let i = 0; i < 4; i++) {
      s.h.fake.reply(text("a".repeat(3000)));
      const out = await s.h.engine.runTurn(
        {
          provider: "anthropic",
          model: MODEL_ENTRY.id,
          effort: "medium",
          text: `${"u".repeat(3000)} ${i}`,
          ...(convId === undefined ? {} : { convId }),
        },
        s.h.frontend,
        new AbortController().signal,
      );
      if (out.kind !== "ended") throw new Error("turn did not run");
      convId = out.convId;
    }
    return convId as string;
  }

  async function opened(): Promise<{ s: Setup; conv: string; items: () => number }> {
    const s = await setup({ config: SHORT_KEEP });
    await s.ready(CONN_A);
    await s.ready(CONN_B);
    const conv = await longConv(s);
    await s.msg(CONN_B, "conv.open", {}, { conv });
    const items = () => store.readItems(s.db, conv).length;
    return { s, conv, items };
  }

  const states = (s: Setup, conn: string) =>
    s.hub.to(conn, "compact").map((m) => (m.p as { state: string }).state);
  const done = (s: Setup) => until(() => s.d.current === undefined).then(() => s.d.running);

  test("done: started, the compaction item with its figures, completed, then the context", async () => {
    const { s, conv, items } = await opened();
    const before = items();
    s.h.fake.reply(text(SUMMARY));
    const id = await s.msg(CONN_A, "conv.compact", { focus: "保留路徑" }, { conv });
    expect(reply(s, CONN_A, id)?.kind).toBe("ack");
    await done(s);
    expect(states(s, CONN_A)).toEqual(["started", "completed"]);
    // The other device has it open: it hears the same.
    expect(states(s, CONN_B)).toEqual(["started", "completed"]);
    const item = s.hub
      .to(CONN_B, "item")
      .map((m) => (m.p as { item: Record<string, unknown> }).item)
      .find((i) => i.kind === "compaction");
    expect(item?.trigger).toBe("manual");
    expect(item?.count).toBeGreaterThan(0);
    expect(item?.keptTokens).toBeGreaterThan(0);
    expect(items()).toBe(before + 1);
    const prompt = JSON.stringify(s.h.fake.messages().at(-1)?.body);
    expect(prompt).toContain("Additional focus: 保留路徑");
    allValid(s);
    const context = s.hub.to(CONN_A, "conv.context").at(-1)?.p as {
      lastCompactedAt?: number;
      contextUsed: number;
      estimated?: boolean;
    };
    expect(context.lastCompactedAt).toBe(s.h.clock.now().getTime());
    // The measured total is zeroed: the kept turns and the summary, as an estimate, not 0.
    expect(store.getConversation(s.db, conv).lastTotalInputTokens).toBe(0);
    expect(context.contextUsed).toBe(
      (item?.keptTokens as number) + estimateTokens(utf8Bytes(SUMMARY)),
    );
    expect(context.estimated).toBe(true);
    // The owner asked for it: the notice says so, not that the context is near its limit.
    const notices = s.hub.to(CONN_B, "notice").map((m) => m.p);
    expect(notices).toContainEqual({ code: "compact_start", data: { trigger: "manual" } });
  });

  test("the next request measures the context again: no estimate after it", async () => {
    const { s, conv } = await opened();
    s.h.fake.reply(text(SUMMARY));
    await s.msg(CONN_A, "conv.compact", {}, { conv });
    await done(s);
    s.h.fake.reply(text("好"));
    await s.msg(
      CONN_A,
      "turn.submit",
      { requestId: "req-after-compact", text: "暗號是？" },
      { conv },
    );
    await done(s);
    const context = s.hub.to(CONN_A, "conv.context").at(-1)?.p as {
      contextUsed: number;
      estimated?: boolean;
    };
    expect(context.estimated).toBeUndefined();
    expect(context.contextUsed).toBe(store.getConversation(s.db, conv).lastTotalInputTokens);
    expect(context.contextUsed).toBeGreaterThan(0);
  });

  test("one at a time: a second compact and a turn while it runs are busy", async () => {
    const { s, conv } = await opened();
    s.h.fake.reply({ kind: "hang" });
    await s.msg(CONN_A, "conv.compact", {}, { conv });
    const again = await s.msg(CONN_B, "conv.compact", {}, { conv });
    expect(reason(reply(s, CONN_B, again))).toBe("busy");
    // A page that reloads meanwhile sees it under way, though it has no turn to show.
    const open = await s.msg(CONN_B, "conv.open", {}, { conv });
    expect(reply(s, CONN_B, open)?.p).toMatchObject({ compacting: true });
    expect(
      (reply(s, CONN_B, open)?.p as { running?: unknown } | undefined)?.running,
    ).toBeUndefined();
    const turn = await s.msg(CONN_B, "turn.submit", { requestId: "r-x", text: "hi" }, { conv });
    expect(reason(reply(s, CONN_B, turn))).toBe("busy");
    s.d.current?.controller.abort();
    await done(s);
  });

  test("turn.abort stops it: aborted, the conversation as it was", async () => {
    const { s, conv, items } = await opened();
    const before = items();
    const requests = s.h.fake.messages().length;
    s.h.fake.reply({ kind: "hang" });
    await s.msg(CONN_A, "conv.compact", {}, { conv });
    await until(() => s.h.fake.messages().length > requests);
    const stop = await s.msg(CONN_B, "turn.abort", {}, { conv });
    expect(reply(s, CONN_B, stop)?.kind).toBe("ack");
    await done(s);
    expect(states(s, CONN_A)).toEqual(["started", "aborted"]);
    const after = await s.msg(CONN_B, "conv.open", {}, { conv });
    expect(
      (reply(s, CONN_B, after)?.p as { compacting?: true } | undefined)?.compacting,
    ).toBeUndefined();
    expect(items()).toBe(before);
    expect(s.db.query("SELECT state FROM turns WHERE kind = 'compaction'").all()).toEqual([
      { state: "aborted" },
    ]);
  });

  test("a provider failure: failed with its reason, the conversation as it was", async () => {
    const { s, conv, items } = await opened();
    const before = items();
    s.h.fake.reply({ kind: "http_error", status: 400, type: "invalid_request_error" });
    await s.msg(CONN_A, "conv.compact", {}, { conv });
    await done(s);
    expect(s.hub.to(CONN_A, "compact").at(-1)?.p).toEqual({
      state: "failed",
      reason: "bad_request",
    });
    expect(items()).toBe(before);
  });

  test("at the stop line: refused by the budget before any request, with the figures", async () => {
    const { s, conv, items } = await opened();
    const before = items();
    const requests = s.h.fake.messages().length;
    adjust(s.db, "anthropic", 99, undefined, s.h.clock.now());
    await s.msg(CONN_A, "conv.compact", {}, { conv });
    await done(s);
    expect(s.hub.to(CONN_A, "compact").at(-1)?.p).toMatchObject({
      state: "failed",
      reason: "budget_stopped",
      data: { provider: "anthropic", stopUsd: 95 },
    });
    expect(s.h.fake.messages()).toHaveLength(requests);
    expect(items()).toBe(before);
  });

  test("a conversation that does not exist, and a short one with nothing to replace", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    const missing = await s.msg(CONN_A, "conv.compact", {}, { conv: "nope" });
    expect(reason(reply(s, CONN_A, missing))).toBe("not_found");
    s.h.fake.reply(text("hi"));
    const out = await s.h.engine.runTurn(
      { provider: "anthropic", model: MODEL_ENTRY.id, effort: "medium", text: "hi" },
      s.h.frontend,
      new AbortController().signal,
    );
    const conv = out.kind === "ended" ? out.convId : "";
    await s.msg(CONN_A, "conv.compact", {}, { conv });
    await done(s);
    expect(states(s, CONN_A)).toEqual(["started", "skipped"]);
  });
});

describe("status and models.result: period, estimate, prices, the table", () => {
  test("status: month and an estimate by default; a bill figure alone is not an estimate", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    const provider = () =>
      (s.hub.to(CONN_A, "status").at(-1)?.p as WireStatus | undefined)?.providers.find(
        (p) => p.name === "anthropic",
      );
    expect(provider()).toMatchObject({ period: "month", estimated: true });
    adjust(s.db, "anthropic", 12.5, undefined, s.h.clock.now());
    await s.msg(CONN_A, "status.get", {});
    expect(provider()).toMatchObject({ spentUsd: 12.5, estimated: false });
  });

  test("status: which models' prices need confirming, and how many candidates wait", async () => {
    const s = await setup();
    writeCatalog(s.h.paths, [
      { ...MODEL_ENTRY, pricedAt: "2026-10-10" },
      { ...MODEL_ENTRY, id: "fresh", default: false },
      { ...MODEL_ENTRY, id: "seen", default: false, status: "candidate" },
    ]);
    await s.ready(CONN_A);
    const p = s.hub.to(CONN_A, "status").at(-1)?.p as WireStatus;
    expect(p.prices).toEqual([
      { provider: "anthropic", model: MODEL_ENTRY.id, ageDays: 40, state: "stale" },
    ]);
    expect([p.candidates, p.retired, p.pricesWarn]).toEqual([1, 0, true]);
  });

  test("models.result: the whole list as a read-only table, without asking a provider", async () => {
    const s = await setup();
    await s.ready(CONN_A);
    const requests = s.h.fake.messages().length;
    const before = readFileSync(s.h.paths.modelsFile, "utf8");
    await s.msg(CONN_A, "models.get", {});
    const p = s.hub.to(CONN_A, "models.result").at(-1)?.p as {
      catalog: { id: string; status: string; price?: object }[];
      catalogTotal: number;
      updatedAt: string;
    };
    expect(p.catalogTotal).toBe(p.catalog.length);
    expect(p.catalog[0]).toMatchObject({
      id: MODEL_ENTRY.id,
      status: "active",
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      pricedAt: "2026-11-19",
    });
    expect(p.updatedAt).toBe("2026-11-19");
    expect(s.h.fake.messages()).toHaveLength(requests);
    expect(readFileSync(s.h.paths.modelsFile, "utf8")).toBe(before);
    allValid(s);
  });
});

describe("conv.archive: putting a conversation away from a page", () => {
  async function archivable() {
    const s = await setup();
    await s.ready(CONN_A);
    await s.ready(CONN_B);
    s.h.fake.reply(text("好"), text("好"));
    const turn = async (convId?: string) => {
      const out = await s.h.engine.runTurn(
        {
          provider: "anthropic",
          model: "model-a",
          effort: "medium",
          text: "q",
          ...(convId === undefined ? {} : { convId }),
        },
        s.h.frontend,
        new AbortController().signal,
      );
      if (out.kind !== "ended") throw new Error("turn did not end");
      return out.convId;
    };
    const conv = await turn();
    const other = await turn();
    return { s, conv, other };
  }
  const listed = (s: Setup, conn: string) =>
    (s.hub.to(conn, "conv.list.result").at(-1) as { p: { convs: { id: string }[] } }).p.convs.map(
      (c) => c.id,
    );

  test("status says the local end takes it", async () => {
    const { s } = await archivable();
    const id = await s.msg(CONN_A, "status.get", {});
    expect((reply(s, CONN_A, id) as { p: WireStatus }).p.archive).toBe(true);
  });

  test("archived: acked, every device gets the new list, the one with it open is told, the data stays", async () => {
    const { s, conv, other } = await archivable();
    await s.msg(CONN_B, "conv.open", {}, { conv });
    const id = await s.msg(CONN_A, "conv.archive", { archived: true }, { conv });
    expect(reply(s, CONN_A, id)?.kind).toBe("ack");
    expect(listed(s, CONN_A)).toEqual([other]);
    expect(listed(s, CONN_B)).toEqual([other]);
    const notice = s.hub.to(CONN_B, "notice").at(-1);
    expect(notice?.p).toEqual({ code: "conv_archived", data: { conv } });
    expect(notice?.conv).toBe(conv);
    expect(store.getConversation(s.db, conv).archivedAt).toBeNumber();
    expect(store.readItems(s.db, conv).length).toBeGreaterThan(0);
    const list = await s.msg(CONN_A, "conv.list", {});
    expect(
      (reply(s, CONN_A, list)!.p as { convs: { id: string }[] }).convs.map((c) => c.id),
    ).toEqual([other]);
    allValid(s);
  });

  test("an archived conversation is not opened, continued, compacted or continued from", async () => {
    const { s, conv } = await archivable();
    await s.msg(CONN_A, "conv.archive", { archived: true }, { conv });
    for (const [kind, p, extra] of [
      ["conv.open", {}, { conv }],
      ["turn.submit", { requestId: "r-1", text: "再說" }, { conv }],
      ["conv.compact", {}, { conv }],
      [
        "turn.submit",
        {
          requestId: "r-2",
          text: "接續",
          model: { provider: "anthropic", id: "model-a" },
          from: conv,
        },
        {},
      ],
    ] as const) {
      const id = await s.msg(CONN_B, kind, p, extra);
      expect(reason(reply(s, CONN_B, id))).toBe("conv_archived");
    }
    expect(s.d.current).toBeUndefined();
    allValid(s);
  });

  test("a turn or an approval of the conversation, or a turn the local end has accepted, refuses it", async () => {
    const { s, conv, other } = await archivable();
    seedTurn(s.db, { convId: conv });
    const id = await s.msg(CONN_A, "conv.archive", { archived: true }, { conv });
    expect(reason(reply(s, CONN_A, id))).toBe("conv_active");
    expect(store.getConversation(s.db, conv).archivedAt).toBeUndefined();

    // A turn accepted a moment ago has no row yet: the one the local end holds counts.
    s.h.fake.reply(text("慢"));
    const gate = Promise.withResolvers<void>();
    const hold = spyOn(s.hub.notifier, "idle").mockImplementation(() => gate.promise);
    await s.msg(CONN_A, "turn.submit", { requestId: "r-slow", text: "x" }, { conv: other });
    const again = await s.msg(CONN_B, "conv.archive", { archived: true }, { conv: other });
    expect(reason(reply(s, CONN_B, again))).toBe("conv_active");
    gate.resolve();
    hold.mockRestore();
    await s.d.running;
  });

  test("taking it back: only what this connection archived last, within a minute", async () => {
    const { s, conv, other } = await archivable();
    await s.msg(CONN_A, "conv.archive", { archived: true }, { conv });
    // Another connection, another conversation, nothing archived by this one yet.
    const b = await s.msg(CONN_B, "conv.archive", { archived: false }, { conv });
    expect(reason(reply(s, CONN_B, b))).toBe("not_allowed");
    const o = await s.msg(CONN_A, "conv.archive", { archived: false }, { conv: other });
    expect(reason(reply(s, CONN_A, o))).toBe("not_allowed");
    expect(store.getConversation(s.db, conv).archivedAt).toBeNumber();

    const ok = await s.msg(CONN_A, "conv.archive", { archived: false }, { conv });
    expect(reply(s, CONN_A, ok)?.kind).toBe("ack");
    expect(store.getConversation(s.db, conv).archivedAt).toBeUndefined();
    expect(listed(s, CONN_B).toSorted()).toEqual([conv, other].toSorted());
    // Once taken back it cannot be taken back again.
    const twice = await s.msg(CONN_A, "conv.archive", { archived: false }, { conv });
    expect(reason(reply(s, CONN_A, twice))).toBe("not_allowed");
    allValid(s);
  });

  test("after a minute, or on another connection, it can only be taken back in the terminal", async () => {
    const { s, conv } = await archivable();
    await s.msg(CONN_A, "conv.archive", { archived: true }, { conv });
    s.timers.advance(61_000);
    const id = await s.msg(CONN_A, "conv.archive", { archived: false }, { conv });
    expect(reason(reply(s, CONN_A, id))).toBe("not_allowed");
    expect(store.getConversation(s.db, conv).archivedAt).toBeNumber();
    // A reconnect is a new connection: it never archived this one.
    s.hub.registry.remove(CONN_A);
    await s.ready(CONN_A);
    const again = await s.msg(CONN_A, "conv.archive", { archived: false }, { conv });
    expect(reason(reply(s, CONN_A, again))).toBe("not_allowed");
  });

  test("an unknown conversation is not_found; an expired login is auth_expired; archiving twice keeps one time", async () => {
    const { s, conv } = await archivable();
    const nf = await s.msg(CONN_A, "conv.archive", { archived: true }, { conv: "nope" });
    expect(reason(reply(s, CONN_A, nf))).toBe("not_found");
    await s.msg(CONN_A, "conv.archive", { archived: true }, { conv });
    const at = store.getConversation(s.db, conv).archivedAt;
    s.timers.advance(5);
    const dup = await s.msg(CONN_B, "conv.archive", { archived: true }, { conv });
    expect(reply(s, CONN_B, dup)?.kind).toBe("ack");
    expect(store.getConversation(s.db, conv).archivedAt).toBe(at);
  });
});

describe("ui.submit: a form shown by ui_show, sent from a page", () => {
  const values = {
    date: "2026-11-23",
    amount: "190",
    target: "Expenses:Food:Dinner",
    source: "Assets:Cash:Wallet",
    narration: "晚餐",
    payee: "",
  };
  const TEMPLATE = [
    "〔表單送出〕記帳",
    "日期：2026-11-23",
    "金額：190",
    "借方帳戶：Expenses:Food:Dinner",
    "貸方帳戶：Assets:Cash:Wallet",
    "摘要：晚餐",
    "付款對象：（空）",
  ].join("\n");
  /** Every approval row, to show a form never reads or writes one. */
  const approvalRows = (s: Setup) => s.db.query("SELECT * FROM approvals ORDER BY id").all();

  /** A conversation whose model showed the sample form: its id and the call's. */
  async function shown(input: unknown = sample) {
    const s = await setup();
    await s.ready(CONN_A);
    s.h.fake.reply(toolUse("tu1", "ui_show", input), text("請填表"));
    await s.msg(CONN_A, "turn.submit", { requestId: "r-1", text: "記帳" });
    await until(() => ended(s, CONN_A));
    await s.d.running;
    const conv = store.findTurnByRequest(s.db, "r-1")!.convId;
    const call = store.readItems(s.db, conv).find((i) => i.kind === "tool_call");
    if (call?.kind !== "tool_call") throw new Error("no ui_show call");
    return { s, conv, callId: call.body.callId };
  }
  const submit = (s: Setup, conv: string, p: Record<string, unknown>) =>
    s.msg(CONN_A, "ui.submit", p, { conv });

  test("taken: the template as the owner's message, marked with the call, and a turn on it", async () => {
    const { s, conv, callId } = await shown();
    const result = store.readItems(s.db, conv).find((i) => i.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.body.status).toBe("done");
    const before = approvalRows(s);
    s.h.fake.reply(text("先預覽"));
    const id = await submit(s, conv, { requestId: "r-2", callId, context: values });
    expect(reply(s, CONN_A, id)?.kind).toBe("ack");
    await until(() => s.d.current === undefined);
    await s.d.running;
    const user = store
      .readItems(s.db, conv)
      .findLast((i) => i.kind === "user" && i.turnId === store.findTurnByRequest(s.db, "r-2")?.id);
    expect(user?.body).toEqual({ text: TEMPLATE, uiCall: callId });
    const wired = s.hub
      .to(CONN_A, "item")
      .map((m) => (m.p as { item: { kind: string; uiCall?: string; text?: string } }).item)
      .findLast((i) => i.kind === "user");
    expect(wired).toMatchObject({ text: TEMPLATE, uiCall: callId });
    expect(JSON.stringify(s.h.fake.messages().at(-1))).toContain(
      JSON.stringify(TEMPLATE).slice(1, -1),
    );
    expect(approvalRows(s)).toEqual(before);
    allValid(s);
  });

  test("the same requestId again is acked with its turn and not run again; other values are refused", async () => {
    const { s, conv, callId } = await shown();
    s.h.fake.reply(text("先預覽"));
    await submit(s, conv, { requestId: "r-2", callId, context: values });
    await until(() => s.d.current === undefined);
    await s.d.running;
    const asked = s.h.fake.messages().length;
    const turnId = store.findTurnByRequest(s.db, "r-2")?.id;
    const again = await submit(s, conv, { requestId: "r-2", callId, context: values });
    expect(reply(s, CONN_A, again)).toMatchObject({ kind: "ack", p: { turn: turnId } });
    const other = await submit(s, conv, {
      requestId: "r-2",
      callId,
      context: { ...values, amount: "200" },
    });
    expect(reason(reply(s, CONN_A, other))).toBe("bad_message");
    expect(s.h.fake.messages()).toHaveLength(asked);
  });

  test("a form is taken once: another send of it is already_decided", async () => {
    const { s, conv, callId } = await shown();
    s.h.fake.reply(text("先預覽"));
    await submit(s, conv, { requestId: "r-2", callId, context: values });
    await until(() => s.d.current === undefined);
    await s.d.running;
    const id = await submit(s, conv, { requestId: "r-3", callId, context: values });
    expect(reason(reply(s, CONN_A, id))).toBe("already_decided");
    expect(store.findTurnByRequest(s.db, "r-3")).toBeUndefined();
  });

  test("two pages send the same form at once: one turn, the other busy, then already_decided", async () => {
    const { s, conv, callId } = await shown();
    await s.ready(CONN_B);
    s.h.fake.reply(text("先預覽"));
    // uiSubmit runs from its checks to setting current with no await in between, so the second
    // finds the first's turn running (busy) and never reaches the engine; once that turn wrote
    // its message, a resend finds it (already_decided). The engine's own check covers the rest.
    const [a, b] = await Promise.all([
      submit(s, conv, { requestId: "r-a", callId, context: values }),
      s.msg(CONN_B, "ui.submit", { requestId: "r-b", callId, context: values }, { conv }),
    ]);
    const answers = [
      reply(s, CONN_A, a)?.kind,
      reason(reply(s, CONN_B, b)) ?? reply(s, CONN_B, b)?.kind,
    ];
    expect(answers).toEqual(["ack", "busy"]);
    await until(() => s.d.current === undefined);
    await s.d.running;
    const again = await s.msg(
      CONN_B,
      "ui.submit",
      { requestId: "r-b", callId, context: values },
      { conv },
    );
    expect(reason(reply(s, CONN_B, again))).toBe("already_decided");
    const sent = store
      .readItems(s.db, conv)
      .filter((i) => i.kind === "user" && i.body.uiCall === callId);
    expect(sent).toHaveLength(1);
  });

  test("the engine checks it again where it writes the message: a second take fails, nothing written", async () => {
    const { s, conv, callId } = await shown();
    s.h.fake.reply(text("先預覽"));
    await submit(s, conv, { requestId: "r-2", callId, context: values });
    await until(() => s.d.current === undefined);
    await s.d.running;
    const items = store.readItems(s.db, conv).length;
    const run = s.h.engine.runTurn(
      {
        convId: conv,
        provider: "anthropic",
        model: "model-a",
        effort: "medium",
        text: TEMPLATE,
        uiCall: callId,
      },
      s.h.frontend,
      new AbortController().signal,
    );
    expect(run).rejects.toThrow("already sent");
    await run.catch(() => undefined);
    expect(store.readItems(s.db, conv)).toHaveLength(items);
  });

  test("not_found: no such conversation, no such call, or a ui_show that failed", async () => {
    const { s, conv, callId } = await shown();
    const nowhere = await s.msg(
      CONN_A,
      "ui.submit",
      { requestId: "r-2", callId, context: values },
      { conv: "22222222-2222-4222-8222-222222222222" },
    );
    expect(reason(reply(s, CONN_A, nowhere))).toBe("not_found");
    const other = await submit(s, conv, { requestId: "r-3", callId: "call-0", context: values });
    expect(reason(reply(s, CONN_A, other))).toBe("not_found");
    const twoButtons = {
      ...sample,
      components: [...sample.components, { ...sample.components.at(-2), id: "b2" }],
    };
    const failed = await shown(twoButtons);
    const result = store.readItems(failed.s.db, failed.conv).find((i) => i.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.body.status).toBe("failed");
    const id = await submit(failed.s, failed.conv, {
      requestId: "r-4",
      callId: failed.callId,
      context: values,
    });
    expect(reason(reply(failed.s, CONN_A, id))).toBe("not_found");
  });

  test("bad_message: an account the stored form does not offer, the same account twice, a bad amount", async () => {
    const { s, conv, callId } = await shown();
    for (const change of [
      { target: ["Expenses:Unlisted"] },
      { source: "Expenses:Food:Dinner", target: "Expenses:Food:Dinner" },
      { amount: "0" },
    ]) {
      const id = await submit(s, conv, {
        requestId: "r-9",
        callId,
        context: { ...values, ...change },
      });
      expect(reason(reply(s, CONN_A, id))).toBe("bad_message");
    }
    expect(store.findTurnByRequest(s.db, "r-9")).toBeUndefined();
    expect(s.d.current).toBeUndefined();
  });

  test("an archived conversation's form is refused: conv_archived", async () => {
    const { s, conv, callId } = await shown();
    await s.msg(CONN_A, "conv.archive", { archived: true }, { conv });
    const id = await submit(s, conv, { requestId: "r-2", callId, context: values });
    expect(reason(reply(s, CONN_A, id))).toBe("conv_archived");
  });

  test("busy while another turn runs; an expired login is dropped", async () => {
    const { s, conv, callId } = await shown();
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
    s.h.fake.reply(
      tarsCall("tu2", ["script", "run", "push", "--", "--city", "Taipei"]),
      text("好"),
    );
    await s.msg(CONN_A, "turn.submit", { requestId: "r-2", text: "推播" });
    await until(() => s.hub.to(CONN_A, "approval.request").length === 1);
    const id = await submit(s, conv, { requestId: "r-3", callId, context: values });
    expect(reason(reply(s, CONN_A, id))).toBe("busy");
    await s.msg(CONN_A, "turn.abort", {}, { conv: s.d.current!.frontend.convId });
    await until(() => s.d.current === undefined);
    await s.d.running;
    await s.open(CONN_B, "short");
    await s.msg(CONN_B, "hello", {});
    s.timers.advance(1000);
    // Gone from the registry: dropped, and no turn.
    await s.msg(CONN_B, "ui.submit", { requestId: "r-4", callId, context: values }, { conv });
    expect(s.frames.at(-1)).toEqual({ t: "drop", conn: CONN_B, code: DROP.auth });
    expect(store.findTurnByRequest(s.db, "r-4")).toBeUndefined();
  });
});
