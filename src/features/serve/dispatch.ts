import type { Database } from "bun:sqlite";
import {
  checkClient,
  ID_CHARS,
  PROTOCOL_VERSION,
  SNAPSHOT_BYTES,
  SNAPSHOT_ITEMS,
  type ClientMessage,
  type FrameToLocal,
  type FrameToRelay,
  type NackReason,
  type ServerMessage,
  type WireItem,
  type WireStatus,
} from "@tars/protocol";
import { sha256 } from "../../core/hash.ts";
import type { TarsPaths } from "../../core/paths.ts";
import * as approvals from "../agent/approvals.ts";
import { loadCatalog, resolve, type Catalog } from "../agent/catalog.ts";
import { defaultStart } from "../agent/chat.ts";
import type { TarsConfig } from "../agent/config.ts";
import { budgetStatuses } from "../agent/cost-command.ts";
import type { Engine, TurnInput } from "../agent/engine.ts";
import type { Log } from "../agent/log.ts";
import * as store from "../agent/store.ts";
import type { AccessVerifier, Registry } from "./access.ts";
import { broadcast, message, RemoteFrontend, type Hub } from "./remote-frontend.ts";
import { toWire, wireApproval, wireBytes, wireConv, wireRunning } from "./wire.ts";

/** Close codes the local end gives a browser connection. */
export const DROP = { auth: 4003, keys: 4004, flood: 4005 } as const;
/**
 * Frames one connection may have waiting. A page sends a few before its hello is answered;
 * more is a page gone wrong, and an unbounded queue would hold its frames in memory.
 */
const QUEUE_FRAMES = 32;
const RECONCILE_WAIT_MS = 5_000;
const CONV_LIST = 500;

export interface DispatchDeps {
  readonly db: Database;
  readonly paths: TarsPaths;
  readonly engine: Engine;
  readonly verifier: Pick<AccessVerifier, "verify">;
  readonly hub: Hub;
  /** tars's version, for hello. */
  readonly version: string;
  readonly log: Log;
  now(): number;
  sendFrame(frame: FrameToRelay): void;
  /** Read for every turn and status, so the owner's edits apply. */
  config(): Promise<TarsConfig>;
  /** OpenRouter's correction after a turn; this waits for it at most 5 s. */
  reconcile(provider: TurnInput["provider"]): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Something the status file shows changed. */
  changed(): void;
}

interface Current {
  readonly requestId: string;
  readonly convId: string | undefined;
  readonly frontend: RemoteFrontend;
  readonly controller: AbortController;
}

type Of<K extends ClientMessage["kind"]> = Extract<ClientMessage, { kind: K }>;

/**
 * The browsers' requests, from the link's frames. One turn at a time on this machine (A6):
 * `current` is it, and it is always cleared, whatever the turn throws.
 */
export class Dispatch {
  current: Current | undefined;
  /** The running turn's whole run, cleanup included. */
  running: Promise<void> = Promise.resolve();
  /** requestId → sha256 of its text, only between ack and the turn existing or being refused. */
  readonly pending = new Map<string, string>();
  private readonly order = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, number>();
  /** Dropped for too many frames: the rest of its frames do nothing until the relay's close. */
  private readonly flooded = new Set<string>();
  /** Which link connection the frames came over: a frame from an earlier one does nothing. */
  private generation = 0;
  private readonly epoch: string;

  constructor(private readonly d: DispatchDeps) {
    this.epoch = store.readEpoch(d.db);
  }

  get registry(): Registry {
    return this.d.hub.registry;
  }

  /**
   * One connection's frames in the order they came: its first message must not overtake the
   * open still being verified. Other connections do not wait for it.
   */
  onFrame(frame: FrameToLocal): Promise<void> {
    if (frame.t === "probe") return Promise.resolve();
    const { conn } = frame;
    if (this.flooded.has(conn)) {
      if (frame.t === "close") this.flooded.delete(conn);
      return Promise.resolve();
    }
    const queued = (this.queued.get(conn) ?? 0) + 1;
    if (queued > QUEUE_FRAMES) {
      this.flood(conn);
      return Promise.resolve();
    }
    this.queued.set(conn, queued);
    const gen = this.generation;
    const next = (this.order.get(conn) ?? Promise.resolve()).then(() =>
      gen === this.generation && !this.flooded.has(conn) ? this.handle(frame, gen) : undefined,
    );
    this.order.set(conn, next);
    void next.then(() => {
      const left = (this.queued.get(conn) ?? 1) - 1;
      if (left > 0) this.queued.set(conn, left);
      else this.queued.delete(conn);
      if (this.order.get(conn) === next) this.order.delete(conn);
    });
    return next;
  }

  private flood(conn: string): void {
    this.flooded.add(conn);
    this.registry.remove(conn);
    this.d.log.log("conn", {
      state: "closed",
      connId: store.shortId(conn),
      code: DROP.flood,
      count: QUEUE_FRAMES,
    });
    this.d.sendFrame({ t: "drop", conn, code: DROP.flood });
    this.d.changed();
  }

  /**
   * The link connected again or went away: the relay's connections from before are not ours,
   * including an open still being checked and the frames queued behind it.
   */
  reset(): void {
    this.generation++;
    this.order.clear();
    this.queued.clear();
    this.flooded.clear();
    this.registry.clear();
  }

  /** A malformed frame or a failing handler is logged, never the end of the process. */
  private async handle(frame: Exclude<FrameToLocal, { t: "probe" }>, gen: number): Promise<void> {
    try {
      if (frame.t === "open") await this.open(frame, gen);
      else if (frame.t === "close") {
        this.registry.remove(frame.conn);
        this.d.log.log("conn", { state: "closed", connId: store.shortId(frame.conn) });
        this.d.changed();
      } else await this.message(frame.conn, frame.m);
    } catch (err) {
      const kind = frame.t === "msg" ? checkClient(frame.m) : undefined;
      this.d.log.log("warning", {
        connId: store.shortId(frame.conn),
        frame: frame.t,
        ...(kind?.ok === true ? { kind: kind.value.kind } : {}),
        ...errorName(err),
      });
    }
  }

  private async open(f: Extract<FrameToLocal, { t: "open" }>, gen: number): Promise<void> {
    const verdict = await this.d.verifier.verify(f.jwt);
    if (gen !== this.generation) return;
    const connId = store.shortId(f.conn);
    this.d.changed();
    if (!verdict.ok) {
      this.d.log.log("conn", { state: "rejected", connId });
      // Keys that cannot be fetched are not a failed login: the page says so differently.
      return this.d.sendFrame({
        t: "drop",
        conn: f.conn,
        code: verdict.reason === "keys_unavailable" ? DROP.keys : DROP.auth,
      });
    }
    this.registry.add({
      conn: f.conn,
      exp: verdict.exp,
      ...(f.country === undefined ? {} : { country: f.country }),
      ...(f.ua === undefined ? {} : { ua: f.ua }),
    });
    // How long the login lasts, to confirm at setup that Access's session length took effect.
    this.d.log.log("conn", {
      state: "open",
      connId,
      ms: Math.max(0, verdict.exp - this.d.now()),
    });
    this.d.hub.notifier.browserConnected({
      ...(f.country === undefined ? {} : { country: f.country }),
      ...(f.ua === undefined ? {} : { ua: f.ua }),
    });
  }

  private reply(
    conn: string,
    kind: "nack",
    reason: NackReason,
    re?: string,
    need?: "client" | "local",
  ): void {
    this.d.hub.send(
      conn,
      message(
        this.d.hub,
        kind,
        { reason, ...(need === undefined ? {} : { need }) },
        re === undefined ? {} : { re },
      ),
    );
  }

  private async message(conn: string, raw: unknown): Promise<void> {
    const reg = this.registry.get(conn);
    const re = idOf(raw);
    if (reg === undefined) {
      // Not one this machine checked: it gets nothing but the refusal.
      this.d.sendFrame({
        t: "msg",
        to: conn,
        m: {
          v: PROTOCOL_VERSION,
          id: this.d.hub.newId(),
          kind: "nack",
          ...(re === undefined ? {} : { re }),
          p: { reason: "not_allowed" },
        },
      });
      this.d.sendFrame({ t: "drop", conn, code: DROP.auth });
      return;
    }
    const parsed = checkClient(raw);
    if (!parsed.ok) {
      const v = (raw as { v?: unknown } | null)?.v;
      const need = typeof v === "number" && v > PROTOCOL_VERSION ? "local" : "client";
      return this.reply(
        conn,
        "nack",
        parsed.reason,
        re,
        parsed.reason === "version" ? need : undefined,
      );
    }
    const m = parsed.value;
    if (m.kind === "hello") return this.hello(conn, m);
    if (!reg.hello) return this.reply(conn, "nack", "version", m.id, "client");
    switch (m.kind) {
      case "conv.list":
        return this.d.hub.send(
          conn,
          message(
            this.d.hub,
            "conv.list.result",
            { convs: store.listConversations(this.d.db).slice(0, CONV_LIST).map(wireConv) },
            { re: m.id },
          ),
        );
      case "conv.open":
        return this.snapshot(conn, m);
      case "turn.submit":
        return this.submit(conn, m);
      case "turn.abort":
        if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
        // A new conversation's id is known once the turn started.
        if (
          this.current !== undefined &&
          (this.current.frontend.convId ?? this.current.convId) === m.conv
        )
          this.current.controller.abort();
        return this.d.hub.send(conn, message(this.d.hub, "ack", {}, { re: m.id }));
      case "approval.decide":
        if (this.current === undefined) {
          if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
          return this.reply(conn, "nack", "already_decided", m.id);
        }
        return this.current.frontend.decide(conn, m, (out) => this.d.hub.send(conn, out));
      case "status.get":
        return this.d.hub.send(conn, await this.status(m.id));
    }
  }

  private async hello(conn: string, m: Of<"hello">): Promise<void> {
    const reg = this.registry.get(conn);
    if (reg === undefined) return;
    this.d.hub.send(
      conn,
      message(this.d.hub, "hello", { epoch: this.epoch, tars: this.d.version }, { re: m.id }),
    );
    // Only after its own hello: a broadcast before it went to the ready ones, not to this one.
    reg.hello = true;
    this.d.hub.send(conn, await this.status());
    for (const a of approvals.listPending(this.d.db))
      this.d.hub.send(
        conn,
        message(this.d.hub, "approval.request", {
          approval: wireApproval(a),
        }),
      );
  }

  /**
   * The newest items that fit: the running text's bytes come off SNAPSHOT_BYTES first, then
   * items go in newest first until the budget or SNAPSHOT_ITEMS runs out.
   */
  private snapshot(conn: string, m: Of<"conv.open">): void {
    let conv: store.Conversation;
    try {
      conv = store.getConversation(this.d.db, m.conv);
    } catch {
      return this.reply(conn, "nack", "not_found", m.id);
    }
    const reg = this.registry.get(conn);
    if (reg !== undefined) reg.subscribed = conv.id;
    const c = this.current;
    const live =
      c?.frontend.convId === conv.id && c.frontend.turnId !== undefined ? c.frontend : undefined;
    const running =
      live === undefined || m.p.before !== undefined
        ? undefined
        : wireRunning(live.turnId as string, live.running);
    let budget = SNAPSHOT_BYTES - (running === undefined ? 0 : wireBytes(running));
    const page = store.readItemsPage(this.d.db, conv.id, {
      ...(m.p.before === undefined ? {} : { before: m.p.before }),
      limit: SNAPSHOT_ITEMS,
    });
    const kept: WireItem[] = [];
    let more = page.more;
    for (const item of page.items.toReversed()) {
      const wire = toWire(item, (id) => this.d.hub.usageOf(id));
      if (wire === undefined) continue;
      const bytes = wireBytes(wire) + 1;
      if (bytes > budget) {
        more = true;
        break;
      }
      budget -= bytes;
      kept.push(wire);
    }
    this.d.hub.send(
      conn,
      message(
        this.d.hub,
        "conv.snapshot",
        {
          epoch: this.epoch,
          items: kept.toReversed(),
          more,
          ...(running === undefined ? {} : { running }),
        },
        { conv: conv.id, re: m.id },
      ),
    );
  }

  private ack(conn: string, re: string, turn?: string): void {
    this.d.hub.send(conn, message(this.d.hub, "ack", turn === undefined ? {} : { turn }, { re }));
  }

  private async submit(conn: string, m: Of<"turn.submit">): Promise<void> {
    if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
    let conv: store.Conversation | undefined;
    if (m.conv !== undefined)
      try {
        conv = store.getConversation(this.d.db, m.conv);
      } catch {
        return this.reply(conn, "nack", "not_found", m.id);
      }
    const { requestId, text } = m.p;
    const hash = sha256(text);
    // A resend: the table while the turn is not there yet, then the database.
    const held = this.pending.get(requestId);
    if (held !== undefined)
      return held === hash ? this.ack(conn, m.id) : this.reply(conn, "nack", "bad_message", m.id);
    const turn = store.findTurnByRequest(this.d.db, requestId);
    if (turn !== undefined) {
      const sent = store
        .readItems(this.d.db, turn.convId)
        .find((i) => i.turnId === turn.id && i.kind === "user" && i.body.carriedFrom === undefined);
      return sent?.kind === "user" && sent.body.text === text
        ? this.ack(conn, m.id, turn.id)
        : this.reply(conn, "nack", "bad_message", m.id);
    }
    if (this.current !== undefined) return this.reply(conn, "nack", "busy", m.id);

    this.pending.set(requestId, hash);
    const controller = new AbortController();
    const frontend = new RemoteFrontend(this.d.hub, conn, requestId, () =>
      this.pending.delete(requestId),
    );
    const current: Current = { requestId, convId: conv?.id, frontend, controller };
    this.current = current;
    this.d.changed();
    this.ack(conn, m.id);
    // In the background: the next message (an approval, an abort) must not wait for this turn.
    this.running = this.run(conn, current, text, conv).catch((err) =>
      this.d.log.log("warning", {
        connId: store.shortId(conn),
        kind: "turn.submit",
        ...errorName(err),
      }),
    );
  }

  private async run(
    conn: string,
    current: Current,
    text: string,
    conv: store.Conversation | undefined,
  ): Promise<void> {
    const { requestId, frontend, controller } = current;
    try {
      await this.d.hub.notifier.idle();
      const config = await this.d.config();
      let input: TurnInput;
      if (conv !== undefined)
        input = {
          convId: conv.id,
          provider: conv.provider,
          model: conv.model,
          effort: conv.effort,
          text,
          requestId,
        };
      else {
        const start = defaultStart(config, await loadCatalog(this.d.paths));
        if (!start.ok) {
          this.pending.delete(requestId);
          return this.rejected(conn, requestId, start.reason);
        }
        input = {
          provider: start.provider,
          model: start.model,
          effort: start.effort,
          text,
          requestId,
        };
      }
      let out;
      try {
        out = await this.d.engine.runTurn(input, frontend, controller.signal);
      } catch {
        if (frontend.turnId === undefined) this.pending.delete(requestId);
        this.d.hub.send(
          conn,
          message(
            this.d.hub,
            "turn",
            { requestId, state: "failed" },
            frontend.convId === undefined ? {} : { conv: frontend.convId },
          ),
        );
        return;
      }
      if (out.kind === "rejected") {
        this.pending.delete(requestId);
        return this.rejected(conn, requestId, out.reason, conv?.id);
      }
      await Promise.race([
        this.d.reconcile(input.provider).catch(() => undefined),
        this.d.sleep(RECONCILE_WAIT_MS),
      ]);
    } finally {
      frontend.dispose();
      if (this.current === current) this.current = undefined;
      this.d.changed();
      const status = await this.status().catch(() => undefined);
      if (status !== undefined)
        broadcast(this.d.hub, () => ({ ...status, id: this.d.hub.newId() }) as ServerMessage);
      this.d.hub.notifier.poke();
    }
  }

  private rejected(conn: string, requestId: string, reason: string, conv?: string): void {
    this.d.hub.send(
      conn,
      message(
        this.d.hub,
        "turn",
        { requestId, state: "rejected", reason: reason.slice(0, 64) },
        conv === undefined ? {} : { conv },
      ),
    );
  }

  /** Money as the books say now, by the local end's clock: the page counts down with it. */
  async status(re?: string): Promise<ServerMessage> {
    const config = await this.d.config();
    const now = new Date(this.d.now());
    const providers = budgetStatuses(config, this.d.db, now, this.d.paths).slice(0, 8);
    const body: WireStatus = {
      now: now.getTime(),
      providers: providers.map((b) => ({
        name: b.provider,
        spentUsd: b.spentUsd,
        quotaUsd: b.quotaUsd,
        warnUsd: b.warnUsd,
        stopUsd: b.stopUsd,
        stopped: b.state === "stopped",
      })),
      pricesWarn: await this.pricesWarn(config, now),
      pendingApprovals: approvals.listPending(this.d.db).length,
      turnRunning: this.current !== undefined,
      notify: this.d.hub.notifier.configured ? "ok" : "not_configured",
    };
    return message(this.d.hub, "status", body, re === undefined ? {} : { re });
  }

  /** For the model a new conversation would use. */
  private async pricesWarn(config: TarsConfig, now: Date): Promise<boolean> {
    let catalog: Catalog;
    try {
      catalog = await loadCatalog(this.d.paths);
    } catch {
      return false;
    }
    const start = defaultStart(config, catalog);
    if (!start.ok) return false;
    const r = resolve(catalog, start.provider, start.model, config.limits, now);
    return r.ok && r.warn === "prices_warn";
  }

  /** SIGINT, SIGTERM: stop the running turn and wait for it, at most `ms`. */
  async stop(ms: number): Promise<void> {
    const c = this.current;
    if (c === undefined) return;
    c.controller.abort();
    await Promise.race([this.running, this.d.sleep(ms)]);
  }
}

const errorName = (err: unknown) => {
  const name = err instanceof Error ? err.name.slice(0, 32) : undefined;
  return name !== undefined && /^\w+$/.test(name) ? { errorName: name } : {};
};

/** A refused message's id, to answer it with, when it has a usable one. */
function idOf(raw: unknown): string | undefined {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 && id.length <= ID_CHARS ? id : undefined;
}
