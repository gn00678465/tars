import type { Database } from "bun:sqlite";
import {
  checkClient,
  ID_CHARS,
  MODELS,
  PROTOCOL_VERSION,
  SKILL_TEXT,
  SKILLS,
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
import { findModel, loadCatalog, resolve, type Catalog } from "../agent/catalog.ts";
import { isEffort, supported } from "../agent/effort.ts";
import { defaultStart, modelChoices } from "../agent/start.ts";
import { PROVIDERS, type SecretStore } from "../../core/secrets.ts";
import type { TarsConfig } from "../agent/config.ts";
import { budgetStatuses } from "../agent/cost-command.ts";
import { latestAdjustment, spent } from "../agent/ledger.ts";
import type { Engine, TurnInput } from "../agent/engine.ts";
import type { Log } from "../agent/log.ts";
import { loadSkillIndex } from "../agent/prompt.ts";
import * as store from "../agent/store.ts";
import { formMessage } from "../agent/ui-form.ts";
import type { AccessVerifier, Registry } from "./access.ts";
import { alreadyDecided, broadcast, message, RemoteFrontend, type Hub } from "./remote-frontend.ts";
import { answerWiki, type WikiRequest } from "./wiki.ts";
import type { ReasonData } from "../agent/types.ts";
import { convContext } from "./context.ts";
import { catalogTable, priceWarnings } from "./prices.ts";
import { toWire, wireApproval, wireBytes, wireConv, wireData, wireRunning } from "./wire.ts";

/** Close codes the local end gives a browser connection. */
export const DROP = { auth: 4003, keys: 4004, flood: 4005 } as const;
/**
 * Frames one connection may have waiting. A page sends a few before its hello is answered;
 * more is a page gone wrong, and an unbounded queue would hold its frames in memory.
 */
const QUEUE_FRAMES = 32;
const RECONCILE_WAIT_MS = 5_000;
const CONV_LIST = 500;
/** How long after archiving a conversation the same connection may take it back (the page's toast is shorter). */
const UNARCHIVE_MS = 60_000;
/** How long status keeps the skill list it read (see skills()). */
const SKILLS_TTL_MS = 60_000;

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
  /** The link certificate's expiry (epoch ms), once it was read; undefined before or without. */
  certExpiresAt?(): number | undefined;
  /** The keyring, to tell models.get which providers have a key. */
  readonly secrets: Pick<SecretStore, "get">;
}

interface Current {
  readonly requestId: string;
  readonly convId: string | undefined;
  readonly frontend: RemoteFrontend;
  readonly controller: AbortController;
}

type Of<K extends ClientMessage["kind"]> = Extract<ClientMessage, { kind: K }>;

/** How a turn starts besides its text; uiCall only with a conversation (a sent form). */
interface Start {
  readonly model: { readonly provider: string; readonly id: string } | undefined;
  readonly parent: store.Conversation | undefined;
  readonly keepLast: number | undefined;
  readonly effort: string | undefined;
  readonly uiCall: string | undefined;
}

/**
 * One connection's frames waiting their turn. A cancelled queue never runs again: its frames
 * hold this object, so a later close or a new queue under the same id cannot revive them.
 */
interface Queue {
  tail: Promise<void>;
  size: number;
  cancelled: boolean;
}

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
  private readonly queues = new Map<string, Queue>();
  private readonly epoch: string;
  private skillCache: { at: number; skills: NonNullable<WireStatus["skills"]> } | undefined;

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
    let q = this.queues.get(conn);
    if (q?.cancelled === true) {
      // Dropped already: the relay's close only lets the id start a new queue.
      if (frame.t === "close") this.queues.delete(conn);
      return Promise.resolve();
    }
    if (q === undefined) {
      q = { tail: Promise.resolve(), size: 0, cancelled: false };
      this.queues.set(conn, q);
    }
    if (q.size >= QUEUE_FRAMES) {
      this.flood(conn, q);
      return Promise.resolve();
    }
    const queue = q;
    queue.size++;
    const next = queue.tail.then(() => (queue.cancelled ? undefined : this.handle(frame, queue)));
    queue.tail = next;
    void next.then(() => {
      queue.size--;
      if (queue.size === 0 && !queue.cancelled && this.queues.get(conn) === queue)
        this.queues.delete(conn);
    });
    return next;
  }

  private flood(conn: string, q: Queue): void {
    q.cancelled = true;
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
    for (const q of this.queues.values()) q.cancelled = true;
    this.queues.clear();
    this.registry.clear();
  }

  /** A malformed frame or a failing handler is logged, never the end of the process. */
  private async handle(frame: Exclude<FrameToLocal, { t: "probe" }>, q: Queue): Promise<void> {
    try {
      if (frame.t === "open") await this.open(frame, q);
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

  private async open(f: Extract<FrameToLocal, { t: "open" }>, q: Queue): Promise<void> {
    const verdict = await this.d.verifier.verify(f.jwt);
    // Dropped or reset while the check ran: registering it now would bring it back.
    if (q.cancelled) return;
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
      case "conv.compact":
        return this.compact(conn, m);
      case "conv.archive":
        return this.archive(conn, m);
      case "turn.abort":
        if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
        // A new conversation's id is known once the turn started.
        if (
          this.current !== undefined &&
          (this.current.frontend.convId ?? this.current.convId) === m.conv
        )
          this.current.controller.abort();
        return this.d.hub.send(conn, message(this.d.hub, "ack", {}, { re: m.id }));
      case "ui.submit":
        return this.uiSubmit(conn, m);
      case "approval.decide":
        if (this.current === undefined) {
          if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
          return this.d.hub.send(
            conn,
            alreadyDecided(this.d.hub, m.p.approvalId, { re: m.id }, conn, undefined),
          );
        }
        return this.current.frontend.decide(conn, m, (out) => this.d.hub.send(conn, out));
      case "status.get":
        return this.d.hub.send(conn, await this.status(m.id));
      case "models.get":
        return this.models(conn, m.id);
      case "wiki.status":
      case "wiki.list":
      case "wiki.page":
      case "wiki.search":
      case "wiki.source":
        return this.wiki(conn, m);
    }
  }

  /** The knowledge base, read only and never through a model (serve/wiki.ts). */
  private async wiki(conn: string, m: WikiRequest): Promise<void> {
    if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
    const a = await answerWiki(this.d.paths, m);
    if (a === "newer") return this.reply(conn, "nack", "version", m.id, "local");
    this.d.hub.send(conn, message(this.d.hub, a.kind, a.p, { re: m.id }));
  }

  /** models.get: every active model, usable or why not, as the terminal's /model judges one. */
  private async models(conn: string, re: string): Promise<void> {
    if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", re);
    const catalog = await loadCatalog(this.d.paths);
    const choices = await modelChoices(await this.d.config(), catalog, {
      secrets: this.d.secrets,
      now: () => new Date(this.d.now()),
    });
    const models = choices.slice(0, MODELS).map((c) => ({
      provider: c.provider,
      id: c.id.slice(0, 128),
      label: c.label.slice(0, 128),
      isDefault: c.isDefault,
      ...(c.window === undefined ? {} : { window: c.window }),
      ...(c.unusable === undefined ? {} : { unusable: c.unusable }),
      effortLevels: [...c.effortLevels],
      ...(c.defaultEffort === undefined ? {} : { defaultEffort: c.defaultEffort }),
    }));
    this.d.hub.send(
      conn,
      message(this.d.hub, "models.result", { models, ...catalogTable(catalog) }, { re }),
    );
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
  private async snapshot(conn: string, m: Of<"conv.open">): Promise<void> {
    let conv: store.Conversation;
    try {
      conv = store.getConversation(this.d.db, m.conv);
    } catch {
      return this.reply(conn, "nack", "not_found", m.id);
    }
    if (conv.archivedAt !== undefined) return this.reply(conn, "nack", "conv_archived", m.id);
    const reg = this.registry.get(conn);
    if (reg !== undefined) reg.subscribed = conv.id;
    const c = this.current;
    const live =
      c?.frontend.convId === conv.id && c.frontend.turnId !== undefined ? c.frontend : undefined;
    const compacting =
      m.p.before === undefined && c?.frontend.convId === conv.id && c.frontend.compacting;
    const running =
      live === undefined || m.p.before !== undefined
        ? undefined
        : {
            ...wireRunning(live.turnId as string, live.running),
            ...(live.phase === undefined ? {} : { phase: live.phase }),
          };
    let budget = SNAPSHOT_BYTES - (running === undefined ? 0 : wireBytes(running));
    const page = store.readItemsPage(this.d.db, conv.id, {
      ...(m.p.before === undefined ? {} : { before: m.p.before }),
      limit: SNAPSHOT_ITEMS,
    });
    const kept: WireItem[] = [];
    let more = page.more;
    for (const item of page.items.toReversed()) {
      const wire = toWire(item, this.d.hub.lookup);
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
          ...(compacting ? { compacting: true as const } : {}),
        },
        { conv: conv.id, re: m.id },
      ),
    );
    // An older page of items changes nothing about the context.
    if (m.p.before === undefined) await this.context(conv.id, [conn]);
  }

  /** Who has the conversation open. */
  private subscribers(convId: string): string[] {
    return this.registry
      .ready()
      .filter((r) => r.subscribed === convId)
      .map((r) => r.conn);
  }

  /**
   * conv.context to these connections. Best effort: config.toml or models.json unreadable
   * leaves the page without the ring, and the turn's own checks still stop at the limits.
   */
  private async context(convId: string, to: readonly string[]): Promise<void> {
    if (to.length === 0) return;
    let body;
    try {
      const conv = store.getConversation(this.d.db, convId);
      const config = await this.d.config();
      body = convContext(this.d.db, conv, await loadCatalog(this.d.paths), config.limits);
    } catch {
      return;
    }
    for (const conn of to)
      this.d.hub.send(conn, message(this.d.hub, "conv.context", body, { conv: convId }));
  }

  /**
   * conv.compact: the terminal's /compact from a page. It bills a model request, so it is one
   * at a time with turns (busy), its budget is the ledger's reservation as a turn's is, and
   * turn.abort stops it. A failure or a stop leaves the conversation as it was: compactWith
   * writes the summary only on success.
   */
  private async compact(conn: string, m: Of<"conv.compact">): Promise<void> {
    if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
    if (this.current !== undefined) return this.reply(conn, "nack", "busy", m.id);
    try {
      if (store.getConversation(this.d.db, m.conv).archivedAt !== undefined)
        return this.reply(conn, "nack", "conv_archived", m.id);
    } catch {
      return this.reply(conn, "nack", "not_found", m.id);
    }
    const controller = new AbortController();
    const frontend = new RemoteFrontend(this.d.hub, conn, m.id, () => undefined);
    frontend.convId = m.conv;
    // From the ack: a page that reloads before the request goes out still sees it.
    frontend.compacting = true;
    const current: Current = { requestId: m.id, convId: m.conv, frontend, controller };
    this.current = current;
    this.d.changed();
    this.ack(conn, m.id);
    const reg = this.registry.get(conn);
    if (reg !== undefined) reg.subscribed = m.conv;
    const tell = (p: Extract<ServerMessage, { kind: "compact" }>["p"]) => {
      for (const c of this.subscribers(m.conv))
        this.d.hub.send(c, message(this.d.hub, "compact", p, { conv: m.conv }));
    };
    tell({ state: "started" });
    this.running = (async () => {
      try {
        await this.d.hub.notifier.idle();
        const out = await this.d.engine.compact(
          m.conv,
          { trigger: "manual", ...(m.p.focus === undefined ? {} : { focus: m.p.focus }) },
          frontend,
          controller.signal,
        );
        tell(
          out.kind === "compacted"
            ? { state: "completed" }
            : out.kind === "failed"
              ? {
                  state: "failed",
                  reason: out.reason.slice(0, 64),
                  ...(out.data === undefined ? {} : { data: wireData(out.data) }),
                }
              : { state: out.kind },
        );
      } catch (err) {
        tell({ state: "failed" });
        this.d.log.log("warning", {
          connId: store.shortId(conn),
          kind: "conv.compact",
          ...errorName(err),
        });
      } finally {
        frontend.dispose();
        if (this.current === current) this.current = undefined;
        this.d.changed();
        await this.context(m.conv, this.subscribers(m.conv));
        const status = await this.status().catch(() => undefined);
        if (status !== undefined)
          broadcast(this.d.hub, () => ({ ...status, id: this.d.hub.newId() }) as ServerMessage);
        this.d.hub.notifier.poke();
      }
    })();
  }

  /**
   * conv.archive. Archiving asks the database (a running turn, a compaction, a pending approval)
   * and this.current, which knows a turn accepted before its row exists. Taking it back only
   * works for what this connection archived last and a minute ago at most.
   */
  private archive(conn: string, m: Of<"conv.archive">): void {
    if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
    const reg = this.registry.get(conn);
    let conv: store.Conversation;
    try {
      conv = store.getConversation(this.d.db, m.conv);
    } catch {
      return this.reply(conn, "nack", "not_found", m.id);
    }
    const now = this.d.now();
    if (m.p.archived) {
      if (conv.archivedAt !== undefined) return this.ack(conn, m.id);
      const c = this.current;
      if (c !== undefined && (c.frontend.convId ?? c.convId) === m.conv)
        return this.reply(conn, "nack", "conv_active", m.id);
      if (store.archiveConversation(this.d.db, m.conv, now) !== "archived")
        return this.reply(conn, "nack", "conv_active", m.id);
      if (reg !== undefined) reg.lastArchived = { conv: m.conv, at: now };
      for (const c of this.subscribers(m.conv))
        this.d.hub.send(
          c,
          message(
            this.d.hub,
            "notice",
            { code: "conv_archived", data: { conv: m.conv } },
            { conv: m.conv },
          ),
        );
    } else {
      const last = reg?.lastArchived;
      if (reg === undefined || last?.conv !== m.conv || now - last.at > UNARCHIVE_MS)
        return this.reply(conn, "nack", "not_allowed", m.id);
      store.unarchiveConversation(this.d.db, m.conv);
      reg.lastArchived = undefined;
    }
    this.ack(conn, m.id);
    const convs = store.listConversations(this.d.db).slice(0, CONV_LIST).map(wireConv);
    broadcast(this.d.hub, () => message(this.d.hub, "conv.list.result", { convs }));
  }

  /** With the turn and its conversation once it exists: enough for a page that missed its start. */
  private ack(conn: string, re: string, turn?: { id: string; convId: string }): void {
    this.d.hub.send(
      conn,
      message(
        this.d.hub,
        "ack",
        turn === undefined ? {} : { turn: turn.id },
        turn === undefined ? { re } : { re, conv: turn.convId },
      ),
    );
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
    if (conv?.archivedAt !== undefined) return this.reply(conn, "nack", "conv_archived", m.id);
    const { requestId, text } = m.p;
    // A conversation's model is its own (D17): another model is a new conversation, continued
    // from it if the page says so.
    if (conv !== undefined && (m.p.model !== undefined || m.p.from !== undefined))
      return this.reply(conn, "nack", "bad_message", m.id);
    let parent: store.Conversation | undefined;
    if (m.p.from !== undefined)
      try {
        parent = store.getConversation(this.d.db, m.p.from);
      } catch {
        return this.reply(conn, "nack", "not_found", m.id);
      }
    if (parent?.archivedAt !== undefined) return this.reply(conn, "nack", "conv_archived", m.id);
    // What a resend must match: the text, the model and the conversation it continues, the level.
    const hash = sha256(
      JSON.stringify([
        text,
        m.p.model ?? null,
        m.p.from ?? null,
        m.p.keepLast ?? null,
        m.p.effort ?? null,
      ]),
    );
    // A resend: the table while the turn is not there yet, then the database.
    const held = this.pending.get(requestId);
    if (held !== undefined)
      return held === hash ? this.ack(conn, m.id) : this.reply(conn, "nack", "bad_message", m.id);
    const turn = store.findTurnByRequest(this.d.db, requestId);
    if (turn !== undefined) {
      const sent = store
        .readItems(this.d.db, turn.convId)
        .find((i) => i.turnId === turn.id && i.kind === "user" && i.body.carriedFrom === undefined);
      const made = store.getConversation(this.d.db, turn.convId);
      const same =
        (m.p.model === undefined ||
          (made.provider === m.p.model.provider && made.model === m.p.model.id)) &&
        (m.p.from === undefined || made.parentId === m.p.from);
      return sent?.kind === "user" && sent.body.text === text && same
        ? this.ack(conn, m.id, turn)
        : this.reply(conn, "nack", "bad_message", m.id);
    }
    if (this.current !== undefined) return this.reply(conn, "nack", "busy", m.id);
    this.start(conn, m.id, requestId, hash, conv, text, {
      model: m.p.model,
      parent,
      keepLast: m.p.keepLast,
      effort: m.p.effort,
      uiCall: undefined,
    });
  }

  /** Takes the turn: acked now, run in the background (an approval, an abort must not wait). */
  private start(
    conn: string,
    re: string,
    requestId: string,
    hash: string,
    conv: store.Conversation | undefined,
    text: string,
    start: Start,
  ): void {
    this.pending.set(requestId, hash);
    const controller = new AbortController();
    const frontend = new RemoteFrontend(this.d.hub, conn, requestId, () =>
      this.pending.delete(requestId),
    );
    // An existing conversation is known now: the compaction a turn may run before it starts
    // speaks to the pages that have it open (compact_start, a snapshot's compacting).
    if (conv !== undefined) frontend.convId = conv.id;
    const current: Current = { requestId, convId: conv?.id, frontend, controller };
    this.current = current;
    this.d.changed();
    this.ack(conn, re);
    this.running = this.run(conn, current, text, conv, start).catch((err) =>
      this.d.log.log("warning", {
        connId: store.shortId(conn),
        kind: start.uiCall === undefined ? "turn.submit" : "ui.submit",
        ...errorName(err),
      }),
    );
  }

  /**
   * A form the owner sent: its values become one message and a turn, as turn.submit's text does.
   * Taken once per form; the accounts are checked against the form as stored, not the browser's.
   * No approval is read or written here: a write still asks for its own.
   */
  private uiSubmit(conn: string, m: Of<"ui.submit">): void {
    if (!this.registry.valid(conn)) return this.reply(conn, "nack", "auth_expired", m.id);
    let conv: store.Conversation;
    try {
      conv = store.getConversation(this.d.db, m.conv);
    } catch {
      return this.reply(conn, "nack", "not_found", m.id);
    }
    if (conv.archivedAt !== undefined) return this.reply(conn, "nack", "conv_archived", m.id);
    const { requestId, callId, context } = m.p;
    const items = store.readItems(this.d.db, conv.id);
    const call = items.find(
      (i) => i.kind === "tool_call" && i.body.callId === callId && i.body.name === "ui_show",
    );
    const shown = items.some(
      (i) => i.kind === "tool_result" && i.body.callId === callId && i.body.status === "done",
    );
    if (call?.kind !== "tool_call" || !shown) return this.reply(conn, "nack", "not_found", m.id);
    const form = formMessage(call.body.input, context);
    if (!form.ok) return this.reply(conn, "nack", "bad_message", m.id);
    const hash = sha256(JSON.stringify(["ui.submit", callId, form.text]));
    const held = this.pending.get(requestId);
    if (held !== undefined)
      return held === hash ? this.ack(conn, m.id) : this.reply(conn, "nack", "bad_message", m.id);
    const turn = store.findTurnByRequest(this.d.db, requestId);
    if (turn !== undefined) {
      const sent = store
        .readItems(this.d.db, turn.convId)
        .find((i) => i.turnId === turn.id && i.kind === "user");
      return sent?.kind === "user" && sent.body.uiCall === callId && sent.body.text === form.text
        ? this.ack(conn, m.id, turn)
        : this.reply(conn, "nack", "bad_message", m.id);
    }
    if (store.uiCallSent(this.d.db, conv.id, callId))
      return this.reply(conn, "nack", "already_decided", m.id);
    if (this.current !== undefined) return this.reply(conn, "nack", "busy", m.id);
    this.start(conn, m.id, requestId, hash, conv, form.text, {
      model: undefined,
      parent: undefined,
      keepLast: undefined,
      effort: undefined,
      uiCall: callId,
    });
  }

  private async run(
    conn: string,
    current: Current,
    text: string,
    conv: store.Conversation | undefined,
    start: Start,
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
          ...(start.uiCall === undefined ? {} : { uiCall: start.uiCall }),
        };
      else if (start.model !== undefined) {
        // The engine checks the model as for any turn; only a name no provider has stops here.
        const provider = PROVIDERS.find((p) => p === start.model?.provider);
        if (provider === undefined) {
          this.pending.delete(requestId);
          return this.rejected(conn, requestId, "unknown_model");
        }
        input = {
          provider,
          model: start.model.id,
          // A continuation keeps its conversation's level, as the terminal's /model does.
          effort: start.parent?.effort ?? config.chat.effort,
          text,
          requestId,
          ...(start.parent === undefined ? {} : { continueFrom: start.parent.id }),
          ...(start.keepLast === undefined ? {} : { keepLast: start.keepLast }),
        };
      } else {
        const begin = defaultStart(config, await loadCatalog(this.d.paths));
        if (!begin.ok) {
          this.pending.delete(requestId);
          return this.rejected(conn, requestId, begin.reason);
        }
        input = {
          provider: begin.provider,
          model: begin.model,
          effort: begin.effort,
          text,
          requestId,
        };
      }
      if (start.effort !== undefined) {
        // Picked by the owner, so it must be one the model takes, as /effort checks; the engine
        // would quietly move it to the nearest. A model the list lacks is the engine's to refuse.
        const entry = findModel(await loadCatalog(this.d.paths), input.provider, input.model);
        const effort = start.effort;
        if (!isEffort(effort) || (entry !== undefined && !supported(entry).includes(effort))) {
          this.pending.delete(requestId);
          return this.rejected(conn, requestId, "effort_unsupported", conv?.id);
        }
        input = { ...input, effort };
        // Kept from this turn on, as /effort keeps it: a turn the engine then refuses (a budget)
        // does not undo the owner's choice.
        if (conv !== undefined) store.setConversationEffort(this.d.db, conv.id, effort);
      }
      const out = await this.d.engine.runTurn(input, frontend, controller.signal);
      if (out.kind === "rejected") {
        this.pending.delete(requestId);
        // The page gets codes only: which carry failed says what to do next.
        const reason = out.carry === undefined ? out.reason : `carry_${out.carry}`;
        return this.rejected(conn, requestId, reason, conv?.id, out.data);
      }
      await Promise.race([
        this.d.reconcile(input.provider).catch(() => undefined),
        this.d.sleep(RECONCILE_WAIT_MS),
      ]);
    } catch (err) {
      // From anywhere before the turn ended, waiting for a notification and reading config.toml
      // included. The request leaves memory either way, so a resend is answered by the database:
      // run again when there is no turn, acked with it when there is. The failure names that
      // turn as the database has it, since turn_start may not have gone out.
      this.pending.delete(requestId);
      let row: store.TurnRow | undefined;
      try {
        row = store.findTurnByRequest(this.d.db, requestId);
      } catch {
        row = undefined;
      }
      const conv = row?.convId ?? frontend.convId;
      this.d.hub.send(
        conn,
        message(
          this.d.hub,
          "turn",
          { ...(row === undefined ? {} : { turn: row.id }), requestId, state: "failed" },
          conv === undefined ? {} : { conv },
        ),
      );
      this.d.log.log("warning", {
        connId: store.shortId(conn),
        kind: "turn.submit",
        ...errorName(err),
      });
    } finally {
      frontend.dispose();
      if (this.current === current) this.current = undefined;
      this.d.changed();
      const convId = frontend.convId ?? current.convId;
      if (convId !== undefined) await this.context(convId, this.subscribers(convId));
      const status = await this.status().catch(() => undefined);
      if (status !== undefined)
        broadcast(this.d.hub, () => ({ ...status, id: this.d.hub.newId() }) as ServerMessage);
      this.d.hub.notifier.poke();
    }
  }

  private rejected(
    conn: string,
    requestId: string,
    reason: string,
    conv?: string,
    data?: ReasonData,
  ): void {
    this.d.hub.send(
      conn,
      message(
        this.d.hub,
        "turn",
        {
          requestId,
          state: "rejected",
          reason: reason.slice(0, 64),
          ...(data === undefined ? {} : { data: wireData(data) }),
        },
        conv === undefined ? {} : { conv },
      ),
    );
  }

  /** Money as the books say now, by the local end's clock: the page counts down with it. */
  async status(re?: string): Promise<ServerMessage> {
    const config = await this.d.config();
    const now = new Date(this.d.now());
    const providers = budgetStatuses(config, this.d.db, now, this.d.paths).slice(0, 8);
    const catalog = await loadCatalog(this.d.paths).catch(() => undefined);
    const body: WireStatus = {
      now: now.getTime(),
      providers: providers.map((b) => ({
        name: b.provider,
        spentUsd: b.spentUsd,
        quotaUsd: b.quotaUsd,
        warnUsd: b.warnUsd,
        stopUsd: b.stopUsd,
        stopped: b.state === "stopped",
        period: b.period === "utc-month" ? "month" : "cumulative",
        estimated: this.estimated(config, b, now),
      })),
      pricesWarn: catalog === undefined ? false : this.pricesWarn(config, catalog, now),
      ...(catalog === undefined ? {} : priceWarnings(catalog, config.limits, now)),
      pendingApprovals: approvals.listPending(this.d.db).length,
      turnRunning: this.current !== undefined,
      notify: this.d.hub.notifier.configured ? "ok" : "not_configured",
      skills: await this.skills(),
      archive: true,
      ...(this.d.certExpiresAt?.() === undefined
        ? {}
        : { certExpiresAt: this.d.certExpiresAt() as number }),
    };
    return message(this.d.hub, "status", body, re === undefined ? {} : { re });
  }

  /**
   * The / menu's skills, as the terminal's: a description is cut to what the protocol takes.
   * Read at most once per SKILLS_TTL_MS: every page asks for status every PING_MS to show its
   * round trip, and a skill installed or edited may take that long to show. A minute, not the
   * directory's mtime: editing a SKILL.md changes the file's, not the directory's.
   */
  private async skills(): Promise<NonNullable<WireStatus["skills"]>> {
    const now = this.d.now();
    if (this.skillCache !== undefined && now - this.skillCache.at < SKILLS_TTL_MS)
      return this.skillCache.skills;
    const skills = await this.readSkills();
    this.skillCache = { at: now, skills };
    return skills;
  }

  private async readSkills(): Promise<NonNullable<WireStatus["skills"]>> {
    const { skills } = await loadSkillIndex(this.d.paths).catch(() => ({ skills: [] }));
    return skills
      .filter((s) => s.name.length <= ID_CHARS)
      .slice(0, SKILLS)
      .map((s) => ({
        name: s.name,
        description:
          s.description.length > SKILL_TEXT
            ? `${s.description.slice(0, SKILL_TEXT - 1)}…`
            : s.description,
        localOnly: s.localOnly,
      }));
  }

  /**
   * Whether the period's figure is partly this machine's estimate: false only when it is the
   * last tars cost adjust alone, with no usage after it and no wiki sync's share on top.
   */
  private estimated(
    config: TarsConfig,
    b: ReturnType<typeof budgetStatuses>[number],
    now: Date,
  ): boolean {
    const cfg = config.providers[b.provider];
    if (cfg === undefined || (b.wiki?.period ?? 0) > 0) return true;
    const adj = latestAdjustment(this.d.db, b.provider, cfg, now);
    return adj === null || spent(this.d.db, b.provider, cfg, now) !== adj.spentUsd;
  }

  /** For the model a new conversation would use. */
  private pricesWarn(config: TarsConfig, catalog: Catalog, now: Date): boolean {
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
