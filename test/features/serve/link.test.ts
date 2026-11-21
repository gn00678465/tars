import { describe, expect, test } from "bun:test";
import type { FrameToLocal } from "@tars/protocol";
import { Link, type LinkInit, type LinkSocket } from "../../../src/features/serve/link.ts";
import { manualTimers, recordedLog } from "./fixture.ts";

class FakeSocket implements LinkSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: number | undefined;
  private handlers = new Map<string, ((e: never) => void)[]>();
  constructor(
    readonly url: string,
    readonly init: LinkInit,
  ) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
  }
  addEventListener(type: string, fn: (e: never) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: "open" | "error"): void;
  fire(type: "message", e: { data: unknown }): void;
  fire(type: "close", e: { code: number; reason: string }): void;
  fire(type: string, e: unknown = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn(e as never);
  }
}

function link(opts: { tls?: boolean } = {}) {
  const timers = manualTimers();
  const sockets: FakeSocket[] = [];
  const frames: FrameToLocal[] = [];
  const events: string[] = [];
  const log = recordedLog();
  const l = new Link({
    url: "wss://<LINK_HOST>/link",
    ...(opts.tls === false ? {} : { tls: { cert: "CERT", key: "KEY" } }),
    version: "0.0.1",
    connect: (url, init) => {
      const s = new FakeSocket(url, init);
      sockets.push(s);
      return s;
    },
    timers,
    now: timers.now,
    random: () => 0,
    log,
    onFrame: (f) => void frames.push(f),
    onReset: () => void events.push("reset"),
    onConnected: () => void events.push("connected"),
    onReplaced: (since) => void events.push(`replaced ${since}`),
    onState: () => undefined,
  });
  return { l, timers, sockets, frames, events, log, last: () => sockets.at(-1)! };
}

describe("Link", () => {
  test("connects with the User-Agent and the certificate; resets on connect", () => {
    const { l, last, events } = link();
    l.start();
    expect(last().init).toEqual({
      headers: { "User-Agent": "tars-serve/0.0.1" },
      tls: { cert: "CERT", key: "KEY" },
    });
    expect(l.state).toBe("connecting");
    last().fire("open");
    expect(l.state).toBe("connected");
    expect(events).toEqual(["reset", "connected"]);
  });

  test("a ws:// link in e2e carries no certificate", () => {
    const { l, last } = link({ tls: false });
    l.start();
    expect(last().init.tls).toBeUndefined();
  });

  test("probe gets probe.ok; other frames go on; malformed ones are dropped", () => {
    const { l, last, frames } = link();
    l.start();
    last().fire("open");
    last().fire("message", { data: JSON.stringify({ t: "probe" }) });
    expect(last().sent).toEqual([JSON.stringify({ t: "probe.ok" })]);
    const open = { t: "close", conn: "11111111-1111-4111-8111-111111111111" };
    last().fire("message", { data: JSON.stringify(open) });
    last().fire("message", { data: "{not json" });
    last().fire("message", { data: JSON.stringify({ t: "nope" }) });
    expect(frames).toEqual([open as FrameToLocal]);
  });

  test("backoff 1, 2, 4, 8, 15, 15 s; a connect resets it", () => {
    const { l, last, sockets, timers } = link();
    l.start();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = sockets.length;
      last().fire("close", { code: 1006, reason: "" });
      let waited = 0;
      while (sockets.length === before) {
        timers.advance(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    last().fire("open");
    const before = sockets.length;
    last().fire("close", { code: 1006, reason: "" });
    timers.advance(1000);
    expect(sockets.length).toBe(before + 1);
  });

  test("ping every 30 s; no pong in 10 s closes and reconnects", () => {
    const { l, last, sockets, timers } = link();
    l.start();
    last().fire("open");
    const first = last();
    timers.advance(30_000);
    expect(first.sent).toEqual(["ping"]);
    first.fire("message", { data: "pong" });
    timers.advance(30_000);
    expect(first.sent).toEqual(["ping", "ping"]);
    timers.advance(10_000);
    expect(first.closedWith).toBe(4000);
    expect(l.lastError).toBe("心跳沒有回應");
    expect(l.state).toBe("connecting");
    timers.advance(1000);
    expect(sockets.length).toBe(2);
  });

  test("4002: replaced, retried every 5 min, since kept across retries", () => {
    const { l, last, sockets, timers, events } = link();
    l.start();
    last().fire("open");
    const t0 = timers.now();
    last().fire("close", { code: 4002, reason: "replaced" });
    expect(l.state).toBe("replaced");
    expect(l.replacedSince).toBe(t0);
    timers.advance(5 * 60_000 - 1);
    expect(sockets.length).toBe(1);
    timers.advance(1);
    expect(sockets.length).toBe(2);
    expect(l.state).toBe("replaced");
    last().fire("close", { code: 4002, reason: "replaced" });
    expect(events.filter((e) => e.startsWith("replaced"))).toEqual([
      `replaced ${t0}`,
      `replaced ${t0}`,
    ]);
    timers.advance(5 * 60_000);
    last().fire("open");
    expect(l.state).toBe("connected");
    expect(l.replacedSince).toBeUndefined();
  });

  test("a late close from an old socket does not touch the new connection", () => {
    const { l, last, timers } = link();
    l.start();
    const old = last();
    old.fire("close", { code: 1006, reason: "" });
    timers.advance(1000);
    last().fire("open");
    old.fire("close", { code: 4002, reason: "replaced" });
    old.fire("message", { data: JSON.stringify({ t: "probe" }) });
    expect(l.state).toBe("connected");
    expect(last().sent).toEqual([]);
  });

  test("send only while connected; stop closes and does not reconnect", () => {
    const { l, last, sockets, timers } = link();
    l.start();
    l.send({ t: "probe.ok" });
    expect(last().sent).toEqual([]);
    last().fire("open");
    l.stop();
    expect(last().closedWith).toBe(1000);
    last().fire("close", { code: 1000, reason: "" });
    timers.advance(60_000);
    expect(sockets.length).toBe(1);
  });
});
