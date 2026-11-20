import type { Effort, Item, NoticeCode, ApprovalRecord, TurnState, Usage } from "./types.ts";

export type FrontendEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "thinking" }
  | { readonly type: "item"; readonly item: Item }
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
      readonly costUsd: number;
      /** The sum over the turn's finalized requests. */
      readonly usage: Usage;
      readonly requests: number;
      readonly effort?: Effort;
    };

/** What the loop talks to: the terminal in S1, the remote page in S3. */
export interface Frontend {
  emit(event: FrontendEvent): void;
  /** Shows the approval card and waits for the answer; "cancelled" when the signal fires. */
  askApproval(
    approval: ApprovalRecord,
    signal: AbortSignal,
  ): Promise<"approved" | "denied" | "cancelled">;
}
