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
  constructor(private attachment: Attachment) {}
  serializeAttachment(a: Attachment) {
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
      get: (keys: string[]) =>
        Promise.resolve(new Map(keys.filter((k) => stored.has(k)).map((k) => [k, stored.get(k)]))),
      put: (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) stored.set(k, v);
        return Promise.resolve();
      },
      setAlarm: () => Promise.resolve(),
      deleteAlarm: () => Promise.resolve(),
    },
  };
  const r = new Relay(ctx as never, {} as never);
  return { r, stored, close: (ws: FakeSocket) => r.webSocketClose(ws as never) };
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
