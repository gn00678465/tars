import {
  DELTA_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@tars/protocol";
import { cutUtf8, utf8Bytes } from "../agent/bytes.ts";
import type { Frontend, FrontendEvent } from "../agent/frontend.ts";
import type { ApprovalRecord } from "../agent/types.ts";
import type { Registry, Timers } from "./access.ts";
import type { Notifier } from "./notify.ts";
import { toWire, wireApproval, type UsageFigures } from "./wire.ts";

const DELTA_EVERY_MS = 80;

/** What a frontend and dispatch share: who is connected, and how to reach them. */
export interface Hub {
  readonly registry: Registry;
  /** To one registered connection; nothing goes to a connection that is not registered. */
  send(conn: string, m: ServerMessage): void;
  newId(): string;
  readonly timers: Timers;
  readonly notifier: Notifier;
  usageOf(usageId: number): UsageFigures | undefined;
}

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

/** Within the protocol's limits for a notice's data; the loop's values are short already. */
const noticeData = (data: Readonly<Record<string, string | number>>) =>
  Object.fromEntries(
    Object.entries(data)
      .slice(0, 16)
      .map(([k, v]) => [k.slice(0, 64), typeof v === "string" ? v.slice(0, 256) : v]),
  );

type Decision = "approved" | "denied" | "cancelled";
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
  private pendingDelta = "";
  private deltaTimer: unknown;
  private waiting:
    | { record: ApprovalRecord; deciding: boolean; resolve: (d: Decision) => void }
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

  emit(e: FrontendEvent): void {
    switch (e.type) {
      case "turn_start": {
        this.convId = e.convId;
        this.turnId = e.turnId;
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
        return;
      }
      case "delta":
        this.running += e.text;
        this.pendingDelta += e.text;
        if (utf8Bytes(this.pendingDelta) >= DELTA_BYTES) this.flush();
        else this.deltaTimer ??= this.hub.timers.setTimeout(() => this.flush(), DELTA_EVERY_MS);
        return;
      case "thinking":
        return;
      case "item":
        this.flush();
        if (e.item.kind === "assistant") this.running = "";
        this.item(e.item);
        return;
      case "notice":
        this.toSubscribed(() =>
          message(
            this.hub,
            "notice",
            { code: e.code, ...(e.data === undefined ? {} : { data: noticeData(e.data) }) },
            this.conv(),
          ),
        );
        return;
      case "approval_resolved":
        broadcast(this.hub, () =>
          message(this.hub, "approval.resolved", {
            approvalId: e.approvalId,
            state: e.state,
            // A remote frontend's decisions are all remote; timeout and abort pass as they are.
            via: e.via === "tty" ? "remote" : e.via,
          }),
        );
        return;
      case "turn_end":
        this.flush();
        this.running = "";
        broadcast(this.hub, () =>
          message(
            this.hub,
            "turn",
            {
              ...(this.turnId === undefined ? {} : { turn: this.turnId }),
              requestId: this.requestId,
              // A turn that ends is never running or interrupted; those would be failures.
              state: e.state === "running" || e.state === "interrupted" ? "failed" : e.state,
              ...(e.reason === undefined ? {} : { reason: e.reason.slice(0, 64) }),
              costUsd: e.costUsd,
            },
            this.conv(),
          ),
        );
        return;
    }
  }

  private item(item: Parameters<typeof toWire>[0]): void {
    const wire = toWire(item, (id) => this.hub.usageOf(id));
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
    broadcast(this.hub, () =>
      message(this.hub, "approval.request", { approval: wireApproval(record) }),
    );
    const answer = new Promise<Decision>((resolve) => {
      this.waiting = { record, deciding: false, resolve };
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
    const nack = (reason: "auth_expired" | "already_decided" | "hash_mismatch") =>
      reply(message(this.hub, "nack", { reason }, re));
    if (!this.hub.registry.valid(conn)) return nack("auth_expired");
    const w = this.waiting;
    if (w === undefined || w.deciding || w.record.id !== m.p.approvalId)
      return nack("already_decided");
    if (m.p.hash !== w.record.hash) return nack("hash_mismatch");
    w.deciding = true;
    reply(message(this.hub, "ack", {}, re));
    // approved starts the tool's child at once, and the script runner is not re-entrant.
    await this.hub.notifier.idle();
    w.resolve(m.p.decision);
  }

  dispose(): void {
    this.hub.timers.clearTimeout(this.deltaTimer);
  }
}
