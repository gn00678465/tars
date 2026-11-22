import {
  DELTA_BYTES,
  MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Phase,
  type FrameToRelay,
  type ServerMessage,
} from "@tars/protocol";
import { cutUtf8, utf8Bytes } from "../agent/bytes.ts";
import type { Frontend, FrontendEvent } from "../agent/frontend.ts";
import type { ApprovalRecord } from "../agent/types.ts";
import type { Registry, Timers } from "./access.ts";
import type { Notifier } from "./notify.ts";
import { toWire, wireApproval, wireBytes, wireData, type WireLookup } from "./wire.ts";

const DELTA_EVERY_MS = 80;

/** What a frontend and dispatch share: who is connected, and how to reach them. */
export interface Hub {
  readonly registry: Registry;
  /** To one connection that is registered and within its login; to any other, nothing. */
  send(conn: string, m: ServerMessage): void;
  newId(): string;
  readonly timers: Timers;
  readonly notifier: Notifier;
  readonly lookup: WireLookup;
}

/**
 * Hub.send over the link. The login is checked on every send: the expiry timer may not have run
 * yet on a busy event loop. Bytes over the message limit would be refused by the relay and the
 * page, so they are not sent either.
 */
export const linkSend =
  (registry: Registry, sendFrame: (f: FrameToRelay) => void): Hub["send"] =>
  (conn, m) => {
    if (!registry.valid(conn) || wireBytes(m) > MESSAGE_BYTES) return;
    sendFrame({ t: "msg", to: conn, m });
  };

type Body<K extends ServerMessage["kind"]> = Extract<ServerMessage, { kind: K }>["p"];

export const message = <K extends ServerMessage["kind"]>(
  hub: Hub,
  kind: K,
  p: Body<K>,
  extra: { conv?: string; re?: string } = {},
) => ({ v: PROTOCOL_VERSION, id: hub.newId(), kind, ...extra, p }) as ServerMessage;

/** To every connection that said hello. */
export const broadcast = (hub: Hub, m: () => ServerMessage) => {
  for (const r of hub.registry.ready()) hub.send(r.conn, m());
};

type Decision = "approved" | "denied" | "cancelled";

/**
 * already_decided, with what was decided: the decision still being carried out, else the row.
 * Which connection decided is known only for the former; for a row it is left out.
 */
export function alreadyDecided(
  hub: Hub,
  approvalId: string,
  re: { re: string },
  conn: string,
  by: { conn: string; decision: "approved" | "denied" } | undefined,
): ServerMessage {
  const state = by?.decision ?? hub.lookup.decided(approvalId);
  return message(
    hub,
    "nack",
    {
      reason: "already_decided",
      ...(state === undefined ? {} : { state }),
      ...(by === undefined ? {} : { source: by.conn === conn ? "this" : "other_device" }),
    },
    re,
  );
}
type Decide = Extract<ClientMessage, { kind: "approval.decide" }>;

/**
 * The loop's frontend for one turn started from a browser. Its answers to approvals are recorded
 * as decided via "remote".
 */
export class RemoteFrontend implements Frontend {
  readonly via = "remote";
  convId: string | undefined;
  turnId: string | undefined;
  /** The text streamed since the last assistant item, for a snapshot. */
  running = "";
  /** What the turn is doing now, for the status line and a snapshot. */
  phase: Phase | undefined;
  /** A compaction of this conversation is under way, for a snapshot: it has no phase. */
  compacting = false;
  /** After turn_end: the page has cleared its status line, and nothing may bring it back. */
  private ended = false;
  /** A step's calls come all at once, then run one by one: those without a result yet. */
  private readonly openCalls = new Set<string>();
  private pendingDelta = "";
  private deltaTimer: unknown;
  private waiting:
    | {
        record: ApprovalRecord;
        /** The connection whose decision was taken, and what it decided. */
        decided?: { conn: string; decision: "approved" | "denied" };
        resolve: (d: Decision) => void;
      }
    | undefined;
  /**
   * The last decision taken, kept past the wait: for approval_resolved, and for a late decide
   * that arrives before the loop's transaction has written it.
   */
  private decidedBy:
    | { approvalId: string; conn: string; decision: "approved" | "denied" }
    | undefined;

  constructor(
    private readonly hub: Hub,
    /** The connection that sent turn.submit; it follows the conversation once it exists. */
    private readonly origin: string,
    private readonly requestId: string,
    private readonly onTurnStart: (turnId: string) => void,
  ) {}

  /** Waiting for an approval: no tool's child runs meanwhile. */
  get awaitingApproval(): boolean {
    return this.waiting !== undefined;
  }

  private subscribed(): string[] {
    return this.hub.registry
      .ready()
      .filter((r) => r.subscribed !== undefined && r.subscribed === this.convId)
      .map((r) => r.conn);
  }

  private toSubscribed(m: () => ServerMessage): void {
    for (const conn of this.subscribed()) this.hub.send(conn, m());
  }

  private conv() {
    return this.convId === undefined ? {} : { conv: this.convId };
  }

  /** Sent when it changes: a turn's phases are few, deltas are many. */
  private setPhase(phase: Phase): void {
    const turn = this.turnId;
    if (turn === undefined || this.ended || this.phase === phase) return;
    this.phase = phase;
    this.toSubscribed(() => message(this.hub, "turn.phase", { turn, phase }, this.conv()));
  }

  emit(e: FrontendEvent): void {
    switch (e.type) {
      case "turn_start": {
        this.convId = e.convId;
        this.turnId = e.turnId;
        this.compacting = false;
        this.running = "";
        this.onTurnStart(e.turnId);
        broadcast(this.hub, () =>
          message(
            this.hub,
            "turn",
            { turn: e.turnId, requestId: this.requestId, state: "started" },
            this.conv(),
          ),
        );
        const reg = this.hub.registry.get(this.origin);
        if (reg !== undefined) reg.subscribed = e.convId;
        // The loop sends no item for the message the owner typed; another device has not seen it.
        for (const item of e.items) this.item(item);
        // Until the model's first token: waiting on it reads as thinking.
        this.setPhase("thinking");
        return;
      }
      case "delta":
        this.setPhase("replying");
        this.running += e.text;
        this.pendingDelta += e.text;
        if (utf8Bytes(this.pendingDelta) >= DELTA_BYTES) this.flush();
        else this.deltaTimer ??= this.hub.timers.setTimeout(() => this.flush(), DELTA_EVERY_MS);
        return;
      case "thinking":
        this.setPhase("thinking");
        return;
      case "item":
        this.flush();
        if (e.item.kind === "assistant") this.running = "";
        this.item(e.item);
        if (e.item.kind === "compaction") this.compacting = false;
        else if (e.item.kind === "tool_call") {
          this.openCalls.add(e.item.body.callId);
          this.setPhase("running_script");
        } else if (e.item.kind === "tool_result") {
          this.openCalls.delete(e.item.body.callId);
          // The step's last result: the next request, waiting on the model again.
          if (this.openCalls.size === 0) this.setPhase("thinking");
        }
        return;
      case "notice":
        if (e.code === "compact_start") this.compacting = true;
        else if (e.code === "compact_failed" || e.code === "compact_skipped")
          this.compacting = false;
        this.toSubscribed(() =>
          message(
            this.hub,
            "notice",
            { code: e.code, ...(e.data === undefined ? {} : { data: wireData(e.data) }) },
            this.conv(),
          ),
        );
        return;
      case "approval_resolved": {
        if (e.state === "approved") this.setPhase("running_script");
        const by =
          (e.via === "remote" || e.via === "tty") && this.decidedBy?.approvalId === e.approvalId
            ? this.decidedBy.conn
            : undefined;
        for (const r of this.hub.registry.ready())
          this.hub.send(
            r.conn,
            message(this.hub, "approval.resolved", {
              approvalId: e.approvalId,
              state: e.state,
              // A remote frontend's decisions are all remote; timeout and abort pass as they are.
              via: e.via === "tty" ? "remote" : e.via,
              at: e.at,
              ...(by === undefined ? {} : { source: by === r.conn ? "this" : "other_device" }),
            }),
          );
        return;
      }
      case "turn_end":
        this.flush();
        this.running = "";
        // The end itself clears the page's status line; no phase follows it.
        this.phase = undefined;
        this.ended = true;
        this.compacting = false;
        broadcast(this.hub, () =>
          message(
            this.hub,
            "turn",
            {
              ...(this.turnId === undefined ? {} : { turn: this.turnId }),
              requestId: this.requestId,
              // A turn that ends is never running; that would be a failure.
              state: e.state === "running" ? "failed" : e.state,
              ...(e.reason === undefined ? {} : { reason: e.reason.slice(0, 64) }),
              ...(e.data === undefined ? {} : { data: wireData(e.data) }),
              costUsd: e.costUsd,
            },
            this.conv(),
          ),
        );
        return;
    }
  }

  private item(item: Parameters<typeof toWire>[0]): void {
    const wire = toWire(item, this.hub.lookup);
    if (wire !== undefined)
      this.toSubscribed(() => message(this.hub, "item", { item: wire }, this.conv()));
  }

  /** Sends what has piled up, in pieces of at most DELTA_BYTES. */
  flush(): void {
    this.hub.timers.clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    let rest = this.pendingDelta;
    this.pendingDelta = "";
    const turn = this.turnId;
    if (turn === undefined) return;
    while (rest !== "") {
      const piece = cutUtf8(rest, DELTA_BYTES);
      rest = rest.slice(piece.length);
      this.toSubscribed(() => message(this.hub, "delta", { turn, text: piece }, this.conv()));
    }
  }

  async askApproval(record: ApprovalRecord, signal: AbortSignal): Promise<Decision> {
    this.setPhase("waiting_approval");
    broadcast(this.hub, () =>
      message(this.hub, "approval.request", { approval: wireApproval(record) }),
    );
    const answer = new Promise<Decision>((resolve) => {
      this.waiting = { record, resolve };
      if (signal.aborted) resolve("cancelled");
      signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    void this.hub.notifier.approval(record);
    // A notification put off while a tool might run can go now.
    this.hub.notifier.poke();
    try {
      return await answer;
    } finally {
      this.waiting = undefined;
    }
  }

  /**
   * A browser's decision. The hash and the connection's login are checked here only; the loop's
   * transaction then decides whether the approval was still pending and unexpired (S3-16).
   */
  async decide(conn: string, m: Decide, reply: (m: ServerMessage) => void): Promise<void> {
    const re = { re: m.id };
    const nack = (reason: "auth_expired" | "hash_mismatch") =>
      reply(message(this.hub, "nack", { reason }, re));
    if (!this.hub.registry.valid(conn)) return nack("auth_expired");
    const w = this.waiting;
    if (w === undefined || w.decided !== undefined || w.record.id !== m.p.approvalId) {
      const by = this.decidedBy?.approvalId === m.p.approvalId ? this.decidedBy : undefined;
      return reply(alreadyDecided(this.hub, m.p.approvalId, re, conn, by));
    }
    if (m.p.hash !== w.record.hash) return nack("hash_mismatch");
    w.decided = { conn, decision: m.p.decision };
    this.decidedBy = { approvalId: w.record.id, ...w.decided };
    reply(message(this.hub, "ack", {}, re));
    // approved starts the tool's child at once, and the script runner is not re-entrant.
    await this.hub.notifier.idle();
    w.resolve(m.p.decision);
  }

  dispose(): void {
    this.hub.timers.clearTimeout(this.deltaTimer);
  }
}
