import { parseServer, PROTOCOL_VERSION, type ClientKind, type NackReason } from "@tars/protocol";
import type { Connection, Event } from "./state.ts";

const BACKOFF_S = [1, 2, 4, 8, 15];
const PING_EVERY_MS = 30_000;
const PONG_WITHIN_MS = 10_000;
const RESEND_MS = 10_000;
const KEYS_RETRY_MS = 30_000;
/** Failed reconnects between same-origin requests, once asking: see closed(). */
const PROBE_EVERY = 4;

/** The part of a browser WebSocket the page uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
}

export interface SocketDeps {
  readonly url: string;
  open(url: string): WebSocketLike;
  /** The same-origin request that tells an expired login from a dead network. */
  fetch(
    url: string,
    init: RequestInit,
  ): Promise<{ readonly type: string; readonly status: number }>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  newId(): string;
  /** A monotonic clock, for counting on from status.now. */
  now(): number;
}

interface Submit {
  readonly requestId: string;
  readonly text: string;
  readonly conv: string | undefined;
  /** Every turn.submit sent for it: an ack to an earlier one counts as well. */
  readonly ids: Set<string>;
  acked?: boolean;
  timer?: unknown;
}

/**
 * The page's one connection: hello, reconnecting, the heartbeat, turn.submit's resend and the
 * close codes. Everything it learns goes out as reducer events.
 */
export class Socket {
  listener: (e: Event) => void = () => undefined;
  private ws: WebSocketLike | undefined;
  private open = false;
  private attempt = 0;
  private stopped = true;
  private retry: unknown;
  private ping: unknown;
  private pong: unknown;
  private helloId: string | undefined;
  /**
   * A connection that had opened closed without a 4xxx: failed connects since then ask why.
   * Undefined when not asking.
   */
  private failedSince: number | undefined;
  private submit_: Submit | undefined;

  constructor(private readonly d: SocketDeps) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.d.clearTimeout(this.retry);
    this.clearBeat();
    this.d.clearTimeout(this.submit_?.timer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
  }

  private state(connection: Connection): void {
    this.listener({ type: "connection", connection });
  }

  /** Sends when the local end said hello; returns the message id, or undefined when not sent. */
  send(kind: ClientKind, p: unknown = {}, conv?: string): string | undefined {
    if (!this.open && kind !== "hello") return undefined;
    const id = this.d.newId();
    try {
      this.ws?.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          id,
          kind,
          ...(conv === undefined ? {} : { conv }),
          p,
        }),
      );
    } catch {
      return undefined;
    }
    return id;
  }

  /**
   * One message at a time, resent with the same requestId until the turn is known (an ack that
   * names it, or a turn message for this requestId) or refused. A plain ack is only the local
   * end's memory: tars serve stopping before the turn exists would lose it, and the resend is
   * what reaches the next one.
   */
  submit(text: string, conv?: string): string {
    this.d.clearTimeout(this.submit_?.timer);
    const requestId = this.d.newId();
    this.submit_ = { requestId, text, conv, ids: new Set() };
    this.listener({ type: "submitted", requestId });
    this.transmit();
    return requestId;
  }

  private transmit(): void {
    const s = this.submit_;
    if (s === undefined) return;
    this.d.clearTimeout(s.timer);
    const id = this.send("turn.submit", { requestId: s.requestId, text: s.text }, s.conv);
    if (id !== undefined) s.ids.add(id);
    // Not sent while offline: hello sends it again.
    s.timer = this.d.setTimeout(() => this.transmit(), RESEND_MS);
  }

  private answered(re: string | undefined, ok: boolean, reason?: NackReason, turn?: string): void {
    const s = this.submit_;
    if (s === undefined || re === undefined || !s.ids.has(re)) return;
    if (ok && turn === undefined) {
      if (s.acked !== true) this.listener({ type: "submit_result", requestId: s.requestId, ok });
      s.acked = true;
      return;
    }
    this.settle(ok, reason);
  }

  private settle(ok: boolean, reason?: NackReason): void {
    const s = this.submit_;
    if (s === undefined) return;
    this.d.clearTimeout(s.timer);
    this.submit_ = undefined;
    this.listener({
      type: "submit_result",
      requestId: s.requestId,
      ok,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.state("connecting");
    const ws = this.d.open(this.d.url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.helloId = this.send("hello");
      this.beat(ws);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      if (e.data === "pong") {
        this.d.clearTimeout(this.pong);
        this.pong = undefined;
        return;
      }
      const parsed = parseServer(e.data);
      if (!parsed.ok) return;
      const m = parsed.value;
      if (m.kind === "hello" && m.re !== undefined && m.re === this.helloId) {
        this.open = true;
        this.attempt = 0;
        this.failedSince = undefined;
        this.listener({ type: "message", m, at: this.d.now() });
        this.state("open");
        this.transmit();
        return;
      }
      if (m.kind === "ack") this.answered(m.re, true, undefined, m.p.turn);
      if (m.kind === "turn" && m.p.requestId === this.submit_?.requestId) this.settle(true);
      if (m.kind === "nack") this.answered(m.re, false, m.p.reason);
      this.listener({ type: "message", m, at: this.d.now() });
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.closed(e.code, opened);
    };
  }

  private beat(ws: WebSocketLike): void {
    this.ping = this.d.setTimeout(() => {
      if (this.ws !== ws) return;
      try {
        ws.send("ping");
      } catch {
        return;
      }
      // A phone back from the background finds out here that the connection is dead.
      this.pong = this.d.setTimeout(() => {
        if (this.ws !== ws) return;
        this.ws = undefined;
        ws.close();
        this.closed(1006, true);
      }, PONG_WITHIN_MS);
      this.beat(ws);
    }, PING_EVERY_MS);
  }

  private clearBeat(): void {
    this.d.clearTimeout(this.ping);
    this.d.clearTimeout(this.pong);
    this.ping = this.pong = undefined;
  }

  private later(ms: number): void {
    this.d.clearTimeout(this.retry);
    this.retry = this.d.setTimeout(() => this.connect(), ms);
  }

  private closed(code: number, opened: boolean): void {
    this.open = false;
    this.clearBeat();
    if (this.stopped) return;
    if (code === 4003) return this.state("auth_expired");
    if (code === 4004) {
      this.state("keys_unavailable");
      return this.later(KEYS_RETRY_MS);
    }
    if (code === 4000) return this.later(0);
    const is4xxx = code >= 4000 && code <= 4999;
    if (opened && !is4xxx) this.failedSince = 0;
    else if (!opened && this.failedSince !== undefined) {
      const n = this.failedSince++;
      // Asked once, a request that failed with the network says nothing about the login, which
      // may run out while the network is still down. Every PROBE_EVERY failures (once a minute
      // at the 15 s backoff) catches that without a request on each reconnect.
      if (n % PROBE_EVERY === 0) {
        void this.probe();
        return;
      }
    }
    this.backoff();
  }

  private backoff(): void {
    this.state("offline");
    const s = BACKOFF_S[this.attempt] ?? (BACKOFF_S.at(-1) as number);
    this.attempt++;
    this.later(s * 1000);
  }

  /**
   * The upgrade's status is not visible to a WebSocket: Access turning the page away and a dead
   * network both look like a failed connection. A same-origin request tells them apart.
   */
  private async probe(): Promise<void> {
    let expired = false;
    try {
      const res = await this.d.fetch("/", { redirect: "manual", cache: "no-store" });
      expired = res.type === "opaqueredirect" || res.status === 401 || res.status === 403;
    } catch {
      // The network: keep trying.
    }
    if (this.stopped) return;
    if (expired) return this.state("auth_expired");
    this.backoff();
  }
}

export function browserSocket(): Socket {
  const url = new URL("/ws", location.href);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return new Socket({
    url: url.href,
    open: (u) => new WebSocket(u) as unknown as WebSocketLike,
    fetch: (u, init) => fetch(u, init),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    newId: () => crypto.randomUUID(),
    now: () => performance.now(),
  });
}
