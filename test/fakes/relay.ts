import type { ServerWebSocket } from "bun";

export interface FakeRelay {
  /** ws://127.0.0.1:<port>, for TARS_E2E_LINK_URL. */
  readonly url: string;
  /** Every frame the local end sent, parsed; "ping" heartbeats are counted, not listed. */
  readonly frames: unknown[];
  pings: number;
  /** Each upgrade's headers, in order. */
  readonly upgrades: Headers[];
  /** Whether "ping" gets "pong"; on by default, as the DO's auto-response. */
  answerPings: boolean;
  /** Sends a frame to the connected local end. */
  send(frame: unknown): void;
  /** Closes the local end's socket with this code. */
  close(code?: number, reason?: string): void;
  connected(): boolean;
  /** Resolves when a frame matching `pred` has arrived (or already had). */
  waitFor(
    pred: (f: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>;
  /** Resolves on the next connection, or the n-th one counting from the start. */
  waitConnections(n: number, ms?: number): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The DO's link side on 127.0.0.1: the test plays the relay, sends open, close, msg and probe
 * frames, and reads what the local end sends back.
 */
export function startFakeRelay(): FakeRelay {
  let socket: ServerWebSocket<unknown> | undefined;
  const waiters: (() => void)[] = [];
  let connections = 0;
  const poke = () => waiters.splice(0).forEach((w) => w());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      relay.upgrades.push(req.headers);
      return srv.upgrade(req) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        socket = ws;
        connections++;
        poke();
      },
      message(ws, data) {
        if (typeof data !== "string") return;
        if (data === "ping") {
          relay.pings++;
          if (relay.answerPings) ws.send("pong");
          return;
        }
        try {
          relay.frames.push(JSON.parse(data));
        } catch {
          relay.frames.push(data);
        }
        poke();
      },
      close(ws) {
        if (socket === ws) socket = undefined;
        poke();
      },
    },
  });
  const until = (ok: () => boolean, ms: number, what: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fake relay: timed out waiting for ${what}`)),
        ms,
      );
      const check = () => {
        if (ok()) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  const relay: FakeRelay = {
    url: `ws://127.0.0.1:${server.port}`,
    frames: [],
    pings: 0,
    upgrades: [],
    answerPings: true,
    send: (frame) => socket?.send(JSON.stringify(frame)),
    close: (code = 1000, reason = "") => socket?.close(code, reason),
    connected: () => socket !== undefined,
    async waitFor(pred, ms = 5000) {
      let found: Record<string, unknown> | undefined;
      await until(
        () =>
          (found = relay.frames.find(
            (f): f is Record<string, unknown> =>
              typeof f === "object" && f !== null && pred(f as Record<string, unknown>),
          )) !== undefined,
        ms,
        "a frame",
      );
      return found as Record<string, unknown>;
    },
    waitConnections: (n, ms = 5000) => until(() => connections >= n, ms, `connection ${n}`),
    stop: async () => {
      await server.stop(true);
    },
  };
  return relay;
}
