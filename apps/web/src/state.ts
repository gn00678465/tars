import type {
  NackReason,
  ServerMessage,
  WireApproval,
  WireConv,
  WireItem,
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
  readonly convs: readonly WireConv[];
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
  readonly notices: readonly string[];
  readonly error?: string;
}

export type Event =
  | { readonly type: "connection"; readonly connection: Connection }
  | { readonly type: "message"; readonly m: ServerMessage; readonly at: number }
  | { readonly type: "open_conv"; readonly conv: string | undefined }
  | { readonly type: "submitted"; readonly requestId: string }
  | {
      readonly type: "submit_result";
      readonly requestId: string;
      readonly ok: boolean;
      readonly reason?: NackReason;
      /** The turn the local end has for it: the send is done, whatever else was missed. */
      readonly turn?: string;
      readonly conv?: string;
    }
  | { readonly type: "deciding"; readonly approvalId: string; readonly id: string };

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
    case "status":
      return { ...s, status: m.p, statusAt: at };
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
      return { ...s, convs: [...m.p.convs].sort((a, b) => b.updatedAt - a.updatedAt) };
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
      const next: State = {
        ...(ours ? withoutKeys(s, "submitting") : s),
        ...(follow ? { conv: m.conv as string } : {}),
        turn,
        ...(ours && m.p.state === "rejected" ? { error: `沒有開始：${m.p.reason ?? ""}` } : {}),
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
      const data =
        m.p.data === undefined
          ? ""
          : `（${Object.entries(m.p.data)
              .map(([k, v]) => `${k}=${v}`)
              .join("，")}）`;
      return { ...s, notices: [...s.notices, `${m.p.code}${data}`].slice(-NOTICES) };
    }
    case "approval.request": {
      const rest = s.cards.filter((c) => c.approval.approvalId !== m.p.approval.approvalId);
      return { ...s, cards: [...rest, { approval: m.p.approval }] };
    }
    case "approval.resolved":
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.approval.approvalId === m.p.approvalId
            ? withoutKeys(
                {
                  ...c,
                  resolved: { state: m.p.state, here: c.acked === true && m.p.via === "remote" },
                },
                "deciding",
              )
            : c,
        ),
      };
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
          ? { ...withoutKeys(card, "deciding", "error"), acked: true }
          : { ...withoutKeys(card, "deciding"), error: nackText(m.p.reason) };
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
    case "connection":
      return { ...s, connection: e.connection };
    case "message":
      return message(s, e.m, e.at);
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
    case "deciding":
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.approval.approvalId === e.approvalId
            ? { ...withoutKeys(c, "error"), deciding: e.id }
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
