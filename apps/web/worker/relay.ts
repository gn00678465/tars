import { DurableObject } from "cloudflare:workers";
import { parseRelayFrame } from "@tars/protocol";
import { rebuild, relayStatus, route, type Attachment, type RelayEvent } from "./route.ts";

/** Who the Worker says a socket is, on the request it hands over. */
export const ROLE_HEADER = "X-Relay-Role";
export const CONN_HEADER = "X-Relay-Conn";
export const JWT_HEADER = "X-Relay-Jwt";
export const COUNTRY_HEADER = "X-Relay-Country";
export const UA_HEADER = "X-Relay-Ua";

const STORE_KEYS = ["lastSeenAt", "localSince"] as const;

/**
 * The one relay (idFromName("relay")), on the Hibernation API: it wakes with no memory, so every
 * event rebuilds the state from its sockets and storage, runs route, and carries out the actions.
 */
export class Relay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats from both sides are answered without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const role = request.headers.get(ROLE_HEADER);
    if (role !== "local" && role !== "browser") return new Response("forbidden", { status: 403 });
    const now = Date.now();
    // The state before the new socket is accepted, so it does not count itself.
    const before = await this.state();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    if (role === "local") {
      const sock = crypto.randomUUID();
      server.serializeAttachment({
        role: "local",
        conn: sock,
        connectedAt: now,
      } satisfies Attachment);
      await this.apply(before, { type: "local.connect", sock, now });
    } else {
      const conn = request.headers.get(CONN_HEADER) ?? "";
      server.serializeAttachment({ role: "browser", conn, connectedAt: now } satisfies Attachment);
      const country = request.headers.get(COUNTRY_HEADER);
      const ua = request.headers.get(UA_HEADER);
      await this.apply(before, {
        type: "browser.connect",
        conn,
        jwt: request.headers.get(JWT_HEADER) ?? "",
        ...(country === null ? {} : { country: country.slice(0, 8) }),
        ...(ua === null ? {} : { ua: ua.slice(0, 256) }),
        now,
      });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const a = attachmentOf(ws);
    if (a === undefined) return;
    if (a.role === "browser") {
      console.log({ from: "browser", bytes: message.length });
      return this.apply(await this.state(), {
        type: "browser.message",
        conn: a.conn,
        raw: message,
        now: Date.now(),
      });
    }
    const frame = parseRelayFrame(message);
    if (!frame.ok) return;
    console.log({ from: "local", frame: frame.value.t, bytes: message.length });
    return this.apply(await this.state(), {
      type: "local.frame",
      sock: a.conn,
      frame: frame.value,
    });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.closed(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.closed(ws);
  }

  override async alarm(): Promise<void> {
    await this.apply(await this.state(), { type: "alarm", now: Date.now() });
  }

  private async closed(ws: WebSocket): Promise<void> {
    const a = attachmentOf(ws);
    if (a === undefined) return;
    // route matches a close against the state that still holds the socket, so it is put back in
    // whether or not getWebSockets lists it during its own close handler.
    const state = await this.state(ws);
    await this.apply(
      state,
      a.role === "browser"
        ? { type: "browser.close", conn: a.conn }
        : { type: "local.close", sock: a.conn, now: Date.now() },
    );
  }

  private async state(closing?: WebSocket) {
    const stored = await this.ctx.storage.get<number>([...STORE_KEYS]);
    const others = this.ctx.getWebSockets().filter((ws) => ws !== closing);
    const sockets = (closing === undefined ? others : [...others, closing]).flatMap((ws) => {
      const attachment = attachmentOf(ws);
      return attachment === undefined
        ? []
        : [
            {
              attachment,
              autoResponseAt: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
            },
          ];
    });
    const lastSeenAt = stored.get("lastSeenAt");
    const localSince = stored.get("localSince");
    return rebuild(sockets, {
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
      ...(localSince === undefined ? {} : { localSince }),
    });
  }

  private async apply(state: Awaited<ReturnType<Relay["state"]>>, event: RelayEvent) {
    const { state: next, actions } = route(state, event);
    const find = (conn: string) =>
      this.ctx.getWebSockets().find((ws) => attachmentOf(ws)?.conn === conn);
    const send = (ws: WebSocket | undefined, data: unknown) => {
      try {
        ws?.send(JSON.stringify(data));
      } catch {
        // A socket closing under us: its close event settles the state.
      }
    };
    for (const action of actions)
      switch (action.type) {
        case "to.local":
          // A probe goes to the local end that was there before the challenger: still next.local.
          send(next.local === undefined ? undefined : find(next.local.sock), action.frame);
          break;
        case "to.browser":
          send(find(action.conn), action.message);
          break;
        case "close.local":
          find(action.sock)?.close(action.code, "relay");
          break;
        case "close.browser":
          find(action.conn)?.close(action.code, "relay");
          break;
        case "tag": {
          const ws = find(action.sock);
          const a = ws === undefined ? undefined : attachmentOf(ws);
          if (ws !== undefined && a !== undefined)
            ws.serializeAttachment({ ...a, role: action.role, stale: action.stale });
          break;
        }
        case "alarm":
          if (action.at === null) await this.ctx.storage.deleteAlarm();
          else await this.ctx.storage.setAlarm(action.at);
          break;
        case "broadcast.status":
          for (const conn of next.browsers)
            send(find(conn), relayStatus(next, crypto.randomUUID()));
          break;
        case "store":
          await this.ctx.storage.put({
            ...(action.lastSeenAt === undefined ? {} : { lastSeenAt: action.lastSeenAt }),
            ...(action.localSince === undefined ? {} : { localSince: action.localSince }),
          });
          break;
      }
  }
}

function attachmentOf(ws: WebSocket): Attachment | undefined {
  const a = ws.deserializeAttachment() as Attachment | null;
  return a === null || typeof a.conn !== "string" ? undefined : a;
}
