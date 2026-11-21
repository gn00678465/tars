// @vitest-environment node
import { describe, expect, test, vi } from "vite-plus/test";
import type { Attachment } from "./route.ts";

// The DO's base class and the socket pair exist only in workerd: stand-ins that keep ctx.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.stubGlobal(
  "WebSocketRequestResponsePair",
  class {
    constructor(
      readonly request: string,
      readonly response: string,
    ) {}
  },
);

const { Relay } = await import("./relay.ts");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

class FakeSocket {
  sent: unknown[] = [];
  closed: number | undefined;
  /** The peer closed it: from now on it refuses attachments, as workerd may. */
  gone = false;
  constructor(
    private attachment: Attachment,
    private readonly refusesWhenClosed = false,
  ) {}
  serializeAttachment(a: Attachment) {
    if (this.refusesWhenClosed && (this.gone || this.closed !== undefined))
      throw new TypeError("WebSocket is closed");
    this.attachment = a;
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    this.closed = code;
  }
}

/** A DO whose sockets and storage the test holds. getWebSockets still lists a closing socket. */
function relay(sockets: FakeSocket[]) {
  const stored = new Map<string, unknown>();
  const ctx = {
    setWebSocketAutoResponse: () => {},
    getWebSockets: () => sockets,
    getWebSocketAutoResponseTimestamp: () => null,
    storage: {
      // Like DurableObjectStorage: one key gives its value, an array of keys a Map.
      get: (keys: string | string[]) =>
        Promise.resolve(
          typeof keys === "string"
            ? stored.get(keys)
            : new Map(keys.filter((k) => stored.has(k)).map((k) => [k, stored.get(k)])),
        ),
      put: (o: string | Record<string, unknown>, value?: unknown) => {
        if (typeof o === "string") stored.set(o, value);
        else for (const [k, v] of Object.entries(o)) stored.set(k, v);
        return Promise.resolve();
      },
      setAlarm: () => Promise.resolve(),
      deleteAlarm: () => Promise.resolve(),
    },
  };
  const r = new Relay(ctx as never, {} as never);
  return {
    r,
    stored,
    close: (ws: FakeSocket) => r.webSocketClose(ws as never),
    error: (ws: FakeSocket) => r.webSocketError(ws as never),
  };
}

const local = (conn: string, role: Attachment["role"] = "local") =>
  new FakeSocket({ role, conn, connectedAt: Date.now() });
const browser = (conn: string) =>
  new FakeSocket({ role: "browser", conn, connectedAt: Date.now() });

describe("the DO's close handler reaches route with the closing socket", () => {
  test("a browser that closes is reported to the local end", async () => {
    const l = local("L1");
    const a = browser(A);
    const { close } = relay([l, a, browser(B)]);
    await close(a);
    expect(l.sent).toEqual([{ t: "close", conn: A }]);
  });

  test("the same when getWebSockets no longer lists the closing socket", async () => {
    const l = local("L1");
    const a = browser(A);
    const { close } = relay([l, browser(B)]);
    await close(a);
    expect(l.sent).toEqual([{ t: "close", conn: A }]);
  });

  test("the local end that closes cleanly: lastSeenAt is stored and browsers hear it is offline", async () => {
    const l = local("L1");
    const a = browser(A);
    const { close, stored } = relay([l, a]);
    await close(l);
    expect(typeof stored.get("lastSeenAt")).toBe("number");
    expect(a.sent).toEqual([
      expect.objectContaining({
        kind: "relay.status",
        p: expect.objectContaining({ online: false }),
      }),
    ]);
  });

  test("the local end that closes while a challenger waits: the challenger takes over at once", async () => {
    const l = local("L1");
    const c = local("L2", "challenger");
    const a = browser(A);
    const { close, stored } = relay([l, c, a]);
    await close(l);
    expect(c.deserializeAttachment()).toMatchObject({ role: "local" });
    expect(typeof stored.get("localSince")).toBe("number");
    expect(a.closed).toBe(4000);
  });
});

describe("a socket already handled or replaced: its late close or error does nothing", () => {
  const offline = (ws: FakeSocket) =>
    ws.sent.filter(
      (m) =>
        (m as { kind?: string; p?: { online?: boolean } }).kind === "relay.status" &&
        (m as { p: { online: boolean } }).p.online === false,
    );

  test("the old local end closing after the alarm handed over: the new one stays online", async () => {
    const l1 = local("L1");
    // A challenger whose probe deadline has passed.
    const l2 = new FakeSocket({ role: "challenger", conn: "L2", connectedAt: Date.now() - 60_000 });
    const a = browser(A);
    const { r, close, stored } = relay([l1, l2, a]);
    await r.alarm();
    expect(l1.closed).toBe(4001);
    expect(l2.deserializeAttachment()).toMatchObject({ role: "local" });
    const since = stored.get("localSince");
    await close(l1);
    expect(stored.has("lastSeenAt")).toBe(false);
    expect(stored.get("localSince")).toBe(since);
    expect(offline(a)).toEqual([]);
    expect(l2.deserializeAttachment()).toMatchObject({ role: "local" });
  });

  test("the old local end's error after its close let the challenger in", async () => {
    const l1 = local("L1");
    const l2 = local("L2", "challenger");
    const { close, error, stored } = relay([l1, l2, browser(A)]);
    await close(l1);
    const since = stored.get("localSince");
    await error(l1);
    expect(stored.has("lastSeenAt")).toBe(false);
    expect(stored.get("localSince")).toBe(since);
    expect(l2.deserializeAttachment()).toMatchObject({ role: "local" });
  });

  test("close then error, once each: the side effects happen once", async () => {
    const l = local("L1");
    const a = browser(A);
    const b = browser(B);
    const { close, error, stored } = relay([l, a, b]);
    await close(a);
    await error(a);
    expect(l.sent).toEqual([{ t: "close", conn: A }]);
    await close(l);
    const seen = stored.get("lastSeenAt");
    await error(l);
    expect(stored.get("lastSeenAt")).toBe(seen);
    expect(offline(b)).toHaveLength(1);
  });
});

describe("a closed socket that refuses its attachment", () => {
  const refusing = (conn: string, role: Attachment["role"], connectedAt = Date.now()) =>
    new FakeSocket({ role, conn, connectedAt }, true);

  test("its close still lets the waiting challenger in, all the way", async () => {
    const l1 = refusing("L1", "local");
    const l2 = refusing("L2", "challenger");
    const a = browser(A);
    const { close, error, stored } = relay([l1, l2, a]);
    l1.gone = true;
    await close(l1);
    expect(l2.deserializeAttachment()).toMatchObject({ role: "local" });
    expect(typeof stored.get("localSince")).toBe("number");
    expect(a.closed).toBe(4000);
    // The mark it refused is kept in storage instead: the error after it changes nothing.
    const since = stored.get("localSince");
    await error(l1);
    expect(stored.get("localSince")).toBe(since);
    expect(stored.has("lastSeenAt")).toBe(false);
    expect(l2.deserializeAttachment()).toMatchObject({ role: "local" });
  });

  test("the alarm's hand-over closes the old one first and still completes; its late close does nothing", async () => {
    const l1 = refusing("L1", "local");
    const l2 = refusing("L2", "challenger", Date.now() - 60_000);
    const a = browser(A);
    const { r, close, stored } = relay([l1, l2, a]);
    await r.alarm();
    expect(l1.closed).toBe(4001);
    expect(l2.deserializeAttachment()).toMatchObject({ role: "local" });
    expect(typeof stored.get("localSince")).toBe("number");
    expect(a.closed).toBe(4000);
    const since = stored.get("localSince");
    await close(l1);
    expect(stored.get("localSince")).toBe(since);
    expect(stored.has("lastSeenAt")).toBe(false);
    expect(l2.deserializeAttachment()).toMatchObject({ role: "local" });
  });

  test("a browser's close then error: the local end hears of it once", async () => {
    const l = local("L1");
    const a = refusing(A, "browser");
    const { close, error } = relay([l, a]);
    a.gone = true;
    await close(a);
    await error(a);
    expect(l.sent).toEqual([{ t: "close", conn: A }]);
  });

  test("anything else that throws is not swallowed", async () => {
    const l = local("L1");
    const c = local("L2", "challenger");
    c.serializeAttachment = () => {
      throw new Error("storage broke");
    };
    const { close } = relay([l, c]);
    await expect(close(l)).rejects.toThrow("storage broke");
  });
});
