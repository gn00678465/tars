import { reasonText } from "./reasons.ts";
import {
  type WikiEvent,
  type WikiState,
  wikiInitial,
  wikiMessage,
  wikiReduce,
} from "./wiki/state.ts";
import type {
  NackReason,
  Phase,
  ServerMessage,
  WireApproval,
  WireContext,
  WireCatalogEntry,
  WireConv,
  WireItem,
  WireModel,
  WireStatus,
} from "@tars/protocol";

/** The page's own connection to the relay; "open" only after the local end's hello. */
export type Connection =
  | "connecting"
  | "open"
  | "offline"
  | "auth_expired"
  | "keys_unavailable"
  /** hello was refused as another protocol version: which side is behind (nack.need). */
  | "version";

export type TurnState = "started" | "rejected" | "completed" | "failed" | "aborted" | "interrupted";

export interface Card {
  readonly approval: WireApproval;
  /** The id of this page's approval.decide, while its ack is awaited. */
  readonly deciding?: string;
  /** This page's decision was acked. */
  readonly acked?: boolean;
  readonly resolved?: {
    readonly state: "approved" | "denied" | "expired" | "cancelled";
    readonly here: boolean;
    /** When the local end settled it, by its clock; absent from an older one and from a nack. */
    readonly at?: number;
    /** Which connection decided, when the local end knows; absent for an expiry or a cancel. */
    readonly source?: "this" | "other_device";
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
  /** Which reconnect try the page is on; absent once open, or before the first drop. */
  readonly reconnect?: number;
  /** With connection "version": the side to update. */
  readonly need?: "client" | "local";
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
  /**
   * The read-only price table, with models.result: every model the local list has, active first
   * (total: how many there are, more than entries when it was cut), and the UTC date the list
   * last saw a model. Absent from a local end older than it.
   */
  readonly catalog?: {
    readonly entries: readonly WireCatalogEntry[];
    readonly total?: number;
    readonly updatedAt?: string;
  };
  readonly convs: readonly WireConv[];
  /** conv.list.result came at least once: an empty list is empty, not still loading. */
  readonly listed?: boolean;
  /** The open conversation; undefined is a new one. */
  readonly conv?: string;
  readonly items: readonly WireItem[];
  readonly more: boolean;
  readonly running?: { readonly turn: string; readonly text: string };
  /**
   * The last reply that came while the page was open, for a screen reader (polite): a whole reply
   * once, not each delta, and nothing from a snapshot.
   */
  readonly spoken?: string;
  readonly turn?: {
    readonly state: TurnState;
    readonly turn?: string;
    readonly reason?: string;
    /** The local end's figures for reason. */
    readonly data?: Readonly<Record<string, string | number>>;
    /** What a started turn is doing, from turn.phase or a snapshot. */
    readonly phase?: Phase;
  };
  /** Sent, not yet started or refused. */
  readonly submitting?: string;
  /** The submitting one is a form's ui.submit: the ui_show call it came from. */
  readonly form?: { readonly callId: string; readonly requestId: string };
  /** Why the last form sent was refused, shown under that form until it is sent again. */
  readonly formError?: { readonly callId: string; readonly text: string };
  /** A conversation followed without its items: the page asks for its snapshot. */
  readonly load?: string;
  readonly cards: readonly Card[];
  readonly notices: readonly Notice[];
  readonly error?: string;
  readonly wiki: WikiState;
  /**
   * The open conversation's context, from conv.context. Only a local end that takes
   * conv.compact sends it: the page offers compaction only once it came.
   */
  readonly context?: WireContext;
  /**
   * A compaction of the open conversation is under way: the owner's (compact started), the one
   * a turn runs first (notice compact_start), or either one a snapshot says is running.
   */
  readonly compacting?: true;
  /** This page's conv.compact, until its ack or nack. */
  readonly compactReq?: string;
  /** How the owner's last compaction here ended, when not with a summary; cleared by the next. */
  readonly compactEnd?: CompactEnd;
  /** This page's conv.archive, until its ack or nack; undo: it takes the archive back. */
  readonly archiveReq?: {
    readonly id: string;
    readonly conv: string;
    readonly undo: boolean;
  };
  /**
   * What the archive toast says, for a few seconds: 已封存 with its 復原 (undo), or a sentence.
   * seq tells one toast from the next, so an old one's timer does not close a new one.
   */
  readonly archiveNote?: {
    readonly undo: boolean;
    /** With undo: the conversation 復原 takes back. */
    readonly conv?: string;
    readonly text?: string;
    readonly seq: number;
  };
  /** The last conv.open the page sent: a refusal for an archived conversation is told apart by it. */
  readonly openReq?: { readonly id: string; readonly conv: string };
  /** How many times the page was taken out of a conversation that was archived: it starts anew. */
  readonly left?: number;
}

export interface CompactEnd {
  readonly state: "skipped" | "failed" | "aborted";
  readonly reason?: string;
  readonly data?: Readonly<Record<string, string | number>>;
  /** The local end refused conv.compact itself (busy, not_found). */
  readonly nack?: NackReason;
}

export type Event =
  | {
      readonly type: "connection";
      readonly connection: Connection;
      /** Reconnecting: which try this is, 1 first; absent for the first connect. */
      readonly attempt?: number;
      readonly need?: "client" | "local";
    }
  | { readonly type: "message"; readonly m: ServerMessage; readonly at: number }
  | { readonly type: "open_conv"; readonly conv: string | undefined }
  /** form: a form's ui.submit, by its ui_show call. */
  | { readonly type: "submitted"; readonly requestId: string; readonly form?: string }
  /** conv.compact went (its id), or could not be sent at all (no id). */
  | { readonly type: "compact_sent"; readonly id?: string }
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
  | { readonly type: "decide_failed"; readonly approvalId: string }
  /** conv.archive went (its id), or could not be sent at all (no id). */
  | {
      readonly type: "archive_sent";
      readonly conv: string;
      readonly undo: boolean;
      readonly id?: string;
    }
  | { readonly type: "archive_toast_done"; readonly seq: number }
  | { readonly type: "open_sent"; readonly conv: string; readonly id?: string }
  /** The owner acted on what these notices asked for. */
  | { readonly type: "notices_done"; readonly code: string }
  | { readonly type: "wiki"; readonly e: WikiEvent };

export const initial: State = {
  connection: "connecting",
  relay: { online: false },
  convs: [],
  items: [],
  more: false,
  cards: [],
  notices: [],
  wiki: wikiInitial,
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
  conv_archived: "這個對話已封存，不能繼續；要取回請在終端執行 tars chat --unarchive",
  conv_active: "這個對話還有進行中的回合或待核准項目，不能封存",
};

const nackText = (reason: NackReason | undefined) =>
  reason === undefined ? "送出失敗" : NACK_TEXT[reason];

/**
 * A form's refusals in its own words (m4_design_a2ui.md 1.6): the local end checks the values
 * again and names only the reason.
 */
const FORM_NACK: Partial<Record<NackReason, string>> = {
  bad_message: "本機端沒有接受這張表單：值不對，或本機端還不支援表單",
  not_found: "本機端找不到這張表單",
  already_decided: "這張表單已經送出過",
};

const formNackText = (reason: NackReason | undefined) =>
  (reason === undefined ? undefined : FORM_NACK[reason]) ?? nackText(reason);

/** Another epoch: the local end's store was replaced, so nothing held here is valid. */
const fresh = (s: State, epoch: string): State => ({
  ...initial,
  connection: s.connection,
  relay: s.relay,
  ...(s.localSince === undefined ? {} : { localSince: s.localSince }),
  ...(s.reconnectedAt === undefined ? {} : { reconnectedAt: s.reconnectedAt }),
  // The knowledge base is not the store that was replaced, and is asked for once per connection.
  wiki: s.wiki,
  epoch,
});

const withoutKeys = <T extends object>(o: T, ...keys: (keyof T)[]): T => {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
};

const bySeq = (items: readonly WireItem[]) => [...items].sort((a, b) => a.seq - b.seq);

/** A compaction ended, however it did: nothing says it is running any more. */
const compactOver = (s: State): State => ({
  ...withoutKeys(s, "compacting"),
  notices: s.notices.filter((n) => n.code !== "compact_start"),
});

const ARCHIVED_ELSEWHERE = "這個對話已封存；要取回請在終端執行 tars chat --unarchive";
const UNDO_LOST =
  "復原不了：已超過 60 秒，或不是從這個分頁封存的；要取回請在終端執行 tars chat --unarchive";

const note = (
  s: State,
  n: { undo: boolean; conv?: string; text?: string },
): State["archiveNote"] => ({
  ...n,
  seq: (s.archiveNote?.seq ?? 0) + 1,
});

/**
 * The page is on a conversation that is archived: it goes back to a new one, and the list loses
 * it until the local end sends the next one. The page's own state (the model picked, the level)
 * is forgotten by whoever sees `left` change.
 */
const leaveArchived = (s: State, conv: string): State => {
  const gone = { ...s, convs: s.convs.filter((c) => c.id !== conv) };
  return s.conv === conv
    ? { ...reduce(gone, { type: "open_conv", conv: undefined }), left: (s.left ?? 0) + 1 }
    : gone;
};

function message(s: State, m: ServerMessage, at: number): State {
  const wiki = wikiMessage(s.wiki, m);
  if (wiki !== undefined)
    return {
      ...s,
      wiki,
      ...(m.kind === "nack" && m.p.reason === "auth_expired"
        ? { connection: "auth_expired" as const }
        : {}),
    };
  const here = m.conv !== undefined && m.conv === s.conv;
  switch (m.kind) {
    case "hello":
      return s.epoch !== undefined && s.epoch !== m.p.epoch
        ? fresh(s, m.p.epoch)
        : { ...s, epoch: m.p.epoch };
    case "models.result": {
      const { catalog, catalogTotal, updatedAt } = m.p;
      return {
        ...withoutKeys(s, "catalog"),
        models: m.p.models,
        ...(catalog === undefined && updatedAt === undefined
          ? {}
          : {
              catalog: {
                entries: catalog ?? [],
                ...(catalogTotal === undefined ? {} : { total: catalogTotal }),
                ...(updatedAt === undefined ? {} : { updatedAt }),
              },
            }),
      };
    }
    // An answer no request waits on any more: it waited too long, or the connection dropped.
    case "wiki.status.result":
    case "wiki.list.result":
    case "wiki.page.result":
    case "wiki.search.result":
    case "wiki.source.result":
      return s;
    case "status":
      return s.ping !== undefined && m.re === s.ping.id
        ? { ...withoutKeys(s, "ping"), status: m.p, statusAt: at, rtt: at - s.ping.at }
        : { ...s, status: m.p, statusAt: at };
    case "turn.phase":
      // Only for the started turn shown here; one that ended keeps no phase (no stale line).
      return here &&
        s.turn?.state === "started" &&
        (s.turn.turn === undefined || s.turn.turn === m.p.turn)
        ? { ...s, turn: { ...s.turn, turn: m.p.turn, phase: m.p.phase } }
        : s;
    case "compact": {
      if (!here) return s;
      if (m.p.state === "started") return { ...withoutKeys(s, "compactEnd"), compacting: true };
      const ended = withoutKeys(compactOver(s), "compactReq", "compactEnd");
      return m.p.state === "completed"
        ? ended
        : {
            ...ended,
            compactEnd: {
              state: m.p.state,
              ...(m.p.reason === undefined ? {} : { reason: m.p.reason }),
              ...(m.p.data === undefined ? {} : { data: m.p.data }),
            },
          };
    }
    case "conv.context":
      return here ? { ...s, context: m.p } : s;
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
      const loaded = withoutKeys({ ...s, items: m.p.items, more: m.p.more }, "running", "load");
      const base =
        m.p.compacting === true ? { ...loaded, compacting: true as const } : compactOver(loaded);
      const r = m.p.running;
      // The snapshot is the local end's word on now. No turn running: a started one here ended
      // while the page was away (iOS freezes a page, and its socket drops), and so did its cards:
      // an approval waits only inside a running turn. They are dropped, not given an end the
      // page does not know; the thread's tool row says how the call ended. One sent and not yet
      // started is `submitting`, which stays.
      if (r === undefined)
        return {
          ...(s.turn?.state === "started" ? withoutKeys(base, "turn") : base),
          cards: base.cards.filter((c) => c.approval.conv !== m.conv || c.resolved !== undefined),
        };
      // A page opened mid-turn: the turn is under way, in the phase the snapshot says.
      const turn =
        s.turn?.state === "started" && (s.turn.turn === undefined || s.turn.turn === r.turn)
          ? s.turn
          : { state: "started" as const, turn: r.turn };
      return {
        ...base,
        running: { turn: r.turn, text: r.text },
        turn: r.phase === undefined ? turn : { ...turn, phase: r.phase },
      };
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
        ...(m.p.data === undefined ? {} : { data: m.p.data }),
      };
      // Still ours at its end: its start, and so its items, were missed. Only a turn the
      // database has (named) is worth loading, and only in the conversation the page is on.
      const missed = ours && m.p.state !== "started" && m.p.turn !== undefined && (follow || here);
      // A turn's own compaction runs before the turn starts: it is over by now.
      const rejected = ours && m.p.state === "rejected";
      // A form's turn that did not start says so under the form, which stays open.
      const form = ours ? s.form : undefined;
      const why = `沒有開始：${reasonText(m.p.reason ?? "")}`;
      const next: State = {
        ...compactOver(ours ? withoutKeys(s, "submitting", "form") : s),
        ...(follow ? { conv: m.conv as string } : {}),
        ...(missed ? { load: m.conv as string } : {}),
        turn,
        ...(rejected && form === undefined ? { error: why } : {}),
        ...(rejected && form !== undefined
          ? { formError: { callId: form.callId, text: why } }
          : {}),
      };
      return m.p.state === "started" ? next : withoutKeys(next, "running");
    }
    case "item": {
      if (!here || s.items.some((i) => i.seq === m.p.item.seq)) return s;
      const items = bySeq([...s.items, m.p.item]);
      if (m.p.item.kind === "compaction") return { ...compactOver(s), items };
      return m.p.item.kind === "assistant"
        ? { ...withoutKeys(s, "running"), items, spoken: m.p.item.text }
        : { ...s, items };
    }
    case "delta": {
      if (!here) return s;
      const before = s.running?.turn === m.p.turn ? s.running.text : "";
      return { ...s, running: { turn: m.p.turn, text: before + m.p.text } };
    }
    case "notice": {
      if (m.conv !== undefined && !here) return s;
      // Archived by another device or tab: this page leaves it and says why. Its own archive
      // is answered by the ack, which brings the toast with its 復原.
      if (m.p.code === "conv_archived" && m.conv !== undefined) {
        const own = s.archiveReq?.conv === m.conv && !s.archiveReq.undo;
        const left = leaveArchived(s, m.conv);
        return own
          ? left
          : { ...left, archiveNote: note(s, { undo: false, text: ARCHIVED_ELSEWHERE }) };
      }
      const notices = [...s.notices, m.p].slice(-NOTICES);
      if (m.p.code === "compact_start") return { ...s, notices, compacting: true };
      if (m.p.code === "compact_failed" || m.p.code === "compact_skipped")
        return compactOver({ ...s, notices });
      return { ...s, notices };
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
                  resolved: {
                    state: m.p.state,
                    // The local end says which connection decided; an older one does not, and
                    // a decision this page saw acked is taken as this page's.
                    here:
                      m.p.source === undefined
                        ? c.acked === true && m.p.via === "remote"
                        : m.p.source === "this",
                    ...(m.p.at === undefined ? {} : { at: m.p.at }),
                    ...(m.p.source === undefined ? {} : { source: m.p.source }),
                  },
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
      const archive = s.archiveReq;
      if (archive !== undefined && m.re === archive.id) {
        const settled = withoutKeys(s, "archiveReq");
        if (m.kind === "ack")
          return archive.undo
            ? withoutKeys(settled, "archiveNote")
            : {
                ...leaveArchived(settled, archive.conv),
                archiveNote: note(s, { undo: true, conv: archive.conv }),
              };
        return {
          ...settled,
          ...(m.p.reason === "auth_expired" ? { connection: "auth_expired" as const } : {}),
          archiveNote: note(s, {
            undo: false,
            text: archive.undo && m.p.reason === "not_allowed" ? UNDO_LOST : nackText(m.p.reason),
          }),
        };
      }
      // conv.open of a conversation that is gone (the one a reload reopens): back home.
      if (
        s.openReq !== undefined &&
        m.re === s.openReq.id &&
        m.kind === "nack" &&
        m.p.reason === "not_found" &&
        s.conv === s.openReq.conv
      )
        return reduce(withoutKeys(s, "openReq"), { type: "open_conv", conv: undefined });
      // conv.open of a conversation archived meanwhile (a tab that was offline): leave it.
      if (
        s.openReq !== undefined &&
        m.re === s.openReq.id &&
        m.kind === "nack" &&
        m.p.reason === "conv_archived"
      )
        return {
          ...leaveArchived(withoutKeys(s, "openReq"), s.openReq.conv),
          archiveNote: note(s, { undo: false, text: ARCHIVED_ELSEWHERE }),
        };
      if (s.compactReq !== undefined && m.re === s.compactReq) {
        const settled = withoutKeys(s, "compactReq");
        // The ack: compact started follows. A nack: it never ran, the conversation is as it was.
        if (m.kind === "ack") return settled;
        return {
          ...settled,
          ...(m.p.reason === "auth_expired" ? { connection: "auth_expired" as const } : {}),
          compactEnd: { state: "failed", nack: m.p.reason },
        };
      }
      const card = s.cards.find((c) => c.deciding !== undefined && c.deciding === m.re);
      if (card === undefined) {
        if (m.kind === "nack" && m.p.reason === "auth_expired")
          return { ...s, connection: "auth_expired" };
        return s;
      }
      // Decided elsewhere, and the local end says what: the card shows that result (B2).
      const elsewhere =
        m.kind === "nack" && m.p.reason === "already_decided" && m.p.state !== undefined
          ? m.p.state
          : undefined;
      const updated: Card =
        m.kind === "ack"
          ? { ...withoutKeys(card, "deciding", "error"), acked: true, ackedAt: at }
          : elsewhere !== undefined
            ? {
                ...withoutKeys(card, "deciding", "error", "choice", "lost"),
                resolved: {
                  state: elsewhere,
                  here: m.kind === "nack" && m.p.source === "this",
                  ...(m.kind === "nack" && m.p.source !== undefined ? { source: m.p.source } : {}),
                },
                decidedOrder: Math.max(0, ...s.cards.map((c) => c.decidedOrder ?? 0)) + 1,
              }
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
        ...withoutKeys(
          e.connection === "open" ? s : withoutKeys(s, "ping", "rtt", "models", "catalog"),
          "reconnect",
          "need",
        ),
        connection: e.connection,
        ...(e.attempt === undefined || e.attempt === 0 ? {} : { reconnect: e.attempt }),
        ...(e.need === undefined ? {} : { need: e.need }),
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
    case "notices_done":
      return { ...s, notices: s.notices.filter((n) => n.code !== e.code) };
    case "wiki":
      return { ...s, wiki: wikiReduce(s.wiki, e.e) };
    case "pinged":
      return { ...s, ping: { id: e.id, at: e.at } };
    case "open_conv": {
      const base = withoutKeys(
        { ...s, items: [], more: false },
        "running",
        "turn",
        "error",
        "conv",
        "spoken",
        "context",
        "compacting",
        "compactReq",
        "compactEnd",
      );
      const chat = { ...base, wiki: wikiReduce(s.wiki, { type: "view", view: "chat" }) };
      return e.conv === undefined ? chat : { ...chat, conv: e.conv };
    }
    case "submitted": {
      const sent = { ...withoutKeys(s, "error", "compactEnd", "form"), submitting: e.requestId };
      return e.form === undefined
        ? sent
        : {
            ...withoutKeys(sent, "formError"),
            form: { callId: e.form, requestId: e.requestId },
          };
    }
    case "archive_sent":
      return e.id === undefined
        ? { ...s, archiveNote: note(s, { undo: false, text: nackText("offline") }) }
        : { ...s, archiveReq: { id: e.id, conv: e.conv, undo: e.undo } };
    case "archive_toast_done":
      return s.archiveNote?.seq === e.seq ? withoutKeys(s, "archiveNote") : s;
    case "open_sent":
      return e.id === undefined ? s : { ...s, openReq: { id: e.id, conv: e.conv } };
    case "compact_sent":
      return e.id === undefined
        ? { ...s, compactEnd: { state: "failed", nack: "offline" } }
        : { ...withoutKeys(s, "compactEnd"), compactReq: e.id };
    case "submit_result": {
      if (s.submitting !== e.requestId) return s;
      // A form's refusal is said under the form, which stays open to be sent again.
      if (!e.ok && s.form?.requestId === e.requestId)
        return {
          ...withoutKeys(s, "submitting", "form"),
          formError: { callId: s.form.callId, text: formNackText(e.reason) },
        };
      if (!e.ok) return { ...withoutKeys(s, "submitting"), error: nackText(e.reason) };
      // A plain ack: the turn may not exist yet, and the turn message finishes it.
      if (e.turn === undefined) return s;
      // Its turn message was missed, and maybe its items: a new conversation is followed, and
      // the one it went to is loaded again if the page is still on it. One moved away from is
      // left alone.
      const follow = s.conv === undefined && e.conv !== undefined;
      const here = e.conv !== undefined && (follow || e.conv === s.conv);
      return {
        ...withoutKeys(s, "submitting", "form"),
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

/** ui_spec 5.2: a version mismatch says which side to update, by hello's nack.need. */
export const versionText = (need: "client" | "local" | undefined) =>
  need === "local" ? "協定不合，請更新本機 tars" : "協定不合，請重新載入頁面";

/** Why the composer is off (nothing can reach the local end), or undefined when it is on. */
export function composerBlocked(s: State): string | undefined {
  if (s.connection === "auth_expired") return "登入已過期，請重新登入後再試。";
  if (s.connection === "version") return versionText(s.need);
  if (s.connection === "keys_unavailable") return "本機端暫時無法驗證登入，稍後自動重試";
  if (s.connection !== "open") return "連線中斷，正在重新連線";
  if (!s.relay.online) return "本機端離線，暫時無法送出訊息。";
  return undefined;
}

/**
 * Why a message cannot go yet, though the composer is on: the owner keeps typing the next one
 * while a turn runs, as the prototype, and only the send waits (the local end runs one turn).
 */
export function sendBusy(s: State): string | undefined {
  const busy = runBusy(s);
  if (busy !== undefined) return busy;
  // With auto compaction on, the local end compacts before a message past the line goes
  // (engine.ts autoCompact): only with it off does a send stop here.
  if (overStop(s.context) && s.context?.autoCompact === false)
    return `這個對話太長（${contextPct(s.context)}%），超過硬停門檻。請先執行 /compact，或開新對話接續`;
  return undefined;
}

/**
 * The local end is running something (a turn, a compaction) or about to: nothing else that runs
 * the model can start, and the conversation's model cannot change.
 */
export function runBusy(s: State): string | undefined {
  if (s.submitting !== undefined) return "送出中";
  if (s.compacting === true || s.compactReq !== undefined) return "壓縮中";
  if (s.status?.turnRunning === true || s.turn?.state === "started") return "回合進行中";
  return undefined;
}

/** At or past the local end's stop line, judged on the ratio itself, not the rounded share. */
export const overStop = (c: WireContext | undefined) =>
  c !== undefined && c.contextUsed / c.contextLimit >= c.stopRatio;

/** Before a figure the local end estimated (after a compaction, until a request measures it). */
export const about = (c: WireContext | undefined) => (c?.estimated === true ? "約 " : "");

/** The context used as a whole percentage of the window. */
export const contextPct = (c: WireContext | undefined): number | undefined =>
  c === undefined ? undefined : Math.round((c.contextUsed / c.contextLimit) * 100);
