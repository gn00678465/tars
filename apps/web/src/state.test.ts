// @vitest-environment node
import type { ServerMessage, WireApproval } from "@tars/protocol";
import { describe, expect, test } from "vite-plus/test";
import {
  composerBlocked,
  initial,
  localNow,
  reduce,
  runBusy,
  sendBusy,
  type Event,
  type State,
} from "./state.ts";
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
  test("D1: turn.phase sets the running turn's phase; a snapshot mid-turn starts it in its phase", () => {
    const s = run([
      ...open,
      server("turn", { turn: TURN, state: "started" }, { conv: CONV }),
      server("turn.phase", { turn: TURN, phase: "running_script" }, { conv: CONV }),
    ]);
    expect(s.turn).toEqual({ state: "started", turn: TURN, phase: "running_script" });
    // Another turn's, another conversation's, and one after the end change nothing.
    expect(
      run([server("turn.phase", { turn: "turn-2", phase: "thinking" }, { conv: CONV })], s).turn
        ?.phase,
    ).toBe("running_script");
    expect(
      run([server("turn.phase", { turn: TURN, phase: "thinking" }, { conv: "conv-2" })], s).turn
        ?.phase,
    ).toBe("running_script");
    const ended = run(
      [
        server("turn", { turn: TURN, state: "completed" }, { conv: CONV }),
        server("turn.phase", { turn: TURN, phase: "replying" }, { conv: CONV }),
      ],
      s,
    );
    expect(ended.turn).toEqual({ state: "completed", turn: TURN });
    const opened = run([
      ...open,
      server(
        "conv.snapshot",
        {
          epoch: "e1",
          items: [item(1)],
          more: false,
          running: { turn: TURN, text: "半", phase: "waiting_approval" },
        },
        { conv: CONV },
      ),
    ]);
    expect(opened.turn).toEqual({ state: "started", turn: TURN, phase: "waiting_approval" });
  });

  test("C1: a failed turn keeps the local end's figures", () => {
    const s = run([
      ...open,
      server(
        "turn",
        { turn: TURN, state: "failed", reason: "daily_cap", data: { dailyCapUsd: 10 } },
        { conv: CONV },
      ),
    ]);
    expect(s.turn?.data).toEqual({ dailyCapUsd: 10 });
  });

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
    expect([composerBlocked(s), sendBusy(s)]).toEqual([undefined, "送出中"]);
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
    expect(refused.error).toBe("沒有開始：本期花費已到停用門檻");
  });

  test("an ack that names the turn finishes the submit; a plain ack does not", () => {
    const s = run([
      ...open,
      { type: "open_conv", conv: undefined },
      { type: "submitted", requestId: "r1" },
    ]);
    const plain = run([{ type: "submit_result", requestId: "r1", ok: true }], s);
    expect(sendBusy(plain)).toBe("送出中");
    // The turn's started message was missed: the resend's ack is all the page hears.
    const known = run(
      [{ type: "submit_result", requestId: "r1", ok: true, turn: TURN, conv: "conv-new" }],
      plain,
    );
    expect(known.submitting).toBeUndefined();
    expect(known.conv).toBe("conv-new");
    expect(known.load).toBe("conv-new");
    // In a conversation already open, it stays there and loads nothing.
    const inConv = run(
      [
        { type: "submitted", requestId: "r2" },
        { type: "submit_result", requestId: "r2", ok: true, turn: TURN, conv: "conv-other" },
      ],
      run(open),
    );
    expect(inConv.submitting).toBeUndefined();
    expect(inConv.conv).toBe(CONV);
    expect(inConv.load).toBeUndefined();
  });

  test("an ack that names the turn in the conversation open now loads its snapshot again", () => {
    const s = run([{ type: "submitted", requestId: "r3" }], run(open));
    const known = run(
      [{ type: "submit_result", requestId: "r3", ok: true, turn: TURN, conv: CONV }],
      s,
    );
    expect(known.submitting).toBeUndefined();
    expect(known.conv).toBe(CONV);
    expect(known.load).toBe(CONV);
  });

  test("a failure that names a turn whose start was missed loads its conversation", () => {
    const fresh = run([...open.slice(0, 3), { type: "submitted", requestId: "r4" }]);
    const failed = run(
      [server("turn", { turn: TURN, requestId: "r4", state: "failed" }, { conv: CONV })],
      fresh,
    );
    expect(failed.submitting).toBeUndefined();
    expect(failed.conv).toBe(CONV);
    expect(failed.load).toBe(CONV);
    // Without a turn there is nothing to load.
    const none = run(
      [server("turn", { requestId: "r4", state: "failed" }, { conv: CONV })],
      run([{ type: "submitted", requestId: "r4" }], run(open)),
    );
    expect(none.load).toBeUndefined();
  });

  test("a decision that could not be sent: no deciding, an error on the card", () => {
    const s = run(
      [
        server("approval.request", { approval }),
        { type: "deciding", approvalId: approval.approvalId, id: "m1" },
        { type: "decide_failed", approvalId: approval.approvalId },
      ],
      run(open),
    );
    expect(s.cards[0]?.deciding).toBeUndefined();
    expect(s.cards[0]?.error).toBe("連線中斷，決定沒有送出");
  });

  const req = (n: number) =>
    server("approval.request", {
      approval: { ...approval, approvalId: `approval-0000000${n}` },
    });
  const res = (n: number, state = "approved") =>
    server("approval.resolved", { approvalId: `approval-0000000${n}`, state, via: "remote" });

  test("decided cards carry the order they were decided in, not the order they came", () => {
    const s = run([req(1), req(2), req(3), req(4), res(2), res(3), res(4), res(1)], run(open));
    const order = Object.fromEntries(s.cards.map((c) => [c.approval.approvalId, c.decidedOrder]));
    expect(order).toEqual({
      "approval-00000001": 4,
      "approval-00000002": 1,
      "approval-00000003": 2,
      "approval-00000004": 3,
    });
  });

  test("acked but not resolved: still no second decision; the result replaces it", () => {
    const acked = run(
      [req(1), { type: "deciding", approvalId: "approval-00000001", id: "m1" }],
      run(open),
    );
    const s = run([server("ack", {}, { re: "m1" })], acked);
    expect(s.cards[0]?.acked).toBe(true);
    expect(s.cards[0]?.resolved).toBeUndefined();
    expect(run([res(1)], s).cards[0]?.resolved?.state).toBe("approved");
  });

  test("back after a drop: an unacked decision is freed with a note; an acked one keeps waiting", () => {
    const sent = run(
      [
        req(1),
        req(2),
        { type: "deciding", approvalId: "approval-00000001", id: "m1" },
        { type: "deciding", approvalId: "approval-00000002", id: "m2" },
        server("ack", {}, { re: "m2" }),
        { type: "connection", connection: "offline" },
      ],
      run(open),
    );
    const back = run([{ type: "connection", connection: "open" }, req(1), req(2)], sent);
    expect(back.cards[0]?.deciding).toBeUndefined();
    expect(back.cards[0]?.error).toBe("連線曾中斷，決定可能沒有送達；可以再按一次");
    // Sent again after hello: what the page knows stays, the acked one keeps waiting.
    expect(back.cards[0]?.error).toBe("連線曾中斷，決定可能沒有送達；可以再按一次");
    expect(back.cards[1]?.acked).toBe(true);
    const waiting = run([{ type: "connection", connection: "open" }], sent);
    expect(waiting.cards[1]?.acked).toBe(true);
    expect(waiting.cards[1]?.error).toBeUndefined();
  });

  test("a resend of a decided card is ignored; of an acked one keeps it waiting, with the new fields", () => {
    const decided = run([req(1), req(2), res(2), res(1)], run(open));
    const again = run([req(1)], decided);
    expect(again.cards[0]?.resolved?.state).toBe("approved");
    expect(again.cards[0]?.decidedOrder).toBe(2);
    const acked = run(
      [
        req(3),
        { type: "deciding", approvalId: "approval-00000003", id: "m3", choice: "approved" },
        server("ack", {}, { re: "m3" }),
      ],
      run(open),
    );
    const later = run(
      [
        server("approval.request", {
          approval: { ...approval, approvalId: "approval-00000003", expiresAt: 999 },
        }),
      ],
      acked,
    );
    expect(later.cards[0]?.acked).toBe(true);
    expect(later.cards[0]?.approval.expiresAt).toBe(999);
  });

  test("lost to a drop: the card remembers what was chosen; the ack keeps its time", () => {
    const sent = run(
      [req(1), { type: "deciding", approvalId: "approval-00000001", id: "m1", choice: "approved" }],
      run(open),
    );
    const back = run(
      [
        { type: "connection", connection: "offline" },
        { type: "connection", connection: "open" },
      ],
      sent,
    );
    expect(back.cards[0]).toMatchObject({ lost: true, choice: "approved" });
    const acked = run([server("ack", {}, { re: "m1" })], sent);
    expect(acked.cards[0]?.ackedAt).toBe(1000);
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
    expect(late.cards[0]?.error).toBe("本機端已收到先前的決定，結果以本機為準；請重新整理確認");
    expect(late.cards[0]?.deciding).toBeUndefined();
  });

  test("B1, B2: the local end says when and which device; a late decision shows what won", () => {
    const mine = run([
      ...open,
      server("approval.request", { approval }),
      { type: "deciding", approvalId: approval.approvalId, id: "d1", choice: "approved" },
      server("ack", {}, { re: "d1" }),
      server("approval.resolved", {
        approvalId: approval.approvalId,
        state: "approved",
        via: "remote",
        at: 5_000,
        source: "this",
      }),
    ]);
    expect(mine.cards[0]?.resolved).toEqual({
      state: "approved",
      here: true,
      at: 5_000,
      source: "this",
    });
    // Our ack came, but the local end says another device decided: it is believed.
    const other = run([
      ...open,
      server("approval.request", { approval }),
      { type: "deciding", approvalId: approval.approvalId, id: "d1" },
      server("ack", {}, { re: "d1" }),
      server("approval.resolved", {
        approvalId: approval.approvalId,
        state: "denied",
        via: "remote",
        at: 5_000,
        source: "other_device",
      }),
    ]);
    expect(other.cards[0]?.resolved?.here).toBe(false);
    const late = run([
      ...open,
      server("approval.request", { approval }),
      { type: "deciding", approvalId: approval.approvalId, id: "d1", choice: "approved" },
      server(
        "nack",
        { reason: "already_decided", state: "denied", source: "other_device" },
        { re: "d1" },
      ),
    ]);
    expect(late.cards[0]?.resolved).toEqual({
      state: "denied",
      here: false,
      source: "other_device",
    });
    expect(late.cards[0]?.error).toBeUndefined();
    expect(late.cards[0]?.choice).toBeUndefined();
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
    expect([composerBlocked(s), sendBusy(s)]).toEqual([undefined, "回合進行中"]);
  });

  test("the reconnect try and a version mismatch are kept until the connection opens", () => {
    const down = run([{ type: "connection", connection: "offline", attempt: 3 }]);
    expect(down.reconnect).toBe(3);
    const version = run([{ type: "connection", connection: "version", need: "local" }], down);
    expect([version.reconnect, version.need, composerBlocked(version)]).toEqual([
      undefined,
      "local",
      "協定不合，請更新本機 tars",
    ]);
    const back = run([{ type: "connection", connection: "open" }], version);
    expect([back.reconnect, back.need]).toEqual([undefined, undefined]);
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
    expect(composerBlocked(s)).toBe("本機端離線，暫時無法送出訊息。");
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
    expect(composerBlocked(s)).toBe("登入已過期，請重新登入後再試。");
  });
});

test("往返延遲 belongs to its connection: a drop clears it, and a stale answer does not time", () => {
  const status = server(
    "status",
    {
      now: 1,
      providers: [],
      pricesWarn: false,
      pendingApprovals: 0,
      turnRunning: false,
      notify: "ok",
    },
    { re: "c-9" },
  );
  const timed = run([
    { type: "connection", connection: "open" },
    { type: "pinged", id: "c-9", at: 900 },
    { type: "message", m: status, at: 1150 },
  ]);
  expect(timed.rtt).toBe(250);
  expect(timed.ping).toBeUndefined();
  const dropped = run(
    [
      { type: "pinged", id: "c-10", at: 1200 },
      { type: "connection", connection: "offline" },
      { type: "connection", connection: "open" },
      { type: "message", m: { ...status, re: "c-10" }, at: 9000 },
    ],
    timed,
  );
  expect(dropped.rtt).toBeUndefined();
});

test("the model list belongs to the local end that sent it: a drop forgets it", () => {
  const listed = run([
    { type: "connection", connection: "open" },
    server("models.result", {
      models: [{ provider: "anthropic", id: "m", label: "M", window: 1000, isDefault: true }],
    }),
  ]);
  expect(listed.models).toHaveLength(1);
  // The page may come back to an older local end, which refuses a turn.submit naming a model.
  expect(run([{ type: "connection", connection: "offline" }], listed).models).toBeUndefined();
});

describe("state: compaction (E)", () => {
  const ctx = {
    contextUsed: 1_000,
    contextLimit: 10_000,
    warnRatio: 0.6,
    compactRatio: 0.75,
    stopRatio: 0.85,
    autoCompact: true,
  };

  test("the owner's: sent, acked, started, then each end; a nack is a failure that ran nothing", () => {
    const sent = run([...open, { type: "compact_sent", id: "c1" }]);
    expect(sent.compactReq).toBe("c1");
    expect(sendBusy(sent)).toBe("壓縮中");
    const started = run(
      [server("ack", {}, { re: "c1" }), server("compact", { state: "started" }, { conv: CONV })],
      sent,
    );
    expect([started.compactReq, started.compacting]).toEqual([undefined, true]);
    const failed = run(
      [
        server(
          "compact",
          { state: "failed", reason: "budget_stopped", data: { provider: "anthropic" } },
          { conv: CONV },
        ),
      ],
      started,
    );
    expect(failed.compacting).toBeUndefined();
    expect(failed.compactEnd).toEqual({
      state: "failed",
      reason: "budget_stopped",
      data: { provider: "anthropic" },
    });
    const done = run([server("compact", { state: "completed" }, { conv: CONV })], started);
    expect([done.compacting, done.compactEnd]).toEqual([undefined, undefined]);
    const busy = run([server("nack", { reason: "busy" }, { re: "c1" })], sent);
    expect([busy.compactReq, busy.compactEnd]).toEqual([
      undefined,
      { state: "failed", nack: "busy" },
    ]);
    expect(run([{ type: "compact_sent" }], run(open)).compactEnd).toEqual({
      state: "failed",
      nack: "offline",
    });
    // Another conversation's says nothing here.
    expect(
      run([server("compact", { state: "started" }, { conv: "conv-2" })], run(open)).compacting,
    ).toBeUndefined();
  });

  test("a turn's own: compact_start, then its summary item, a failure notice or the turn's start", () => {
    const start = run([...open, server("notice", { code: "compact_start" }, { conv: CONV })]);
    expect(start.compacting).toBe(true);
    const summary = run(
      [server("item", { item: item(9, "compaction", { text: "## Goal" }) }, { conv: CONV })],
      start,
    );
    expect(summary.compacting).toBeUndefined();
    expect(
      run([server("notice", { code: "compact_failed" }, { conv: CONV })], start).compacting,
    ).toBeUndefined();
    expect(
      run([server("turn", { turn: TURN, state: "started" }, { conv: CONV })], start).compacting,
    ).toBeUndefined();
  });

  test("a snapshot says whether one runs; opening another conversation forgets it all", () => {
    const s = run([
      ...open,
      server(
        "conv.snapshot",
        { epoch: "e1", items: [], more: false, compacting: true },
        { conv: CONV },
      ),
      server("conv.context", ctx, { conv: CONV }),
    ]);
    expect([s.compacting, s.context]).toEqual([true, ctx]);
    expect(
      run([server("conv.snapshot", { epoch: "e1", items: [], more: false }, { conv: CONV })], s)
        .compacting,
    ).toBeUndefined();
    const away = run([{ type: "open_conv", conv: "conv-2" }], s);
    expect([away.compacting, away.context]).toEqual([undefined, undefined]);
  });

  test("E5: auto compaction off, past the stop line (on the ratio itself) the send waits", () => {
    const at = (used: number, autoCompact = false) =>
      run([
        ...open,
        server("conv.context", { ...ctx, contextUsed: used, autoCompact }, { conv: CONV }),
      ]);
    // On, the local end compacts before the message goes: nothing waits.
    expect(sendBusy(at(9_000, true))).toBeUndefined();
    // 84.96% rounds to 85% but is under the line.
    expect(sendBusy(at(8_496))).toBeUndefined();
    expect(sendBusy(at(8_500))).toBe(
      "這個對話太長（85%），超過硬停門檻。請先執行 /compact，或開新對話接續",
    );
    expect(runBusy(at(8_500))).toBeUndefined();
  });
});

describe("state: the price table (F)", () => {
  test("models.result keeps the catalog; an older local end's has none; a drop forgets it", () => {
    const entry = {
      provider: "anthropic",
      id: "m",
      label: "M",
      status: "active" as const,
    };
    const s = run([
      ...open,
      server("models.result", {
        models: [],
        catalog: [entry],
        catalogTotal: 3,
        updatedAt: "2026-11-19",
      }),
    ]);
    expect(s.catalog).toEqual({ entries: [entry], total: 3, updatedAt: "2026-11-19" });
    expect(run([server("models.result", { models: [] })], s).catalog).toBeUndefined();
    expect(run([{ type: "connection", connection: "offline" }], s).catalog).toBeUndefined();
  });
});

describe("archive", () => {
  const conv = (id: string, title = id) => ({
    id,
    title,
    provider: "anthropic",
    model: "m",
    updatedAt: 1,
  });
  const listed = run([
    server("conv.list.result", { convs: [conv("conv-1"), conv("conv-2")] }),
    { type: "open_conv", conv: "conv-1" },
  ]);

  test("its ack takes the open conversation out of the list and the page, and brings the toast", () => {
    const s = run(
      [
        { type: "archive_sent", conv: "conv-1", undo: false, id: "a-1" },
        server("ack", {}, { re: "a-1" }),
      ],
      listed,
    );
    expect(s.conv).toBeUndefined();
    expect(s.convs.map((c) => c.id)).toEqual(["conv-2"]);
    expect(s.left).toBe(1);
    expect(s.archiveReq).toBeUndefined();
    expect(s.archiveNote).toMatchObject({ undo: true, conv: "conv-1" });
  });

  test("another conversation: the page stays where it is and does not start anew", () => {
    const s = run(
      [
        { type: "archive_sent", conv: "conv-2", undo: false, id: "a-1" },
        server("ack", {}, { re: "a-1" }),
      ],
      listed,
    );
    expect(s.conv).toBe("conv-1");
    expect(s.left).toBeUndefined();
    expect(s.convs.map((c) => c.id)).toEqual(["conv-1"]);
    expect(s.archiveNote?.undo).toBe(true);
  });

  test("the local end's notice before its ack does not lose the toast", () => {
    const s = run(
      [
        { type: "archive_sent", conv: "conv-1", undo: false, id: "a-1" },
        server("notice", { code: "conv_archived", data: { conv: "conv-1" } }, { conv: "conv-1" }),
        server("ack", {}, { re: "a-1" }),
      ],
      listed,
    );
    expect(s.conv).toBeUndefined();
    expect(s.left).toBe(1);
    expect(s.archiveNote).toMatchObject({ undo: true, conv: "conv-1" });
  });

  test("archived from another tab: the page leaves it and says it is archived, with no 復原", () => {
    const s = run(
      [server("notice", { code: "conv_archived", data: { conv: "conv-1" } }, { conv: "conv-1" })],
      listed,
    );
    expect(s.conv).toBeUndefined();
    expect(s.convs.map((c) => c.id)).toEqual(["conv-2"]);
    expect(s.archiveNote).toMatchObject({ undo: false });
    expect(s.archiveNote?.text).toContain("tars chat --unarchive");
  });

  test("a notice for a conversation the page is not on changes nothing", () => {
    const s = run(
      [server("notice", { code: "conv_archived", data: { conv: "conv-2" } }, { conv: "conv-2" })],
      listed,
    );
    expect(s).toEqual(listed);
  });

  test("a refusal says why in words, and the conversation stays", () => {
    const s = run(
      [
        { type: "archive_sent", conv: "conv-1", undo: false, id: "a-1" },
        server("nack", { reason: "conv_active" }, { re: "a-1" }),
      ],
      listed,
    );
    expect(s.conv).toBe("conv-1");
    expect(s.convs).toHaveLength(2);
    expect(s.archiveNote).toMatchObject({
      undo: false,
      text: "這個對話還有進行中的回合或待核准項目，不能封存",
    });
  });

  test("復原: the ack closes the toast; a refusal says it can only be done in the terminal", () => {
    const archived = run(
      [
        { type: "archive_sent", conv: "conv-1", undo: false, id: "a-1" },
        server("ack", {}, { re: "a-1" }),
      ],
      listed,
    );
    const back = run(
      [
        { type: "archive_sent", conv: "conv-1", undo: true, id: "a-2" },
        server("ack", {}, { re: "a-2" }),
      ],
      archived,
    );
    expect(back.archiveNote).toBeUndefined();
    const late = run(
      [
        { type: "archive_sent", conv: "conv-1", undo: true, id: "a-2" },
        server("nack", { reason: "not_allowed" }, { re: "a-2" }),
      ],
      archived,
    );
    expect(late.archiveNote?.undo).toBe(false);
    expect(late.archiveNote?.text).toContain("tars chat --unarchive");
  });

  test("a toast's timer closes only that toast", () => {
    const first = run(
      [
        { type: "archive_sent", conv: "conv-2", undo: false, id: "a-1" },
        server("ack", {}, { re: "a-1" }),
      ],
      listed,
    );
    const seq = first.archiveNote?.seq as number;
    const second = run(
      [
        { type: "archive_sent", conv: "conv-1", undo: false, id: "a-2" },
        server("ack", {}, { re: "a-2" }),
      ],
      first,
    );
    expect(reduce(second, { type: "archive_toast_done", seq }).archiveNote).toBeDefined();
    expect(
      reduce(second, { type: "archive_toast_done", seq: second.archiveNote?.seq as number })
        .archiveNote,
    ).toBeUndefined();
  });

  test("conv.open refused for an archived conversation: the page leaves it", () => {
    const s = run(
      [
        { type: "open_sent", conv: "conv-1", id: "o-1" },
        server("nack", { reason: "conv_archived" }, { re: "o-1" }),
      ],
      listed,
    );
    expect(s.conv).toBeUndefined();
    expect(s.convs.map((c) => c.id)).toEqual(["conv-2"]);
    expect(s.archiveNote?.text).toContain("已封存");
  });

  test("a message to an archived conversation: the refusal text names the terminal", () => {
    const s = run(
      [
        { type: "submitted", requestId: "r-1" },
        { type: "submit_result", requestId: "r-1", ok: false, reason: "conv_archived" },
      ],
      listed,
    );
    expect(s.error).toBe("這個對話已封存，不能繼續；要取回請在終端執行 tars chat --unarchive");
  });

  test("not sent at all: the toast says the page is offline", () => {
    const s = run([{ type: "archive_sent", conv: "conv-1", undo: false }], listed);
    expect(s.archiveNote?.text).toBe("本機端離線");
    expect(s.convs).toHaveLength(2);
  });
});
