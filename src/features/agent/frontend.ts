import type {
  ApprovalRecord,
  ApprovalState,
  Effort,
  Item,
  NoticeCode,
  ReasonData,
  TurnState,
  Usage,
  UserItem,
} from "./types.ts";

export type FrontendEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "thinking" }
  | { readonly type: "item"; readonly item: Item }
  /**
   * The turn's row and its user items are written. `items` is what that transaction wrote: the
   * carried text when continuing, then the message; never the wiki index. The loop sends no item
   * event for the message, since a terminal owner typed it, but another device has not seen it.
   */
  | {
      readonly type: "turn_start";
      readonly convId: string;
      readonly turnId: string;
      readonly items: readonly UserItem[];
    }
  /** After the transaction that settled the approval and its tool call. */
  | {
      readonly type: "approval_resolved";
      readonly approvalId: string;
      readonly state: Exclude<ApprovalState, "pending">;
      readonly via: Frontend["via"] | "timeout" | "abort";
      /** When it was settled, by this machine's clock. */
      readonly at: number;
    }
  | {
      readonly type: "notice";
      readonly code: NoticeCode;
      readonly data?: Readonly<Record<string, string | number>>;
    }
  | {
      readonly type: "turn_end";
      readonly state: TurnState;
      readonly reason?: string;
      readonly detail?: string;
      /** The figures behind reason, as the error item holds them. */
      readonly data?: ReasonData;
      readonly costUsd: number;
      /** The sum over the turn's finalized requests. */
      readonly usage: Usage;
      readonly requests: number;
      readonly effort?: Effort;
    };

/** What the loop talks to: the terminal in S1, the remote page in S3. */
export interface Frontend {
  /** Where an answer from askApproval came from; recorded as the approval's decided_via. */
  readonly via: "tty" | "remote";
  emit(event: FrontendEvent): void;
  /** Shows the approval card and waits for the answer; "cancelled" when the signal fires. */
  askApproval(
    approval: ApprovalRecord,
    signal: AbortSignal,
  ): Promise<"approved" | "denied" | "cancelled">;
}
