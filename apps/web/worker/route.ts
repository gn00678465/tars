import {
  ID_CHARS,
  MESSAGE_BYTES,
  PROTOCOL_VERSION,
  withinBytes,
  type FrameToLocal,
  type FrameToRelay,
  type ServerMessage,
} from "@tars/protocol";

/** How long the local end has to answer a probe before a second one takes over. */
export const PROBE_MS = 5_000;
/** Heartbeats come every 30 s; three missed and the local end counts as offline. */
export const STALE_MS = 90_000;

export const CLOSE = {
  /** Browsers, when the local end changes: reconnect, so the Worker checks the JWT again. */
  relayReconnect: 4000,
  /** The local end that did not answer the probe. */
  probeTimeout: 4001,
  /** The later local end, while the first one still answers. */
  replaced: 4002,
} as const;

export interface RelayState {
  readonly local?: {
    readonly sock: string;
    readonly since: number;
    readonly lastBeatAt: number;
    readonly stale: boolean;
  };
  /** The probe's deadline. */
  readonly challenger?: { readonly sock: string; readonly deadline: number };
  /** Connection ids. */
  readonly browsers: readonly string[];
  /** When the last local end went away; from storage. */
  readonly lastSeenAt?: number;
}

export type RelayEvent =
  | { readonly type: "local.connect"; readonly sock: string; readonly now: number }
  | { readonly type: "local.close"; readonly sock: string; readonly now: number }
  | { readonly type: "local.frame"; readonly sock: string; readonly frame: FrameToRelay }
  /** The alarm rang; route sees for itself which deadlines are due. */
  | { readonly type: "alarm"; readonly now: number }
  | {
      readonly type: "browser.connect";
      readonly conn: string;
      readonly jwt: string;
      readonly country?: string;
      readonly ua?: string;
      readonly now: number;
    }
  | { readonly type: "browser.close"; readonly conn: string }
  | {
      readonly type: "browser.message";
      readonly conn: string;
      readonly raw: string;
      readonly now: number;
    };

export type RelayAction =
  | { readonly type: "to.local"; readonly frame: FrameToLocal }
  /** What the local end sent is passed on as it is; the browser checks it with parseServer. */
  | { readonly type: "to.browser"; readonly conn: string; readonly message: unknown }
  | { readonly type: "close.local"; readonly sock: string; readonly code: number }
  | { readonly type: "close.browser"; readonly conn: string; readonly code: number }
  /** Rewrites the socket's attachment, so a woken DO rebuilds the same state. */
  | {
      readonly type: "tag";
      readonly sock: string;
      readonly role: "local" | "challenger" | "retired";
      readonly stale: boolean;
    }
  /** The earliest pending deadline; null cancels. */
  | { readonly type: "alarm"; readonly at: number | null }
  /** The current relay.status, to every browser. */
  | { readonly type: "broadcast.status" }
  | { readonly type: "store"; readonly lastSeenAt?: number; readonly localSince?: number };

export type Routed = { readonly state: RelayState; readonly actions: RelayAction[] };

/** online is "there is a local end and it is not stale". */
export function relayStatus(state: RelayState, id: string): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    id,
    kind: "relay.status",
    p: {
      online: state.local !== undefined && !state.local.stale,
      ...(state.lastSeenAt === undefined ? {} : { lastSeenAt: state.lastSeenAt }),
      ...(state.local === undefined ? {} : { localSince: state.local.since }),
    },
  };
}

const alarmOf = (state: RelayState): RelayAction => ({
  type: "alarm",
  at: state.challenger?.deadline ?? null,
});

const closeBrowsers = (state: RelayState): RelayAction[] =>
  state.browsers.map((conn) => ({
    type: "close.browser",
    conn,
    code: CLOSE.relayReconnect,
  }));

/** A local end taking over: every browser reconnects, so no JWT has to stay in the DO. */
function takeOver(
  state: RelayState,
  sock: string,
  now: number,
  actions: RelayAction[],
): RelayState {
  actions.push(
    // The one replaced stays among the sockets until its close arrives: not a local end again.
    ...(state.local === undefined || state.local.sock === sock
      ? []
      : [{ type: "tag", sock: state.local.sock, role: "retired", stale: false } as const]),
    { type: "tag", sock, role: "local", stale: false },
    { type: "store", localSince: now },
    ...closeBrowsers(state),
  );
  const { challenger: _, ...rest } = state;
  return { ...rest, local: { sock, since: now, lastBeatAt: now, stale: false }, browsers: [] };
}

/**
 * The heartbeat as seen at a browser event: over STALE_MS since the last one marks the local end
 * stale, a fresh one clears it. Either change goes to every browser.
 */
function checkBeat(state: RelayState, now: number, actions: RelayAction[]): RelayState {
  const local = state.local;
  if (local === undefined) return state;
  const stale = now - local.lastBeatAt > STALE_MS;
  if (stale === local.stale) return state;
  actions.push(
    { type: "tag", sock: local.sock, role: "local", stale },
    { type: "broadcast.status" },
  );
  return { ...state, local: { ...local, stale } };
}

const messageId = (raw: unknown): string | undefined =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { id?: unknown }).id === "string" &&
  (raw as { id: string }).id.length > 0 &&
  (raw as { id: string }).id.length <= ID_CHARS
    ? (raw as { id: string }).id
    : undefined;

function parseObject(raw: string): Record<string, unknown> | undefined {
  if (!withinBytes(raw, MESSAGE_BYTES)) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The relay's rules, with no runtime: the DO rebuilds `state` from its sockets, calls this, and
 * carries out the actions. `newId` names the messages the relay itself sends.
 */
export function route(
  state: RelayState,
  event: RelayEvent,
  newId: () => string = () => crypto.randomUUID(),
): Routed {
  const actions: RelayAction[] = [];
  const done = (next: RelayState): Routed => ({ state: next, actions });

  switch (event.type) {
    case "local.connect": {
      if (state.local === undefined) return done(takeOver(state, event.sock, event.now, actions));
      // The first one stays (S3-4): the later one wins only if the first cannot answer.
      if (state.challenger !== undefined)
        actions.push({ type: "close.local", sock: state.challenger.sock, code: CLOSE.replaced });
      const next = { ...state, challenger: { sock: event.sock, deadline: event.now + PROBE_MS } };
      actions.push(
        { type: "tag", sock: event.sock, role: "challenger", stale: false },
        { type: "to.local", frame: { t: "probe" } },
        alarmOf(next),
      );
      return done(next);
    }

    case "local.close": {
      if (state.challenger?.sock === event.sock) {
        const { challenger: _, ...rest } = state;
        actions.push(alarmOf(rest));
        return done(rest);
      }
      if (state.local?.sock !== event.sock) return done(state);
      // Gone while a challenger waits: that one is the local end now, as a restart would be.
      if (state.challenger !== undefined) {
        const next = takeOver(state, state.challenger.sock, event.now, actions);
        actions.push(alarmOf(next));
        return done(next);
      }
      const { local: _, ...rest } = state;
      const next = { ...rest, lastSeenAt: event.now };
      actions.push({ type: "store", lastSeenAt: event.now }, { type: "broadcast.status" });
      return done(next);
    }

    case "local.frame": {
      const local = state.local;
      if (local?.sock !== event.sock) return done(state);
      let next = state;
      if (local.stale) {
        next = { ...state, local: { ...local, stale: false } };
        actions.push(
          { type: "tag", sock: local.sock, role: "local", stale: false },
          { type: "broadcast.status" },
        );
      }
      const f = event.frame;
      if (f.t === "probe.ok") {
        if (next.challenger !== undefined) {
          actions.push({ type: "close.local", sock: next.challenger.sock, code: CLOSE.replaced });
          const { challenger: _, ...rest } = next;
          next = rest;
          actions.push(alarmOf(next));
        }
      } else if (f.t === "msg") {
        if (next.browsers.includes(f.to))
          actions.push({ type: "to.browser", conn: f.to, message: f.m });
      } else if (next.browsers.includes(f.conn)) {
        actions.push({ type: "close.browser", conn: f.conn, code: f.code });
        next = { ...next, browsers: next.browsers.filter((c) => c !== f.conn) };
      }
      return done(next);
    }

    case "alarm": {
      const c = state.challenger;
      if (c === undefined || c.deadline > event.now) {
        actions.push(alarmOf(state));
        return done(state);
      }
      if (state.local !== undefined)
        actions.push({ type: "close.local", sock: state.local.sock, code: CLOSE.probeTimeout });
      const next = takeOver(state, c.sock, event.now, actions);
      actions.push(alarmOf(next));
      return done(next);
    }

    case "browser.connect": {
      let next = checkBeat(state, event.now, actions);
      next = { ...next, browsers: [...next.browsers, event.conn] };
      // Sent while the local end is connected at all, stale or not: a stale one may only be
      // without a network for a while, and the DO keeps no JWT to send this again later.
      if (next.local !== undefined)
        actions.push({
          type: "to.local",
          frame: {
            t: "open",
            conn: event.conn,
            jwt: event.jwt,
            ...(event.country === undefined ? {} : { country: event.country }),
            ...(event.ua === undefined ? {} : { ua: event.ua }),
          },
        });
      actions.push({ type: "to.browser", conn: event.conn, message: relayStatus(next, newId()) });
      return done(next);
    }

    case "browser.close": {
      if (!state.browsers.includes(event.conn)) return done(state);
      if (state.local !== undefined)
        actions.push({ type: "to.local", frame: { t: "close", conn: event.conn } });
      return done({ ...state, browsers: state.browsers.filter((c) => c !== event.conn) });
    }

    case "browser.message": {
      if (!state.browsers.includes(event.conn)) return done(state);
      const m = parseObject(event.raw);
      if (m === undefined) return done(state);
      const next = checkBeat(state, event.now, actions);
      if (next.local === undefined || next.local.stale) {
        const re = messageId(m);
        actions.push({
          type: "to.browser",
          conn: event.conn,
          message: {
            v: PROTOCOL_VERSION,
            id: newId(),
            kind: "nack",
            ...(re === undefined ? {} : { re }),
            p: { reason: "offline" },
          } satisfies ServerMessage,
        });
        return done(next);
      }
      actions.push({ type: "to.local", frame: { t: "msg", conn: event.conn, m } });
      return done(next);
    }
  }
}

/** What each socket carries across hibernation. */
export interface Attachment {
  /** retired: replaced or its close already handled; no event from it changes anything. */
  readonly role: "local" | "challenger" | "browser" | "retired";
  /** A browser's connection id, or the DO's name for a local socket. */
  readonly conn: string;
  /** When this socket was accepted. */
  readonly connectedAt: number;
  readonly stale?: boolean;
}

/**
 * The state from the sockets a woken DO still holds. Before a local end's first heartbeat its
 * auto-response time is null: that is not silence, so the time it connected stands in.
 */
export function rebuild(
  sockets: readonly { readonly attachment: Attachment; readonly autoResponseAt: number | null }[],
  stored: {
    readonly lastSeenAt?: number;
    readonly localSince?: number;
    /** Sockets retired whose attachment could not be rewritten (see Relay.retire). */
    readonly retired?: readonly string[];
  },
): RelayState {
  let local: RelayState["local"];
  let challenger: RelayState["challenger"];
  const browsers: string[] = [];
  for (const { attachment: a, autoResponseAt } of sockets) {
    if (a.role === "retired" || stored.retired?.includes(a.conn) === true) continue;
    if (a.role === "browser") browsers.push(a.conn);
    else if (a.role === "challenger")
      challenger = { sock: a.conn, deadline: a.connectedAt + PROBE_MS };
    else
      local = {
        sock: a.conn,
        since: stored.localSince ?? a.connectedAt,
        lastBeatAt: autoResponseAt ?? a.connectedAt,
        stale: a.stale === true,
      };
  }
  return {
    browsers,
    ...(local === undefined ? {} : { local }),
    ...(challenger === undefined ? {} : { challenger }),
    ...(stored.lastSeenAt === undefined ? {} : { lastSeenAt: stored.lastSeenAt }),
  };
}
