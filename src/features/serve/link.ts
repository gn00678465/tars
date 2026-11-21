import { parseFrame, type FrameToLocal, type FrameToRelay } from "@tars/protocol";
import type { LinkState, Log } from "../agent/log.ts";
import type { Timers } from "./access.ts";

const BACKOFF_S = [1, 2, 4, 8, 15];
const JITTER = 0.2;
const REPLACED_RETRY_MS = 5 * 60 * 1000;
const PING_EVERY_MS = 30_000;
const PONG_WITHIN_MS = 10_000;
export const REPLACED_CODE = 4002;

/** The part of a WebSocket the link uses; Bun's, or a test's. */
export interface LinkSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (e: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", fn: () => void): void;
}

export interface LinkInit {
  readonly headers: Record<string, string>;
  readonly tls?: { readonly cert: string; readonly key: string };
}

export const bunSocket = (url: string, init: LinkInit): LinkSocket =>
  // Bun's client takes headers and the client certificate; the DOM type does not know them.
  new WebSocket(url, init as unknown as string[]) as unknown as LinkSocket;

export interface LinkDeps {
  readonly url: string;
  /** Absent for a ws:// link in e2e. */
  readonly tls?: { readonly cert: string; readonly key: string };
  /** tars's version: the User-Agent is tars-serve/<version>. */
  readonly version: string;
  connect(url: string, init: LinkInit): LinkSocket;
  readonly timers: Timers;
  now(): number;
  random(): number;
  readonly log: Log;
  onFrame(frame: FrameToLocal): void;
  /** Connected or gone: the relay's browser connections are not ours anymore either way. */
  onReset(): void;
  onConnected(): void;
  /** Closed with 4002, `since` being when that started; called on every such close. */
  onReplaced(since: number): void;
  onState(): void;
}

/**
 * The one WebSocket to the relay. Each socket's handlers first check it is still the current
 * one, so a late close from an old socket (4002 included) cannot touch the new connection.
 */
export class Link {
  state: LinkState = "connecting";
  since: number;
  lastError: string | undefined;
  replacedSince: number | undefined;
  private ws: LinkSocket | undefined;
  private attempts = 0;
  private stopped = false;
  private retry: unknown;
  private ping: unknown;
  private pong: unknown;

  constructor(private readonly d: LinkDeps) {
    this.since = d.now();
  }

  start(): void {
    this.open();
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  send(frame: FrameToRelay): void {
    if (this.state !== "connected") return;
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      // Closing: the close event reconnects.
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.d.timers.clearTimeout(this.retry);
    this.ws?.close(1000, "stopping");
    this.ws = undefined;
  }

  private set(state: LinkState, extra: { code?: number } = {}): void {
    if (this.state !== state) this.since = this.d.now();
    this.state = state;
    this.d.log.log("link", { state, reconnects: this.attempts, ...extra });
    this.d.onState();
  }

  private open(): void {
    if (this.stopped) return;
    if (this.state !== "replaced") this.set("connecting");
    const ws = this.d.connect(this.d.url, {
      // The owner's domain blocks requests whose User-Agent has no "/"; Bun sends none.
      headers: { "User-Agent": `tars-serve/${this.d.version}` },
      ...(this.d.tls === undefined ? {} : { tls: this.d.tls }),
    });
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.replacedSince = undefined;
      this.lastError = undefined;
      this.d.onReset();
      this.d.onConnected();
      this.set("connected");
      this.beat(ws);
    });
    ws.addEventListener("message", (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      if (e.data === "pong") {
        this.d.timers.clearTimeout(this.pong);
        this.pong = undefined;
        return;
      }
      const frame = parseFrame(e.data);
      if (!frame.ok) return;
      if (frame.value.t === "probe") this.send({ t: "probe.ok" });
      else this.d.onFrame(frame.value);
    });
    ws.addEventListener("close", (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.closed(e.code, e.reason);
    });
    ws.addEventListener("error", () => {
      if (this.ws === ws) this.lastError = "連線失敗";
    });
  }

  private beat(ws: LinkSocket): void {
    this.ping = this.d.timers.setTimeout(() => {
      if (this.ws !== ws) return;
      try {
        ws.send("ping");
      } catch {
        return;
      }
      this.pong = this.d.timers.setTimeout(() => {
        if (this.ws !== ws) return;
        this.lastError = "心跳沒有回應";
        this.ws = undefined;
        ws.close(4000, "no pong");
        this.closed(4000, "no pong");
      }, PONG_WITHIN_MS);
      this.beat(ws);
    }, PING_EVERY_MS);
  }

  private clearTimers(): void {
    this.d.timers.clearTimeout(this.ping);
    this.d.timers.clearTimeout(this.pong);
    this.ping = this.pong = undefined;
  }

  private closed(code: number, reason: string): void {
    this.clearTimers();
    this.d.onReset();
    if (this.stopped) return;
    if (code === REPLACED_CODE) {
      // Another local end came first and still answers: wait, do not exit (S3-4).
      this.replacedSince ??= this.d.now();
      this.set("replaced", { code });
      this.d.onReplaced(this.replacedSince);
      this.retry = this.d.timers.setTimeout(() => this.open(), REPLACED_RETRY_MS);
      return;
    }
    if (reason !== "" && this.lastError === undefined) this.lastError = reason.slice(0, 200);
    const base = (BACKOFF_S[this.attempts] ?? (BACKOFF_S.at(-1) as number)) * 1000;
    this.attempts++;
    this.set("connecting", { code });
    this.retry = this.d.timers.setTimeout(() => this.open(), base * (1 + this.d.random() * JITTER));
  }
}
