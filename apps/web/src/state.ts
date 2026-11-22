import { reasonText } from "./reasons.ts";
import type {
  NackReason,
  ServerMessage,
  WireApproval,
  WireConv,
  WireItem,
  WireModel,
  WireStatus,
} from "@tars/protocol";

/** The page's own connection to the relay; "open" only after the local end's hello. */
export type Connection = "connecting" | "open" | "offline" | "auth_expired" | "keys_unavailable";

export type TurnState = "started" | "rejected" | "completed" | "failed" | "aborted";

export interface Card {
  readonly approval: WireApproval;
  /** The id of this page's approval.decide, while its ack is awaited. */
  readonly deciding?: string;
  /** This page's decision was acked. */
  readonly acked?: boolean;
  readonly resolved?: {
    readonly state: "approved" | "denied" | "expired" | "cancelled";
    readonly here: boolean;
  };
  readonly error?: string;
  /** Which decision this was among those this page saw, 1 first: the newest ones are kept. */
  readonly decidedOrder?: number;
  /**
   * What this page sent first. Kept until the result, since a send whose answer never came may
   * have been taken: only this one may go again. Only a nack saying it was not taken clears it.
   */
  readonly choice?: "approved" | "denied";
  /** A send's answer never came (the connection dropped); kept until the result. */
  readonly lost?: boolean;
  /**
   * The open conversation's last item when the card came: it is drawn after that one when the
   * approval names no tool call (a local end older than callId).
   */
  readonly after?: number;
  /** The page's clock when the ack came: a result long in coming is said to be missing. */
  readonly ackedAt?: number;
}

export interface State {
  readonly connection: Connection;
  readonly epoch?: string;
  readonly relay: { readonly online: boolean; readonly lastSeenAt?: number };
  /** When the local end connected this time, as the relay last said. */
  readonly localSince?: number;
  /** It changed while this tab was open: shown until the page is reloaded. */
  readonly reconnectedAt?: number;
  readonly status?: WireStatus;
  /** The page's monotonic clock when status arrived, to count on from status.now. */
  readonly statusAt?: number;
  /** A status.get waiting for its status: its id and when it went. */
  readonly ping?: { readonly id: string; readonly at: number };
  /**
   * 往返延遲 in ms: status.get to its status, the whole way from this page through the relay to
   * the local end and back. Not the model's latency. Kept for this connection only.
   */
  readonly rtt?: number;
  /**
   * models.result's list. Only a local end that knows models.get sends it: until it comes, the
   * page offers no other model, since such a local end refuses a turn.submit that names one.
   */
  readonly models?: readonly WireModel[];
  readonly convs: readonly WireConv[];
  /** conv.list.result came at least once: an empty list is empty, not still loading. */
  readonly listed?: boolean;
  /** The open conversation; undefined is a new one. */
  readonly conv?: string;
  readonly items: readonly WireItem[];
  readonly more: boolean;
  readonly running?: { readonly turn: string; readonly text: string };
  readonly turn?: { readonly state: TurnState; readonly turn?: string; readonly reason?: string };
  /** Sent, not yet started or refused. */
  readonly submitting?: string;
  /** A conversation followed without its items: the page asks for its snapshot. */
  readonly load?: string;
  readonly cards: readonly Card[];
  readonly notices: readonly Notice[];
  readonly error?: string;
}

export type Event =
  | { readonly type: "connection"; readonly connection: Connection }
  | { readonly type: "message"; readonly m: ServerMessage; readonly at: number }
  | { readonly type: "open_conv"; readonly conv: string | undefined }
  | { readonly type: "submitted"; readonly requestId: string }
  | { readonly type: "pinged"; readonly id: string; readonly at: number }
  | {
      readonly type: "submit_result";
      readonly requestId: string;
      readonly ok: boolean;
      readonly reason?: NackReason;
      /** The turn the local end has for it: the send is done, whatever else was missed. */
      readonly turn?: string;
      readonly conv?: string;
    }
  | {
      readonly type: "deciding";
      readonly approvalId: string;
      readonly id: string;
      readonly choice?: "approved" | "denied";
    }
  /** approval.decide could not be sent at all: the card says so instead of waiting. */
  | { readonly type: "decide_failed"; readonly approvalId: string };

export const initial: State = {
  connection: "connecting",
  relay: { online: false },
  convs: [],
  items: [],
  more: false,
  cards: [],
  notices: [],
};

const NOTICES = 5;

/** What the local end said along a turn (notice's p). */
export interface Notice {
  readonly code: string;
  readonly data?: Readonly<Record<string, string | number>>;
}

const LOST = "連線曾中斷，決定可能沒有送達；可以再按一次";

/**
 * The nacks that say no send of this card was taken. hash_mismatch: the card's hash never
 * changes, so an earlier send was refused too. Every other one speaks of this send only, and an
 * earlier one whose answer was lost may have been taken.
 */
const NOT_TAKEN: ReadonlySet<NackReason> = new Set(["hash_mismatch"]);

export const NACK_TEXT: Record<NackReason, string> = {
  busy: "本機端正在跑另一個回合",
  auth_expired: "登入已過期，請重新整理",
  already_decided: "已在別處決定",
  hash_mismatch: "核准內容不符，決定沒有送出",
  not_found: "找不到這個對話",
  not_allowed: "這條連線沒有通過檢查",
  bad_message: "訊息格式不對",
  too_large: "訊息太長",
  version: "網頁與本機端的版本不合",
  offline: "本機端離線",
};

const nackText = (reason: NackReason | undefined) =>
  reason === undefined ? "送出失敗" : NACK_TEXT[reason];

/** Another epoch: the local end's store was replaced, so nothing held here is valid. */
const fresh = (s: State, epoch: string): State => ({
  ...initial,
  connection: s.connection,
  relay: s.relay,
  ...(s.localSince === undefined ? {} : { localSince: s.localSince }),
  ...(s.reconnectedAt === undefined ? {} : { reconnectedAt: s.reconnectedAt }),
  epoch,
});

const withoutKeys = <T extends object>(o: T, ...keys: (keyof T)[]): T => {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
};

const bySeq = (items: readonly WireItem[]) => [...items].sort((a, b) => a.seq - b.seq);

function message(s: State, m: ServerMessage, at: number): State {
  const here = m.conv !== undefined && m.conv === s.conv;
  switch (m.kind) {
    case "hello":
      return s.epoch !== undefined && s.epoch !== m.p.epoch
        ? fresh(s, m.p.epoch)
        : { ...s, epoch: m.p.epoch };
    case "models.result":
      return { ...s, models: m.p.models };
    case "status":
      return s.ping !== undefined && m.re === s.ping.id
        ? { ...withoutKeys(s, "ping"), status: m.p, statusAt: at, rtt: at - s.ping.at }
        : { ...s, status: m.p, statusAt: at };
    case "relay.status": {
      const since = m.p.localSince;
      const changed = since !== undefined && s.localSince !== undefined && since !== s.localSince;
      return {
        ...s,
        relay: {
          online: m.p.online,
          ...(m.p.lastSeenAt === undefined ? {} : { lastSeenAt: m.p.lastSeenAt }),
        },
        ...(since === undefined ? {} : { localSince: since }),
        ...(changed ? { reconnectedAt: since } : {}),
      };
    }
    case "conv.list.result":
      return {
        ...s,
        listed: true,
        convs: [...m.p.convs].sort((a, b) => b.updatedAt - a.updatedAt),
      };
    case "conv.snapshot": {
      if (!here) return s;
      if (s.epoch !== undefined && m.p.epoch !== s.epoch) return fresh(s, m.p.epoch);
      const first = s.items[0]?.seq;
      const older =
        first !== undefined && m.p.items.length > 0 && m.p.items.every((i) => i.seq < first);
      if (older) return { ...s, items: [...m.p.items, ...s.items], more: m.p.more };
      const base = withoutKeys({ ...s, items: m.p.items, more: m.p.more }, "running", "load");
      return m.p.running === undefined
        ? base
        : { ...base, running: { turn: m.p.running.turn, text: m.p.running.text } };
    }
    case "turn": {
      const ours = m.p.requestId !== undefined && m.p.requestId === s.submitting;
      // Our new conversation: the page follows it once it exists.
      const follow = ours && s.conv === undefined && m.conv !== undefined;
      if (!here && !ours && !follow) return s;
      const turn = {
        state: m.p.state,
        ...(m.p.turn === undefined ? {} : { turn: m.p.turn }),
        ...(m.p.reason === undefined ? {} : { reason: m.p.reason }),
      };
      // Still ours at its end: its start, and so its items, were missed. Only a turn the
      // database has (named) is worth loading, and only in the conversation the page is on.
      const missed = ours && m.p.state !== "started" && m.p.turn !== undefined && (follow || here);
      const next: State = {
        ...(ours ? withoutKeys(s, "submitting") : s),
        ...(follow ? { conv: m.conv as string } : {}),
        ...(missed ? { load: m.conv as string } : {}),
        turn,
        ...(ours && m.p.state === "rejected"
          ? { error: `沒有開始：${reasonText(m.p.reason ?? "")}` }
          : {}),
      };
      return m.p.state === "started" ? next : withoutKeys(next, "running");
    }
    case "item": {
      if (!here || s.items.some((i) => i.seq === m.p.item.seq)) return s;
      const items = bySeq([...s.items, m.p.item]);
      return m.p.item.kind === "assistant"
        ? withoutKeys({ ...s, items }, "running")
        : { ...s, items };
    }
    case "delta": {
      if (!here) return s;
      const before = s.running?.turn === m.p.turn ? s.running.text : "";
      return { ...s, running: { turn: m.p.turn, text: before + m.p.text } };
    }
    case "notice": {
      if (m.conv !== undefined && !here) return s;
      return { ...s, notices: [...s.notices, m.p].slice(-NOTICES) };
    }
    case "approval.request": {
      // The local end sends every pending one again after each hello: it keeps its place, and
      // an error shown on it (a decision lost to the reconnect) stays until the next decision.
      // What the page knows wins over a resend: a decided card stays decided, an acked one
      // keeps waiting; only one never answered goes back to being decidable.
      const old = s.cards.find((c) => c.approval.approvalId === m.p.approval.approvalId);
      if (old === undefined) {
        const last = s.conv === m.p.approval.conv ? s.items.at(-1)?.seq : undefined;
        const card: Card = {
          approval: m.p.approval,
          ...(last === undefined ? {} : { after: last }),
        };
        return { ...s, cards: [...s.cards, card] };
      }
      if (old.resolved !== undefined) return s;
      const card: Card =
        old.acked === true
          ? { ...old, approval: m.p.approval }
          : { ...withoutKeys(old, "deciding"), approval: m.p.approval };
      return { ...s, cards: s.cards.map((c) => (c === old ? card : c)) };
    }
    case "approval.resolved": {
      const order = Math.max(0, ...s.cards.map((c) => c.decidedOrder ?? 0)) + 1;
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.approval.approvalId === m.p.approvalId
            ? withoutKeys(
                {
                  ...c,
                  resolved: { state: m.p.state, here: c.acked === true && m.p.via === "remote" },
                  decidedOrder: order,
                },
                "deciding",
              )
            : c,
        ),
      };
    }
    case "ack":
    case "nack": {
      const card = s.cards.find((c) => c.deciding !== undefined && c.deciding === m.re);
      if (card === undefined) {
        if (m.kind === "nack" && m.p.reason === "auth_expired")
          return { ...s, connection: "auth_expired" };
        return s;
      }
      const updated: Card =
        m.kind === "ack"
          ? { ...withoutKeys(card, "deciding", "error"), acked: true, ackedAt: at }
          : {
              ...withoutKeys(
                card,
                "deciding",
                ...(NOT_TAKEN.has(m.p.reason) ? (["choice"] as const) : []),
              ),
              error:
                m.p.reason === "already_decided"
                  ? "本機端已收到先前的決定，結果以本機為準；請重新整理確認"
                  : nackText(m.p.reason),
            };
      return {
        ...s,
        ...(m.kind === "nack" && m.p.reason === "auth_expired"
          ? { connection: "auth_expired" as const }
          : {}),
        cards: s.cards.map((c) => (c === card ? updated : c)),
      };
    }
  }
}

export function reduce(s: State, e: Event): State {
  switch (e.type) {
    case "connection": {
      // Back after a drop: a decision sent but never acked may not have arrived. It can be sent
      // again (the local end answers already_decided if it had). One acked keeps waiting: no
      // message gives a card's state, only the pending ones come again after hello.
      const back = e.connection === "open" && s.connection !== "open";
      return {
        // A measurement belongs to the connection it was made on.
        // models too: the local end the page reconnects to may be one that does not list them.
        ...(e.connection === "open" ? s : withoutKeys(s, "ping", "rtt", "models")),
        connection: e.connection,
        ...(back
          ? {
              cards: s.cards.map((c) =>
                c.deciding !== undefined && c.acked !== true
                  ? { ...withoutKeys(c, "deciding"), error: LOST, lost: true }
                  : c,
              ),
            }
          : {}),
      };
    }
    case "message":
      return message(s, e.m, e.at);
    case "pinged":
      return { ...s, ping: { id: e.id, at: e.at } };
    case "open_conv": {
      const base = withoutKeys(
        { ...s, items: [], more: false },
        "running",
        "turn",
        "error",
        "conv",
      );
      return e.conv === undefined ? base : { ...base, conv: e.conv };
    }
    case "submitted":
      return { ...withoutKeys(s, "error"), submitting: e.requestId };
    case "submit_result": {
      if (s.submitting !== e.requestId) return s;
      if (!e.ok) return { ...withoutKeys(s, "submitting"), error: nackText(e.reason) };
      // A plain ack: the turn may not exist yet, and the turn message finishes it.
      if (e.turn === undefined) return s;
      // Its turn message was missed, and maybe its items: a new conversation is followed, and
      // the one it went to is loaded again if the page is still on it. One moved away from is
      // left alone.
      const follow = s.conv === undefined && e.conv !== undefined;
      const here = e.conv !== undefined && (follow || e.conv === s.conv);
      return {
        ...withoutKeys(s, "submitting"),
        ...(follow ? { conv: e.conv as string } : {}),
        ...(here ? { load: e.conv as string } : {}),
      };
    }
    case "decide_failed":
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.approval.approvalId === e.approvalId
            ? { ...withoutKeys(c, "deciding"), error: "連線中斷，決定沒有送出" }
            : c,
        ),
      };
    case "deciding":
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.approval.approvalId === e.approvalId
            ? {
                ...withoutKeys(c, "error"),
                deciding: e.id,
                ...(c.choice === undefined && e.choice !== undefined ? { choice: e.choice } : {}),
              }
            : c,
        ),
      };
  }
}

/** The local end's clock now, from the last status; undefined before one arrived. */
export const localNow = (s: State, at: number): number | undefined =>
  s.status === undefined || s.statusAt === undefined ? undefined : s.status.now + (at - s.statusAt);

/** Why the composer is off, or undefined when a message can be sent. */
export function composerBlocked(s: State): string | undefined {
  if (s.connection === "auth_expired") return "登入已過期，請重新整理";
  if (s.connection === "keys_unavailable") return "本機端暫時無法驗證登入，稍後自動重試";
  if (s.connection !== "open") return "連線中斷，正在重新連線";
  if (!s.relay.online) return "本機端離線";
  if (s.submitting !== undefined) return "送出中";
  if (s.status?.turnRunning === true || s.turn?.state === "started") return "回合進行中";
  return undefined;
}
