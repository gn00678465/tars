import type { ServerMessage } from "@tars/protocol";
import { Registry, type Timers } from "../../../src/features/serve/access.ts";
import { Notifier, type NotifyDeps } from "../../../src/features/serve/notify.ts";
import type { Hub } from "../../../src/features/serve/remote-frontend.ts";
import type { Log, LogEvent, LogFields } from "../../../src/features/agent/log.ts";
import type { ApprovalRecord } from "../../../src/features/agent/types.ts";

/** Timers the test moves by hand; nothing fires until advance() passes its time. */
export interface ManualTimers extends Timers {
  now(): number;
  advance(ms: number): void;
  pending(): number;
}

export function manualTimers(start = 1_800_000_000_000): ManualTimers {
  let t = start;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = next++;
      queue.set(id, { at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) {
      queue.delete(h as number);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, e]) => e.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        queue.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
    pending: () => queue.size,
  };
}

export interface RecordedLog extends Log {
  readonly lines: { event: LogEvent; fields: LogFields }[];
}

export const recordedLog = (): RecordedLog => {
  const lines: RecordedLog["lines"] = [];
  return { lines, log: (event, fields) => void lines.push({ event, fields }) };
};

export interface TestHub extends Hub {
  readonly sent: { conn: string; m: ServerMessage }[];
  /** What one connection got, by kind. */
  to(conn: string, kind?: ServerMessage["kind"]): ServerMessage[];
  readonly drops: string[];
}

/** A hub over a real Registry; what would go to the relay is recorded. */
export function testHub(opts: {
  timers: ManualTimers;
  notify?: Partial<NotifyDeps>;
  log?: Log;
}): TestHub {
  const sent: TestHub["sent"] = [];
  const drops: string[] = [];
  const registry = new Registry(opts.timers, opts.timers.now, (conn) => void drops.push(conn));
  let n = 0;
  const notifier = new Notifier({
    config: undefined,
    run: async () => 0,
    now: opts.timers.now,
    timers: opts.timers,
    log: opts.log ?? recordedLog(),
    turnRunning: () => false,
    turnMayRunTool: () => false,
    ...opts.notify,
  });
  return {
    registry,
    timers: opts.timers,
    notifier,
    newId: () => `m-${++n}`,
    usageOf: () => ({ inputTokens: 10, outputTokens: 2, costUsd: 0.01, costSource: "table" }),
    sent,
    drops,
    send(conn, m) {
      if (registry.get(conn) === undefined) return;
      sent.push({ conn, m });
    },
    to: (conn, kind) =>
      sent
        .filter((s) => s.conn === conn && (kind === undefined || s.m.kind === kind))
        .map((s) => s.m),
  };
}

export const CONN_A = "11111111-1111-4111-8111-111111111111";
export const CONN_B = "22222222-2222-4222-8222-222222222222";

/** Registers a connection that has said hello, its login lasting for good. */
export function ready(hub: TestHub, conn: string, subscribed?: string): void {
  hub.registry.add({ conn, exp: Number.MAX_SAFE_INTEGER });
  const reg = hub.registry.get(conn);
  if (reg === undefined) throw new Error("not registered");
  reg.hello = true;
  if (subscribed !== undefined) reg.subscribed = subscribed;
}

export const APPROVAL_ID = "01a1fd71-be41-71e7-809a-4bb1e56800aa";

/** A pending approval for script `notes`, its argv holding text no notification may carry. */
export const approvalRecord = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: APPROVAL_ID,
  toolCallId: "call-1",
  convId: "01a1fd71-be41-71e7-809a-4bb1e56800cc",
  hash: "a".repeat(64),
  state: "pending",
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_300_000,
  fields: {
    action: "run_script",
    script: "notes",
    version: "1",
    summary: "寫筆記",
    effects: "writes",
    domains: ["example.com"],
    secret: null,
    argv: ["--text", "PRIVATE-ARGV"],
    expiresAt: 1_800_000_300_000,
    approvalId: APPROVAL_ID,
  },
  ...over,
});
