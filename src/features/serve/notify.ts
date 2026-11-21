import type { NotifyConfig } from "../agent/config.ts";
import type { Log } from "../agent/log.ts";
import { shortId } from "../agent/store.ts";
import type { ApprovalRecord } from "../agent/types.ts";
import type { Timers } from "./access.ts";

/** A notification's child is killed after this; askApproval and a turn wait at most this long. */
export const NOTIFY_TIMEOUT_MS = 15_000;
const BATCH_MS = 60_000;
const REPLACED_EVERY_MS = 60 * 60 * 1000;
const ORIGIN_CHARS = 60;

export type NotifyKind = "approval" | "connect" | "replaced";

export interface NotifyDeps {
  /** undefined: not configured, or the script or its key is missing (checked at start). */
  readonly config: NotifyConfig | undefined;
  /** Runs `tars script run <script> -- <args>` with NOTIFY_TIMEOUT_MS; resolves to its exit. */
  run(argv: readonly string[]): Promise<number>;
  now(): number;
  readonly timers: Timers;
  readonly log: Log;
  /** A turn is running: a new-connection notification is skipped then. */
  turnRunning(): boolean;
  /** A turn is running and not waiting for an approval: a tool's child may be running. */
  turnMayRunTool(): boolean;
}

// C0 and C1 controls and the characters that hide or reorder text.
// oxlint-disable-next-line no-control-regex -- removing them is the point
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/** Only printable characters, at most 60: the origin comes from the open frame. */
export const originText = (s: string | undefined) =>
  (s ?? "").replace(HIDDEN, "").slice(0, ORIGIN_CHARS) || "不明";

export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes} 分鐘` : `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分鐘`;
}

interface Origin {
  readonly country?: string;
  readonly ua?: string;
}

/**
 * The three notifications, each from a fixed template: no argv, no conversation text. One child
 * at a time, in order, since the script runner is not re-entrant; and none while a tool's child
 * may be running, which this side cannot see (S3-10).
 */
export class Notifier {
  private chain: Promise<void> = Promise.resolve();
  private batches = new Map<"connect" | "reconnect", { origins: Origin[]; timer: unknown }>();
  private linkConnectedAt = -Infinity;
  private replaced: { since: number; sentAt?: number; pending: boolean } | undefined;

  constructor(private readonly d: NotifyDeps) {}

  get configured(): boolean {
    return this.d.config !== undefined;
  }

  /** Resolves once no notification is running or queued. */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(kind: NotifyKind, title: string, body: string, gate: () => boolean = () => true) {
    const job = this.chain.then(async () => {
      if (!gate()) return this.d.log.log("notify", { notifyKind: kind, state: "skipped" });
      await this.send(kind, title, body);
    });
    this.chain = job.then(() => undefined);
    return job;
  }

  /** Whether it went out; a failure is logged and never reaches the caller. */
  private async send(kind: NotifyKind, title: string, body: string): Promise<boolean> {
    const cfg = this.d.config;
    if (cfg === undefined) return false;
    const args = cfg.args.map((a) => (a === "{title}" ? title : a === "{body}" ? body : a));
    const started = this.d.now();
    let exit: number;
    try {
      exit = await this.d.run(["script", "run", cfg.script, "--", ...args]);
    } catch {
      exit = -1;
    }
    const ok = exit === 0;
    this.d.log.log("notify", {
      notifyKind: kind,
      state: ok ? "ok" : "failed",
      exit,
      ms: this.d.now() - started,
    });
    return ok;
  }

  /** Waiting for an approval no tool runs, so it goes at once, behind any notification running. */
  approval(a: ApprovalRecord): Promise<void> {
    if (!this.configured) return Promise.resolve();
    return this.enqueue(
      "approval",
      "TARS 等待核准",
      `執行腳本 ${a.fields.script}（${shortId(a.id)}）`,
    );
  }

  linkConnected(): void {
    this.linkConnectedAt = this.d.now();
    this.replaced = undefined;
  }

  /**
   * A browser that passed the checks. Those within 60 s make one notification. In the 60 s after
   * the local end connects the relay makes every browser reconnect; that wave gets its own words,
   * not none, since someone could slip in with it.
   */
  browserConnected(origin: Origin): void {
    if (this.d.config?.on_connect !== true) return;
    const sinceLink = this.d.now() - this.linkConnectedAt;
    const kind = sinceLink < BATCH_MS ? "reconnect" : "connect";
    const batch = this.batches.get(kind);
    if (batch !== undefined) {
      batch.origins.push(origin);
      return;
    }
    const wait = kind === "reconnect" ? BATCH_MS - sinceLink : BATCH_MS;
    const origins = [origin];
    const timer = this.d.timers.setTimeout(() => {
      this.batches.delete(kind);
      const last = origins.at(-1) ?? {};
      const where = `${originText(last.country)}；${originText(last.ua)}`;
      const body =
        kind === "reconnect"
          ? `本機端重新連線後恢復 ${origins.length} 條連線；${where}`
          : `${origins.length} 條；${where}`;
      void this.enqueue("connect", "TARS 有新的連線", body, () => !this.d.turnRunning());
    }, wait);
    this.batches.set(kind, { origins, timer });
  }

  /**
   * Each time the link is closed as replaced (every retry included). Sent once, again after an
   * hour, and on the next retry after a failure; never skipped, only put off while a tool's
   * child may be running.
   */
  replacedAgain(since: number): void {
    if (!this.configured) return;
    const r = (this.replaced ??= { since, pending: false });
    if (r.sentAt === undefined || this.d.now() - r.sentAt >= REPLACED_EVERY_MS) r.pending = true;
    this.poke();
  }

  get replacedNotified(): boolean {
    return this.replaced?.sentAt !== undefined;
  }

  /** Call when a turn ends or starts waiting for an approval: a put-off notification may go. */
  poke(): void {
    const r = this.replaced;
    if (r === undefined || !r.pending || this.d.turnMayRunTool()) return;
    r.pending = false;
    const body = `請檢查憑證。已持續 ${durationText(this.d.now() - r.since)}`;
    this.chain = this.chain.then(async () => {
      if (this.d.turnMayRunTool()) {
        r.pending = true;
        return;
      }
      if (await this.send("replaced", "TARS 的本機端連線被另一台取代", body)) {
        if (this.replaced === r) r.sentAt = this.d.now();
      } else r.pending = true;
    });
  }

  dispose(): void {
    for (const b of this.batches.values()) this.d.timers.clearTimeout(b.timer);
    this.batches.clear();
  }
}
