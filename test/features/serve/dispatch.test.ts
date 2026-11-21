import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseServer,
  PROTOCOL_VERSION,
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
import { engineHarness, type EngineHarness } from "../agent/engine-fixture.ts";
import { installSample, sampleScript } from "../script/sample.ts";
import {
  CONN_A,
  CONN_B,
  manualTimers,
  recordedLog,
  testHub,
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
  db: Database;
  reconciled: string[];
  /** Sends a client message from `conn`. */
  msg(conn: string, kind: string, p: unknown, extra?: Record<string, unknown>): Promise<string>;
  open(conn: string, jwt?: string): Promise<void>;
  /** open + hello. */
  ready(conn: string): Promise<void>;
}

let ids = 0;
async function setup(): Promise<Setup> {
  const h = await engineHarness({ selfCommand: [fakeTars('echo "ran $*"')] });
  harnesses.push(h);
  const timers = manualTimers(h.clock.now().getTime());
  const log = recordedLog();
  const hub = testHub({ timers, log });
  const frames: FrameToRelay[] = [];
  const reconciled: string[] = [];
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
        return verdicts[jwt] ?? { ok: false, reason: "denied" };
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
  });
  const s: Setup = {
    h,
    hub,
    d,
    frames,
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

  test("a failing handler is logged, not thrown", async () => {
    const s = await setup();
    await s.open(CONN_A, "throw");
    expect(s.hub.registry.size).toBe(0);
  });

  test("a message right behind its open waits for the check, not refused", async () => {
    const s = await setup();
    const open = s.open(CONN_A);
    const hi = s.msg(CONN_A, "hello", {});
    await Promise.all([open, hi]);
    expect(s.hub.to(CONN_A).map((m) => m.kind)).toEqual(["hello", "status"]);
    expect(s.frames).toEqual([]);
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
  async function withItems(n: number, size: number) {
    const s = await setup();
    s.h.fake.reply(...Array.from({ length: n }, (_, i) => text(`${i}:${"字".repeat(size)}`)));
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
