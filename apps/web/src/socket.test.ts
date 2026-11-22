// @vitest-environment node
import { PROTOCOL_VERSION } from "@tars/protocol";
import { describe, expect, test } from "vite-plus/test";
import { socketHarness, type Harness } from "./testing.ts";

const states = (h: Harness) =>
  h.events.flatMap((e) => (e.type === "connection" ? [e.connection] : []));

async function opened() {
  const h = socketHarness();
  h.socket.start();
  h.last().ready();
  return h;
}

describe("Socket: hello and close codes", () => {
  test("hello on open; open only after the local end's hello", async () => {
    const h = socketHarness();
    h.socket.start();
    expect(states(h)).toEqual(["connecting"]);
    h.last().onopen?.();
    expect(h.last().messages()).toMatchObject([{ kind: "hello", p: {} }]);
    expect(h.socket.send("conv.list")).toBeUndefined();
    h.last().ready();
    expect(states(h)).toEqual(["connecting", "open"]);
    expect(h.socket.send("conv.list")).toBeDefined();
  });

  test("4000: reconnects at once", async () => {
    const h = await opened();
    h.last().end(4000);
    await h.advance(0);
    expect(h.sockets).toHaveLength(2);
  });

  test("4003: login expired, no reconnect", async () => {
    const h = await opened();
    h.last().end(4003);
    await h.advance(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(states(h).at(-1)).toBe("auth_expired");
  });

  test("4004: its own words, and a reconnect after 30 s", async () => {
    const h = await opened();
    h.last().end(4004);
    expect(states(h).at(-1)).toBe("keys_unavailable");
    await h.advance(29_999);
    expect(h.sockets).toHaveLength(1);
    await h.advance(1);
    expect(h.sockets).toHaveLength(2);
  });

  test("backoff 1, 2, 4, 8, 15, 15 s, reset by a hello", async () => {
    const h = socketHarness();
    h.socket.start();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = h.sockets.length;
      h.last().end(4001);
      let waited = 0;
      while (h.sockets.length === before) {
        await h.advance(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    h.last().ready();
    h.last().end(4001);
    await h.advance(1000);
    expect(h.sockets).toHaveLength(8);
  });
});

describe("Socket: which reconnect, and a version the local end does not speak", () => {
  const tries = (h: Harness) =>
    h.events.flatMap((e) =>
      e.type === "connection" ? [`${e.connection}${e.attempt ? `#${e.attempt}` : ""}`] : [],
    );

  test("each reconnect says which try it is; a hello starts counting again", async () => {
    const h = await opened();
    h.last().end(4001);
    await h.advance(1000);
    h.last().end(4001);
    await h.advance(2000);
    expect(tries(h)).toEqual([
      "connecting",
      "open",
      "offline#1",
      "connecting#1",
      "offline#2",
      "connecting#2",
    ]);
    h.last().ready();
    h.last().end(4001);
    expect(tries(h).slice(-2)).toEqual(["open", "offline#1"]);
  });

  test.each([
    ["local", "local"],
    ["client", "client"],
    [undefined, "client"],
  ] as const)(
    "hello refused as another version (need %s): says which side, no reconnect",
    async (need, said) => {
      const h = socketHarness();
      h.socket.start();
      h.last().onopen?.();
      const hello = h.last().messages()[0];
      h.last().receive({
        v: PROTOCOL_VERSION,
        id: "s-1",
        kind: "nack",
        re: hello?.id,
        p: { reason: "version", ...(need === undefined ? {} : { need }) },
      });
      const last = h.events.at(-1);
      expect(last).toEqual({ type: "connection", connection: "version", need: said });
      // Within the heartbeat (the fake socket answers no ping): nothing reconnects by itself.
      await h.advance(20_000);
      expect(h.sockets).toHaveLength(1);
      expect(h.socket.send("conv.list")).toBeUndefined();
    },
  );
});

describe("Socket: telling an expired login from a dead network", () => {
  async function dropped(answer: Harness["answer"]) {
    const h = await opened();
    h.answer = answer;
    h.last().end(1006);
    await h.advance(1000);
    // The first reconnect fails too: now it asks.
    h.last().end(1006);
    await h.advance(0);
    return h;
  }

  test.each([
    ["an intercepted redirect", { type: "opaqueredirect", status: 0 }],
    ["401", { type: "basic", status: 401 }],
    ["403", { type: "basic", status: 403 }],
  ])("%s: login expired, no more reconnects", async (_, res) => {
    const h = await dropped(async () => res);
    expect(h.fetches).toEqual(["/"]);
    expect(states(h).at(-1)).toBe("auth_expired");
    await h.advance(120_000);
    expect(h.sockets).toHaveLength(2);
  });

  test.each([
    ["200", async () => ({ type: "basic", status: 200 })],
    ["a failed request", () => Promise.reject(new TypeError("offline"))],
  ])("%s: keeps reconnecting", async (_, answer) => {
    const h = await dropped(answer);
    expect(h.fetches).toEqual(["/"]);
    expect(states(h).at(-1)).toBe("offline");
    await h.advance(15_000);
    expect(h.sockets.length).toBeGreaterThan(2);
  });

  test("asks again every 4 failed reconnects: a network back after the login ran out is found", async () => {
    const h = await dropped(() => Promise.reject(new TypeError("offline")));
    expect(h.fetches).toEqual(["/"]);
    // The network is back, but Access now turns the page away.
    h.answer = async () => ({ type: "opaqueredirect", status: 0 });
    for (let i = 0; i < 3; i++) {
      await h.advance(15_000);
      h.last().end(1006);
      await h.advance(0);
    }
    expect(h.fetches).toEqual(["/"]);
    await h.advance(15_000);
    h.last().end(1006);
    await h.advance(0);
    expect(h.fetches).toEqual(["/", "/"]);
    expect(states(h).at(-1)).toBe("auth_expired");
  });

  test("a 4xxx close does not ask", async () => {
    const h = await opened();
    h.last().end(4001);
    await h.advance(1000);
    h.last().end(1006);
    await h.advance(0);
    expect(h.fetches).toEqual([]);
  });
});

describe("Socket: heartbeat and resend", () => {
  test("ping every 30 s; no pong in 10 s closes and reconnects", async () => {
    const h = await opened();
    const first = h.last();
    await h.advance(30_000);
    expect(first.sent.filter((s) => s === "ping")).toHaveLength(1);
    first.receive("pong");
    await h.advance(30_000);
    expect(first.sent.filter((s) => s === "ping")).toHaveLength(2);
    await h.advance(10_000);
    expect(first.closedWith).toBeDefined();
    await h.advance(1000);
    expect(h.sockets).toHaveLength(2);
  });

  test("turn.submit is resent with the same requestId every 10 s until acked", async () => {
    const h = await opened();
    const requestId = h.socket.submit("你好", "conv-1");
    await h.advance(10_000);
    const subs = h
      .last()
      .messages()
      .filter((m) => m.kind === "turn.submit");
    expect(subs).toHaveLength(2);
    expect(subs.map((m) => m.p.requestId)).toEqual([requestId, requestId]);
    expect(subs[0]?.conv).toBe("conv-1");
    expect(subs[0]?.id).not.toBe(subs[1]?.id);
    // An ack to the first send counts; one that names the turn ends the resend.
    h.last().receive({
      v: PROTOCOL_VERSION,
      id: "s-a",
      kind: "ack",
      re: subs[0]?.id,
      p: { turn: "t-1" },
    });
    await h.advance(30_000);
    expect(
      h
        .last()
        .messages()
        .filter((m) => m.kind === "turn.submit"),
    ).toHaveLength(2);
    expect(h.events.find((e) => e.type === "submit_result")).toMatchObject({ requestId, ok: true });
  });

  test("a continuation is resent as itself: the model, the conversation it continues, keepLast", async () => {
    const h = await opened();
    const start = { model: { provider: "gemini", id: "g" }, from: "conv-1", keepLast: 3 };
    h.socket.submit("繼續", undefined, start);
    await h.advance(10_000);
    const subs = h
      .last()
      .messages()
      .filter((m) => m.kind === "turn.submit");
    expect(subs).toHaveLength(2);
    for (const m of subs) {
      expect(m.p).toMatchObject(start);
      expect(m.conv).toBeUndefined();
    }
  });

  test("a plain ack is only held in the local end's memory: resent until the turn is known", async () => {
    const h = await opened();
    const requestId = h.socket.submit("你好");
    const subs = () =>
      h
        .last()
        .messages()
        .filter((m) => m.kind === "turn.submit");
    h.last().receive({ v: PROTOCOL_VERSION, id: "s-a", kind: "ack", re: subs()[0]?.id, p: {} });
    expect(h.events.filter((e) => e.type === "submit_result")).toEqual([
      { type: "submit_result", requestId, ok: true },
    ]);
    // tars serve restarted before the turn existed: the resend is what reaches the new one.
    await h.advance(10_000);
    expect(subs().map((m) => m.p.requestId)).toEqual([requestId, requestId]);
    h.last().receive({
      v: PROTOCOL_VERSION,
      id: "s-t",
      kind: "turn",
      conv: "conv-1",
      p: { turn: "t-1", requestId, state: "started" },
    });
    await h.advance(30_000);
    expect(subs()).toHaveLength(2);
  });

  test("the relay's offline nack is about one resend: the request is kept and resent", async () => {
    const h = await opened();
    const requestId = h.socket.submit("你好");
    const subs = () =>
      h
        .last()
        .messages()
        .filter((m) => m.kind === "turn.submit");
    h.last().receive({ v: PROTOCOL_VERSION, id: "s-a", kind: "ack", re: subs()[0]?.id, p: {} });
    await h.advance(10_000);
    // The local end went stale after its ack: the relay answers the resend itself.
    h.last().receive({
      v: PROTOCOL_VERSION,
      id: "s-o",
      kind: "nack",
      re: subs()[1]?.id,
      p: { reason: "offline" },
    });
    expect(h.events.filter((e) => e.type === "submit_result")).toEqual([
      { type: "submit_result", requestId, ok: true },
    ]);
    await h.advance(10_000);
    expect(subs().map((m) => m.p.requestId)).toEqual([requestId, requestId, requestId]);
  });

  test("a submit made offline goes after the next hello; a nack ends it", async () => {
    const h = await opened();
    h.last().end(4000);
    const requestId = h.socket.submit("離線時打的");
    await h.advance(0);
    h.last().ready();
    const sub = h
      .last()
      .messages()
      .find((m) => m.kind === "turn.submit");
    expect(sub?.p).toEqual({ requestId, text: "離線時打的" });
    h.last().receive({
      v: PROTOCOL_VERSION,
      id: "s-n",
      kind: "nack",
      re: sub?.id,
      p: { reason: "busy" },
    });
    expect(h.events.find((e) => e.type === "submit_result")).toMatchObject({
      requestId,
      ok: false,
      reason: "busy",
    });
  });

  test("malformed messages are dropped; a stale socket's events are ignored", async () => {
    const h = await opened();
    const old = h.last();
    h.last().receive("{not json");
    const count = h.events.length;
    old.end(4000);
    await h.advance(0);
    old.receive({ v: PROTOCOL_VERSION, id: "x", kind: "status.get", p: {} });
    old.end(4003);
    expect(h.events.length).toBe(count + 1);
    expect(states(h).at(-1)).toBe("connecting");
  });
});
