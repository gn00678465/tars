import { describe, expect, test } from "bun:test";
import {
  DELTA_BYTES,
  MESSAGE_BYTES,
  parseServer,
  PROTOCOL_VERSION,
  type FrameToRelay,
  type ServerMessage,
} from "@tars/protocol";
import { Registry } from "../../../src/features/serve/access.ts";
import type { Item } from "../../../src/features/agent/types.ts";
import {
  broadcast,
  linkSend,
  RemoteFrontend,
  type Hub,
} from "../../../src/features/serve/remote-frontend.ts";
import {
  APPROVAL_ID,
  approvalRecord,
  CONN_A,
  CONN_B,
  manualTimers,
  ready,
  testHub,
} from "./fixture.ts";

const CONV = "01a1fd71-be41-71e7-809a-4bb1e56800cc";
const TURN = "01a1fd71-be41-71e7-809a-4bb1e56800dd";
const REQ = "req-1";

function setup() {
  const timers = manualTimers();
  const hub = testHub({ timers });
  ready(hub, CONN_A);
  ready(hub, CONN_B);
  const started: string[] = [];
  const fe = new RemoteFrontend(hub, CONN_A, REQ, (t) => void started.push(t));
  return { timers, hub, fe, started };
}

const start = (fe: RemoteFrontend) =>
  fe.emit({
    type: "turn_start",
    convId: CONV,
    turnId: TURN,
    items: [{ seq: 1, turnId: TURN, step: 0, kind: "user", body: { text: "你好" } } as never],
  });

/** Every message passes the protocol's own parser, as the page would read it. */
const valid = (m: ServerMessage) => parseServer(JSON.stringify(m)).ok;

describe("RemoteFrontend: a turn's stream", () => {
  test("turn_start: started to every ready connection; the origin follows the conversation and gets the user item", () => {
    const { hub, fe, started } = setup();
    start(fe);
    expect(started).toEqual([TURN]);
    for (const conn of [CONN_A, CONN_B])
      expect(hub.to(conn, "turn")[0]).toMatchObject({
        conv: CONV,
        p: { turn: TURN, requestId: REQ, state: "started" },
      });
    expect(hub.registry.get(CONN_A)!.subscribed).toBe(CONV);
    expect(hub.to(CONN_A, "item")[0]).toMatchObject({
      p: { item: { kind: "user", text: "你好" } },
    });
    expect(hub.to(CONN_B, "item")).toEqual([]);
    expect(hub.sent.every((s) => valid(s.m))).toBe(true);
  });

  test("deltas are merged for 80 ms, and flushed before an item", () => {
    const { hub, fe, timers } = setup();
    start(fe);
    fe.emit({ type: "delta", text: "一" });
    fe.emit({ type: "delta", text: "二" });
    expect(hub.to(CONN_A, "delta")).toEqual([]);
    timers.advance(80);
    expect(hub.to(CONN_A, "delta").map((m) => (m.p as { text: string }).text)).toEqual(["一二"]);
    fe.emit({ type: "delta", text: "三" });
    fe.emit({
      type: "item",
      item: {
        seq: 2,
        turnId: TURN,
        step: 1,
        kind: "assistant",
        body: { text: "一二三", state: "complete", native: null },
      } as Item,
    });
    const kinds = hub.to(CONN_A).map((m) => m.kind);
    expect(kinds.slice(-2)).toEqual(["delta", "item"]);
    expect(fe.running).toBe("");
    timers.advance(1000);
    expect(hub.to(CONN_A, "delta")).toHaveLength(2);
  });

  test("a burst over DELTA_BYTES goes at once, in pieces that each fit", () => {
    const { hub, fe } = setup();
    start(fe);
    fe.emit({ type: "delta", text: "中".repeat(DELTA_BYTES) });
    const pieces = hub.to(CONN_A, "delta").map((m) => (m.p as { text: string }).text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe("中".repeat(DELTA_BYTES));
    for (const p of pieces) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(DELTA_BYTES);
    expect(hub.sent.every((s) => valid(s.m))).toBe(true);
    expect(fe.running).toHaveLength(DELTA_BYTES);
  });

  test("items and notices go to subscribers only; a connection that opens the conversation starts getting them", () => {
    const { hub, fe } = setup();
    start(fe);
    fe.emit({
      type: "notice",
      code: "budget_warn",
      data: { provider: "anthropic", long: "x".repeat(400) },
    });
    expect(hub.to(CONN_B, "notice")).toEqual([]);
    const n = hub.to(CONN_A, "notice")[0]!;
    expect(valid(n)).toBe(true);
    hub.registry.get(CONN_B)!.subscribed = CONV;
    fe.emit({
      type: "item",
      item: {
        seq: 3,
        turnId: TURN,
        step: 1,
        kind: "error",
        body: { code: "provider_error", message: "secret" },
      } as Item,
    });
    expect(hub.to(CONN_B, "item")[0]).toMatchObject({
      p: { item: { kind: "error", code: "provider_error" } },
    });
  });

  test("turn_end: flushed, then the end to everyone, with a terminal state", () => {
    const { hub, fe } = setup();
    start(fe);
    fe.emit({ type: "delta", text: "尾" });
    fe.emit({
      type: "turn_end",
      state: "interrupted",
      reason: "x".repeat(100),
      costUsd: 0.5,
    } as never);
    expect(
      hub
        .to(CONN_A)
        .map((m) => m.kind)
        .slice(-2),
    ).toEqual(["delta", "turn"]);
    const end = hub.to(CONN_B, "turn").at(-1)!;
    expect(end.p).toMatchObject({ turn: TURN, requestId: REQ, state: "failed", costUsd: 0.5 });
    expect((end.p as { reason: string }).reason).toHaveLength(64);
    expect(valid(end)).toBe(true);
  });

  test("approval_resolved goes to every ready connection", () => {
    const { hub, fe } = setup();
    fe.emit({
      type: "approval_resolved",
      approvalId: APPROVAL_ID,
      state: "expired",
      via: "timeout",
    });
    for (const conn of [CONN_A, CONN_B])
      expect(hub.to(conn, "approval.resolved")[0]!.p).toEqual({
        approvalId: APPROVAL_ID,
        state: "expired",
        via: "timeout",
      });
  });
});

describe("RemoteFrontend: approvals", () => {
  const decide = (
    decision: "approved" | "denied",
    hash = "a".repeat(64),
    approvalId = APPROVAL_ID,
  ) => ({
    v: PROTOCOL_VERSION as 1,
    id: `d-${decision}-${hash.slice(0, 2)}`,
    kind: "approval.decide" as const,
    p: { approvalId, decision, hash },
  });

  test("the request goes to everyone; the first good decision is acked and wins", async () => {
    const { hub, fe } = setup();
    const ctl = new AbortController();
    const answer = fe.askApproval(approvalRecord(), ctl.signal);
    expect(fe.awaitingApproval).toBe(true);
    for (const conn of [CONN_A, CONN_B]) expect(hub.to(conn, "approval.request")).toHaveLength(1);
    // The page draws the card under this tool call.
    const [sent] = hub.to(CONN_A, "approval.request");
    expect((sent?.p as { approval?: { callId?: string } } | undefined)?.approval?.callId).toBe(
      "call-1",
    );
    const replies: ServerMessage[] = [];
    await fe.decide(CONN_B, decide("approved"), (m) => void replies.push(m));
    await fe.decide(CONN_A, decide("denied"), (m) => void replies.push(m));
    expect(await answer).toBe("approved");
    expect(replies.map((m) => [m.kind, m.re, (m.p as { reason?: string }).reason])).toEqual([
      ["ack", "d-approved-aa", undefined],
      ["nack", "d-denied-aa", "already_decided"],
    ]);
    expect(fe.awaitingApproval).toBe(false);
  });

  test("a wrong hash is refused and the approval keeps waiting", async () => {
    const { fe } = setup();
    const answer = fe.askApproval(approvalRecord(), new AbortController().signal);
    const replies: ServerMessage[] = [];
    await fe.decide(CONN_A, decide("approved", "b".repeat(64)), (m) => void replies.push(m));
    expect((replies[0]!.p as { reason: string }).reason).toBe("hash_mismatch");
    expect(fe.awaitingApproval).toBe(true);
    await fe.decide(CONN_A, decide("denied"), (m) => void replies.push(m));
    expect(await answer).toBe("denied");
  });

  test("an expired login is refused before anything else", async () => {
    const { hub, fe, timers } = setup();
    hub.registry.add({ conn: CONN_B, exp: timers.now() + 10 });
    hub.registry.get(CONN_B)!.hello = true;
    void fe.askApproval(approvalRecord(), new AbortController().signal);
    timers.advance(10);
    const replies: ServerMessage[] = [];
    await fe.decide(CONN_B, decide("approved"), (m) => void replies.push(m));
    expect((replies[0]!.p as { reason: string }).reason).toBe("auth_expired");
  });

  test("a decision for another approval, or none waiting, is already_decided", async () => {
    const { fe } = setup();
    const replies: ServerMessage[] = [];
    await fe.decide(CONN_A, decide("approved"), (m) => void replies.push(m));
    void fe.askApproval(approvalRecord(), new AbortController().signal);
    await fe.decide(
      CONN_A,
      decide("approved", "a".repeat(64), "other-approval"),
      (m) => void replies.push(m),
    );
    expect(replies.map((m) => (m.p as { reason: string }).reason)).toEqual([
      "already_decided",
      "already_decided",
    ]);
  });

  test("the abort signal cancels the wait", async () => {
    const { fe } = setup();
    const ctl = new AbortController();
    const answer = fe.askApproval(approvalRecord(), ctl.signal);
    ctl.abort();
    expect(await answer).toBe("cancelled");
  });

  test("approved waits for a running notification before resolving", async () => {
    const { hub, fe } = setup();
    let release!: () => void;
    const busy = new Promise<void>((r) => (release = r));
    (hub.notifier as unknown as { chain: Promise<void> }).chain = busy;
    let settled: string | undefined;
    void fe.askApproval(approvalRecord(), new AbortController().signal).then((d) => (settled = d));
    const done = fe.decide(CONN_A, decide("approved"), () => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeUndefined();
    release();
    await done;
    await Promise.resolve();
    expect(settled).toBe("approved");
  });
});

describe("linkSend: what leaves for a browser", () => {
  const T = 1_800_000_000_000;
  const m = (id: string): ServerMessage => ({
    v: PROTOCOL_VERSION,
    id,
    kind: "ack",
    p: {},
  });

  test("past exp but before the timer drops it: nothing goes out, alone or in a broadcast", () => {
    let now = T;
    // A busy event loop: the expiry timer has not run yet.
    const never = { setTimeout: () => 0, clearTimeout: () => undefined };
    const registry = new Registry(
      never,
      () => now,
      () => undefined,
    );
    registry.add({ conn: CONN_A, exp: T + 1000 });
    const reg = registry.get(CONN_A);
    if (reg !== undefined) reg.hello = true;
    const frames: FrameToRelay[] = [];
    const send = linkSend(registry, (f) => void frames.push(f));
    const hub = { registry, send, newId: () => "x" } as unknown as Hub;
    send(CONN_A, m("before"));
    expect(frames).toEqual([{ t: "msg", to: CONN_A, m: m("before") }]);
    now = T + 1000;
    send(CONN_A, m("after"));
    broadcast(hub, () => m("all"));
    expect(frames).toHaveLength(1);
    expect(registry.ready()).toEqual([]);
  });

  test("a message over MESSAGE_BYTES is not sent", () => {
    const never = { setTimeout: () => 0, clearTimeout: () => undefined };
    const registry = new Registry(
      never,
      () => T,
      () => undefined,
    );
    registry.add({ conn: CONN_A, exp: T + 1000 });
    const frames: FrameToRelay[] = [];
    const big = { ...m("big"), p: { text: "x".repeat(MESSAGE_BYTES) } } as unknown as ServerMessage;
    linkSend(registry, (f) => void frames.push(f))(CONN_A, big);
    expect(frames).toEqual([]);
  });
});
