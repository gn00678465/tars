// @vitest-environment node
import type { ServerMessage, WireApproval } from "@tars/protocol";
import { describe, expect, test } from "vite-plus/test";
import { composerBlocked, initial, localNow, reduce, type Event, type State } from "./state.ts";
import { server } from "./testing.ts";

const CONV = "conv-1";
const TURN = "turn-1";

const run = (events: (Event | ServerMessage)[], from: State = initial) =>
  events.reduce<State>(
    (s, e) => reduce(s, "type" in e ? e : { type: "message", m: e, at: 1000 }),
    from,
  );

const approval: WireApproval = {
  approvalId: "approval-00000001",
  conv: CONV,
  hash: "a".repeat(64),
  action: "run_script",
  script: "push",
  version: "v1",
  summary: "推播",
  effects: "external-write",
  domains: ["api.example.com"],
  secret: null,
  argv: ["--text", "hi"],
  expiresAt: 600_000,
};

const item = (seq: number, kind = "user", extra: Record<string, unknown> = {}) =>
  ({ seq, turn: TURN, kind, text: `t${seq}`, truncated: false, ...extra }) as never;

const open: (Event | ServerMessage)[] = [
  { type: "connection", connection: "open" },
  server("hello", { epoch: "e1", tars: "0.0.1" }),
  server("relay.status", { online: true, lastSeenAt: 1, localSince: 100 }),
  { type: "open_conv", conv: CONV },
];

describe("state: a conversation", () => {
  test("snapshot, then items and deltas for it; another conversation's are ignored", () => {
    const s = run([
      ...open,
      server(
        "conv.snapshot",
        { epoch: "e1", items: [item(1), item(2)], more: true },
        { conv: CONV },
      ),
      server("turn", { turn: TURN, state: "started" }, { conv: CONV }),
      server("delta", { turn: TURN, text: "你" }, { conv: CONV }),
      server("delta", { turn: TURN, text: "好" }, { conv: CONV }),
      server("item", { item: item(9) }, { conv: "conv-other" }),
    ]);
    expect(s.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(s.more).toBe(true);
    expect(s.running).toEqual({ turn: TURN, text: "你好" });
    expect(s.turn?.state).toBe("started");
    const done = run(
      [
        server("item", { item: item(3, "assistant", { state: "complete" }) }, { conv: CONV }),
        server("item", { item: item(3, "assistant", { state: "complete" }) }, { conv: CONV }),
        server("turn", { turn: TURN, state: "completed", costUsd: 0.1 }, { conv: CONV }),
      ],
      s,
    );
    expect(done.items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(done.running).toBeUndefined();
    expect(done.turn?.state).toBe("completed");
  });

  test.each(["failed", "aborted", "rejected"] as const)(
    "turn %s clears the running text",
    (state) => {
      const s = run([
        ...open,
        server("delta", { turn: TURN, text: "x" }, { conv: CONV }),
        server("turn", { turn: TURN, state, reason: "why" }, { conv: CONV }),
      ]);
      expect(s.running).toBeUndefined();
      expect(s.turn).toEqual({ state, turn: TURN, reason: "why" });
    },
  );

  test("a snapshot with the running text; an older page goes in front", () => {
    const s = run([
      ...open,
      server(
        "conv.snapshot",
        {
          epoch: "e1",
          items: [item(5), item(6)],
          more: true,
          running: { turn: TURN, text: "到這", truncated: false },
        },
        { conv: CONV },
      ),
      server(
        "conv.snapshot",
        { epoch: "e1", items: [item(3), item(4)], more: false },
        { conv: CONV },
      ),
    ]);
    expect(s.items.map((i) => i.seq)).toEqual([3, 4, 5, 6]);
    expect(s.more).toBe(false);
    expect(s.running?.text).toBe("到這");
  });

  test("a carried item is kept as a marker", () => {
    const s = run([
      ...open,
      server(
        "item",
        { item: { seq: 1, turn: TURN, kind: "carried", from: "conv-earlier" } },
        { conv: CONV },
      ),
    ]);
    expect(s.items).toEqual([{ seq: 1, turn: TURN, kind: "carried", from: "conv-earlier" }]);
  });

  test("a new conversation is followed once our turn starts; a rejected one says why", () => {
    const s = run([
      ...open,
      { type: "open_conv", conv: undefined },
      { type: "submitted", requestId: "r1" },
    ]);
    expect(composerBlocked(s)).toBe("送出中");
    const started = run(
      [server("turn", { turn: TURN, requestId: "r1", state: "started" }, { conv: "conv-new" })],
      s,
    );
    expect(started.conv).toBe("conv-new");
    expect(started.submitting).toBeUndefined();
    const refused = run(
      [server("turn", { requestId: "r1", state: "rejected", reason: "budget_stopped" })],
      s,
    );
    expect(refused.conv).toBeUndefined();
    expect(refused.error).toContain("budget_stopped");
  });

  test("another epoch: everything held is dropped", () => {
    const s = run([
      ...open,
      server("conv.list.result", {
        convs: [{ id: CONV, title: "t", provider: "anthropic", model: "m", updatedAt: 1 }],
      }),
      server("conv.snapshot", { epoch: "e1", items: [item(1)], more: false }, { conv: CONV }),
      server("approval.request", { approval }),
      server("hello", { epoch: "e2", tars: "0.0.1" }),
    ]);
    expect(s.epoch).toBe("e2");
    expect(s.items).toEqual([]);
    expect(s.convs).toEqual([]);
    expect(s.cards).toEqual([]);
    expect(s.conv).toBeUndefined();
    expect(s.relay.online).toBe(true);
  });
});

describe("state: approvals", () => {
  test("a request makes a card; resolved after our acked decision says it was here", () => {
    const s = run([
      ...open,
      server("approval.request", { approval }),
      { type: "deciding", approvalId: approval.approvalId, id: "d1" },
    ]);
    expect(s.cards[0]?.deciding).toBe("d1");
    const acked = run(
      [
        server("ack", {}, { re: "d1" }),
        server("approval.resolved", {
          approvalId: approval.approvalId,
          state: "approved",
          via: "remote",
        }),
      ],
      s,
    );
    expect(acked.cards[0]?.resolved).toEqual({ state: "approved", here: true });
  });

  test("decided elsewhere: resolved without our ack, or our decision nacked", () => {
    const elsewhere = run([
      ...open,
      server("approval.request", { approval }),
      server("approval.resolved", {
        approvalId: approval.approvalId,
        state: "denied",
        via: "remote",
      }),
    ]);
    expect(elsewhere.cards[0]?.resolved).toEqual({ state: "denied", here: false });
    const late = run([
      ...open,
      server("approval.request", { approval }),
      { type: "deciding", approvalId: approval.approvalId, id: "d1" },
      server("nack", { reason: "already_decided" }, { re: "d1" }),
    ]);
    expect(late.cards[0]?.error).toBe("已在別處決定");
    expect(late.cards[0]?.deciding).toBeUndefined();
  });

  test("a request that arrives after connecting makes a card all the same", () => {
    const s = run([
      ...open,
      server("status", {
        now: 1,
        providers: [],
        pricesWarn: false,
        pendingApprovals: 1,
        turnRunning: true,
        notify: "ok",
      }),
      server("approval.request", { approval }),
    ]);
    expect(s.cards).toHaveLength(1);
    expect(composerBlocked(s)).toBe("回合進行中");
  });

  test("the local end's clock counts on from status.now", () => {
    const s = reduce(initial, {
      type: "message",
      at: 5_000,
      m: server("status", {
        now: 100_000,
        providers: [],
        pricesWarn: false,
        pendingApprovals: 0,
        turnRunning: false,
        notify: "ok",
      }),
    });
    expect(localNow(s, 8_000)).toBe(103_000);
    expect(localNow(initial, 8_000)).toBeUndefined();
  });
});

describe("state: the relay and the local end", () => {
  test("offline from relay.status blocks the composer", () => {
    const s = run([...open, server("relay.status", { online: false, lastSeenAt: 50 })]);
    expect(s.relay).toEqual({ online: false, lastSeenAt: 50 });
    expect(composerBlocked(s)).toBe("本機端離線");
  });

  test("localSince: none the first time; a change warns, and the warning stays", () => {
    const first = run(open);
    expect(first.localSince).toBe(100);
    expect(first.reconnectedAt).toBeUndefined();
    const changed = run(
      [
        server("relay.status", { online: false }),
        server("relay.status", { online: true, localSince: 200 }),
      ],
      first,
    );
    expect(changed.reconnectedAt).toBe(200);
    const later = run(
      [
        server("relay.status", { online: true, localSince: 200 }),
        server("hello", { epoch: "e1", tars: "0.0.1" }),
      ],
      changed,
    );
    expect(later.reconnectedAt).toBe(200);
  });

  test("auth_expired anywhere ends the session's sending", () => {
    const s = run([...open, server("nack", { reason: "auth_expired" }, { re: "x" })]);
    expect(s.connection).toBe("auth_expired");
    expect(composerBlocked(s)).toBe("登入已過期，請重新整理");
  });
});
