// @vitest-environment node
import { describe, expect, test } from "vite-plus/test";
import {
  CLOSE,
  PROBE_MS,
  rebuild,
  route,
  STALE_MS,
  type RelayAction,
  type RelayEvent,
  type RelayState,
} from "./route.ts";

const T = 1_800_000_000_000;
const ID = "01a1fd71-be41-71e7-809a-4bb1e568ad68";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let n = 0;
const ids = () => `id-${++n}`;
const run = (state: RelayState, event: RelayEvent) => route(state, event, ids);
const EMPTY: RelayState = { browsers: [] };

const of = <T extends RelayAction["type"]>(actions: RelayAction[], type: T) =>
  actions.filter((a): a is Extract<RelayAction, { type: T }> => a.type === type);

/** A local end L1 that connected at T, with browsers A and B. */
function withLocal(): RelayState {
  let s = run(EMPTY, { type: "local.connect", sock: "L1", now: T }).state;
  s = run(s, { type: "browser.connect", conn: A, jwt: "j", now: T + 1 }).state;
  return run(s, { type: "browser.connect", conn: B, jwt: "j", now: T + 2 }).state;
}

const status = (actions: RelayAction[]) =>
  of(actions, "to.browser").map((a) => (a.message as { p: unknown }).p);

describe("route: the local end", () => {
  test("the first one becomes the local end, records localSince, and closes every browser", () => {
    let s = run(EMPTY, { type: "browser.connect", conn: A, jwt: "j", now: T }).state;
    const r = run(s, { type: "local.connect", sock: "L1", now: T + 5 });
    s = r.state;
    expect(s.local).toEqual({ sock: "L1", since: T + 5, lastBeatAt: T + 5, stale: false });
    expect(s.browsers).toEqual([]);
    expect(r.actions).toContainEqual({ type: "store", localSince: T + 5 });
    expect(r.actions).toContainEqual({ type: "tag", sock: "L1", role: "local", stale: false });
    expect(of(r.actions, "close.browser")).toEqual([
      { type: "close.browser", conn: A, code: CLOSE.relayReconnect },
    ]);
  });

  test("a second one is a challenger: the first gets a probe, the alarm is the deadline", () => {
    const r = run(withLocal(), { type: "local.connect", sock: "L2", now: T + 10 });
    expect(r.state.local?.sock).toBe("L1");
    expect(r.state.challenger).toEqual({ sock: "L2", deadline: T + 10 + PROBE_MS });
    expect(r.actions).toContainEqual({ type: "to.local", frame: { t: "probe" } });
    expect(r.actions).toContainEqual({ type: "tag", sock: "L2", role: "challenger", stale: false });
    expect(of(r.actions, "alarm")).toEqual([{ type: "alarm", at: T + 10 + PROBE_MS }]);
    expect(of(r.actions, "close.browser")).toEqual([]);
  });

  test("the first answers the probe: the later one is closed with 4002, nothing else changes", () => {
    let s = run(withLocal(), { type: "local.connect", sock: "L2", now: T + 10 }).state;
    const r = run(s, { type: "local.frame", sock: "L1", frame: { t: "probe.ok" } });
    s = r.state;
    expect(r.actions).toContainEqual({ type: "close.local", sock: "L2", code: CLOSE.replaced });
    expect(of(r.actions, "alarm")).toEqual([{ type: "alarm", at: null }]);
    expect(s.local?.sock).toBe("L1");
    expect(s.challenger).toBeUndefined();
    expect(s.browsers).toEqual([A, B]);
  });

  test("no answer by the deadline: the first is closed 4001, the later one takes over, browsers close", () => {
    let s = run(withLocal(), { type: "local.connect", sock: "L2", now: T + 10 }).state;
    const early = run(s, { type: "alarm", now: T + 10 + PROBE_MS - 1 });
    expect(early.state).toEqual(s);
    expect(of(early.actions, "alarm")).toEqual([{ type: "alarm", at: T + 10 + PROBE_MS }]);
    const at = T + 10 + PROBE_MS;
    const r = run(s, { type: "alarm", now: at });
    s = r.state;
    expect(r.actions).toContainEqual({ type: "close.local", sock: "L1", code: CLOSE.probeTimeout });
    expect(s.local).toEqual({ sock: "L2", since: at, lastBeatAt: at, stale: false });
    expect(r.actions).toContainEqual({ type: "store", localSince: at });
    expect(of(r.actions, "close.browser").map((a) => [a.conn, a.code])).toEqual([
      [A, CLOSE.relayReconnect],
      [B, CLOSE.relayReconnect],
    ]);
    expect(s.browsers).toEqual([]);
    expect(of(r.actions, "alarm")).toEqual([{ type: "alarm", at: null }]);
  });

  test("with no deadline waiting the alarm is null", () => {
    expect(of(run(withLocal(), { type: "alarm", now: T + 99 }).actions, "alarm")).toEqual([
      { type: "alarm", at: null },
    ]);
  });

  test("the local end going away: lastSeenAt is stored, browsers hear it is offline", () => {
    const r = run(withLocal(), { type: "local.close", sock: "L1", now: T + 50 });
    expect(r.state.local).toBeUndefined();
    expect(r.state.lastSeenAt).toBe(T + 50);
    expect(r.actions).toContainEqual({ type: "store", lastSeenAt: T + 50 });
    expect(r.actions).toContainEqual({ type: "broadcast.status" });
  });

  test("a challenger going away leaves the local end, and cancels the alarm", () => {
    const s = run(withLocal(), { type: "local.connect", sock: "L2", now: T + 10 }).state;
    const r = run(s, { type: "local.close", sock: "L2", now: T + 11 });
    expect(r.state.challenger).toBeUndefined();
    expect(r.state.local?.sock).toBe("L1");
    expect(r.actions).toEqual([{ type: "alarm", at: null }]);
  });

  test("the local end going away while a challenger waits: the challenger takes over at once", () => {
    const s = run(withLocal(), { type: "local.connect", sock: "L2", now: T + 10 }).state;
    const r = run(s, { type: "local.close", sock: "L1", now: T + 12 });
    expect(r.state.local).toEqual({ sock: "L2", since: T + 12, lastBeatAt: T + 12, stale: false });
    expect(r.state.challenger).toBeUndefined();
    expect(of(r.actions, "alarm")).toEqual([{ type: "alarm", at: null }]);
  });

  test("relay.status carries localSince, and a new local end gives a new value", () => {
    let s = withLocal();
    const first = run(s, { type: "browser.connect", conn: ID, jwt: "j", now: T + 3 });
    expect(status(first.actions)).toEqual([{ online: true, localSince: T }]);
    s = run(s, { type: "local.close", sock: "L1", now: T + 40 }).state;
    s = run(s, { type: "local.connect", sock: "L9", now: T + 60 }).state;
    const again = run(s, { type: "browser.connect", conn: ID, jwt: "j", now: T + 61 });
    expect(status(again.actions)).toEqual([
      { online: true, lastSeenAt: T + 40, localSince: T + 60 },
    ]);
  });
});

describe("route: browsers", () => {
  test("a browser connecting: open goes to the local end, relay.status to the browser", () => {
    const s = run(EMPTY, { type: "local.connect", sock: "L1", now: T }).state;
    const r = run(s, {
      type: "browser.connect",
      conn: A,
      jwt: "a.b.c",
      country: "TW",
      ua: "Mozilla/5.0",
      now: T + 1,
    });
    expect(r.actions).toEqual([
      {
        type: "to.local",
        frame: { t: "open", conn: A, jwt: "a.b.c", country: "TW", ua: "Mozilla/5.0" },
      },
      {
        type: "to.browser",
        conn: A,
        message: expect.objectContaining({
          v: 1,
          kind: "relay.status",
          p: { online: true, localSince: T },
        }),
      },
    ]);
  });

  test("without a local end: no open frame; relay.status says offline", () => {
    const r = run(EMPTY, { type: "browser.connect", conn: A, jwt: "j", now: T });
    expect(of(r.actions, "to.local")).toEqual([]);
    expect(status(r.actions)).toEqual([{ online: false }]);
  });

  test("a browser closing: close goes to the local end; an unknown one is ignored", () => {
    const r = run(withLocal(), { type: "browser.close", conn: A });
    expect(r.actions).toEqual([{ type: "to.local", frame: { t: "close", conn: A } }]);
    expect(r.state.browsers).toEqual([B]);
    expect(run(r.state, { type: "browser.close", conn: A }).actions).toEqual([]);
  });

  test("a browser's message goes to the local end wrapped in msg, as parsed JSON", () => {
    const m = { v: 1, id: ID, kind: "hello", p: {} };
    const r = run(withLocal(), {
      type: "browser.message",
      conn: A,
      raw: JSON.stringify(m),
      now: T + 3,
    });
    expect(r.actions).toEqual([{ type: "to.local", frame: { t: "msg", conn: A, m } }]);
  });

  test("not JSON, not an object, or over MESSAGE_BYTES: dropped", () => {
    for (const raw of ["{nope", "[1]", "3", `"${"x".repeat(262_145)}"`])
      expect(
        run(withLocal(), { type: "browser.message", conn: A, raw, now: T + 3 }).actions,
      ).toEqual([]);
  });

  test("with no local end a message gets nack offline, answering its id", () => {
    const s = run(EMPTY, { type: "browser.connect", conn: A, jwt: "j", now: T }).state;
    const r = run(s, {
      type: "browser.message",
      conn: A,
      raw: JSON.stringify({ v: 1, id: ID, kind: "hello", p: {} }),
      now: T + 1,
    });
    expect(r.actions).toEqual([
      {
        type: "to.browser",
        conn: A,
        message: expect.objectContaining({ kind: "nack", re: ID, p: { reason: "offline" } }),
      },
    ]);
  });

  test("a heartbeat over 90 s old: nack offline, the local end is stale, every browser hears it", () => {
    const now = T + STALE_MS + 1;
    const r = run(withLocal(), {
      type: "browser.message",
      conn: A,
      raw: JSON.stringify({ v: 1, id: ID, kind: "hello", p: {} }),
      now,
    });
    expect(r.state.local?.stale).toBe(true);
    expect(r.actions).toContainEqual({ type: "tag", sock: "L1", role: "local", stale: true });
    expect(r.actions).toContainEqual({ type: "broadcast.status" });
    expect(of(r.actions, "to.browser").map((a) => (a.message as { kind: string }).kind)).toEqual([
      "nack",
    ]);
    expect(of(r.actions, "to.local")).toEqual([]);
  });

  test("a stale local end sending any frame is online again, for every browser", () => {
    const s = run(withLocal(), {
      type: "browser.connect",
      conn: ID,
      jwt: "j",
      now: T + STALE_MS + 1,
    }).state;
    expect(s.local?.stale).toBe(true);
    const r = run(s, { type: "local.frame", sock: "L1", frame: { t: "probe.ok" } });
    expect(r.state.local?.stale).toBe(false);
    expect(r.actions).toContainEqual({ type: "broadcast.status" });
    expect(r.actions).toContainEqual({ type: "tag", sock: "L1", role: "local", stale: false });
  });

  test("a later browser event that finds a fresh heartbeat clears stale", () => {
    const stale: RelayState = {
      ...withLocal(),
      local: { sock: "L1", since: T, lastBeatAt: T, stale: true },
    };
    const fresh = { ...stale, local: { ...stale.local!, lastBeatAt: T + STALE_MS } };
    const r = run(fresh, { type: "browser.connect", conn: ID, jwt: "j", now: T + STALE_MS + 5 });
    expect(r.state.local?.stale).toBe(false);
    expect(r.actions).toContainEqual({ type: "broadcast.status" });
  });

  test("the local end's msg goes to that browser; to one that is not there, dropped", () => {
    const s = withLocal();
    const m = { v: 1, id: ID, kind: "ack", p: {} };
    expect(
      run(s, { type: "local.frame", sock: "L1", frame: { t: "msg", to: B, m } }).actions,
    ).toEqual([{ type: "to.browser", conn: B, message: m }]);
    expect(
      run(s, { type: "local.frame", sock: "L1", frame: { t: "msg", to: ID, m } }).actions,
    ).toEqual([]);
  });

  test("the local end's drop closes that browser with its code", () => {
    const r = run(withLocal(), {
      type: "local.frame",
      sock: "L1",
      frame: { t: "drop", conn: A, code: 4003 },
    });
    expect(r.actions).toEqual([{ type: "close.browser", conn: A, code: 4003 }]);
    expect(r.state.browsers).toEqual([B]);
  });

  test("frames from a challenger are ignored", () => {
    const s = run(withLocal(), { type: "local.connect", sock: "L2", now: T + 10 }).state;
    const m = { v: 1, id: ID, kind: "ack", p: {} };
    expect(run(s, { type: "local.frame", sock: "L2", frame: { t: "msg", to: A, m } })).toEqual({
      state: s,
      actions: [],
    });
    expect(
      run(s, { type: "local.frame", sock: "L2", frame: { t: "probe.ok" } }).state.challenger,
    ).toEqual(s.challenger);
  });
});

describe("rebuild", () => {
  test("the sockets' attachments and storage give back the same state", () => {
    const s = run(withLocal(), { type: "local.connect", sock: "L2", now: T + 10 }).state;
    const rebuilt = rebuild(
      [
        { attachment: { role: "local", conn: "L1", connectedAt: T }, autoResponseAt: T },
        { attachment: { role: "browser", conn: A, connectedAt: T + 1 }, autoResponseAt: null },
        { attachment: { role: "browser", conn: B, connectedAt: T + 2 }, autoResponseAt: null },
        {
          attachment: { role: "challenger", conn: "L2", connectedAt: T + 10 },
          autoResponseAt: null,
        },
      ],
      { localSince: T },
    );
    expect(rebuilt).toEqual(s);
  });

  test("a stale tag and lastSeenAt come back", () => {
    const rebuilt = rebuild(
      [
        {
          attachment: { role: "local", conn: "L1", connectedAt: T, stale: true },
          autoResponseAt: T + 7,
        },
      ],
      { lastSeenAt: T - 5, localSince: T },
    );
    expect(rebuilt).toEqual({
      browsers: [],
      lastSeenAt: T - 5,
      local: { sock: "L1", since: T, lastBeatAt: T + 7, stale: true },
    });
  });

  test("before the first heartbeat (null) connectedAt stands in: within 90 s not stale, after it stale", () => {
    const sockets = [
      { attachment: { role: "local", conn: "L1", connectedAt: T }, autoResponseAt: null },
      { attachment: { role: "browser", conn: A, connectedAt: T }, autoResponseAt: null },
    ] as const;
    const s = rebuild(sockets, { localSince: T });
    const msg = JSON.stringify({ v: 1, id: ID, kind: "hello", p: {} });
    const soon = run(s, { type: "browser.message", conn: A, raw: msg, now: T + 30_000 });
    expect(soon.state.local?.stale).toBe(false);
    expect(of(soon.actions, "to.local")).toHaveLength(1);
    const late = run(s, { type: "browser.message", conn: A, raw: msg, now: T + STALE_MS + 1 });
    expect(late.state.local?.stale).toBe(true);
  });
});
