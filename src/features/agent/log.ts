import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderErrorKind } from "./provider.ts";
import type {
  ApprovalState,
  NoticeCode,
  ReasonCode,
  ToolCallState,
  ToolName,
  TurnKind,
  TurnState,
} from "./types.ts";

export type LogEvent =
  | "turn_start"
  | "turn_end"
  | "request"
  | "request_end"
  | "retry"
  | "tool"
  | "approval"
  | "reconcile"
  | "warning"
  /** tars serve: the link connection, a browser connection, a notification. */
  | "link"
  | "conn"
  | "notify";

/**
 * No field takes free text: message bodies, tool input and output, argv, keys and a provider's
 * error detail can never reach the log through this type.
 */
export interface LogFields {
  readonly turn?: string;
  readonly conv?: string;
  /** A script name that passed SLUG. */
  readonly script?: string;
  readonly state?:
    | TurnState
    | ToolCallState
    | ApprovalState
    | "reserved"
    | "final"
    | "estimated"
    | "voided"
    | LinkState
    | "open"
    | "rejected"
    | "closed"
    | "ok"
    | "skipped";
  readonly reason?: ReasonCode;
  readonly turnKind?: TurnKind;
  readonly errorKind?: ProviderErrorKind;
  readonly tool?: ToolName;
  readonly notice?: NoticeCode;
  readonly status?: number;
  readonly step?: number;
  readonly attempt?: number;
  readonly ms?: number;
  readonly bytes?: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly count?: number;
  readonly exit?: number;
  /** A WebSocket close code. */
  readonly code?: number;
  readonly reconnects?: number;
  /** The last 8 characters of a browser connection's id. */
  readonly connId?: string;
  readonly notifyKind?: "approval" | "connect" | "replaced";
}

export type LinkState = "connecting" | "connected" | "keyring" | "replaced";

export interface Log {
  log(event: LogEvent, fields: LogFields): void;
}

const ROTATE_BYTES = 5 * 1024 * 1024;

export function createLog(path: string, now: () => Date = () => new Date()): Log {
  mkdirSync(dirname(path), { recursive: true });
  return {
    log(event, fields) {
      const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      if (size > ROTATE_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, `${JSON.stringify({ at: now().getTime(), event, ...fields })}\n`);
    },
  };
}
