import { TarsError } from "../../core/exit.ts";
import type { Io } from "../../core/io.ts";
import type { Terminal } from "../../core/terminal.ts";
import { usd } from "./cost-command.ts";
import { REASON_TEXT } from "./engine.ts";
import type { Frontend, FrontendEvent } from "./frontend.ts";
import { shortId } from "./store.ts";
import {
  totalInputTokens,
  type ApprovalRecord,
  type Item,
  type NoticeCode,
  type ReasonCode,
} from "./types.ts";

type Data = Readonly<Record<string, string | number>>;

const reasonText = (reason: unknown) => REASON_TEXT[reason as ReasonCode] ?? String(reason);

const NOTICE_TEXT: Readonly<Record<NoticeCode, (d: Data) => string>> = {
  compact_start: () => "（上下文接近上限，先壓縮較早的部分）",
  compact_skipped: () => "上下文接近上限，但沒有可以壓縮的部分",
  compact_failed: (d) => `壓縮失敗：${reasonText(d.reason)}`,
  blocked: (d) => `已擋下：${d.reason}`,
  budget_warn: (d) =>
    `本期已用 ${usd(Number(d.spentUsd))} USD，超過提醒門檻（額度 ${usd(Number(d.quotaUsd))} USD）`,
  prices_warn: (d) =>
    `模型價目已 ${d.days} 天沒有確認。到 Console 核對後執行：tars models confirm-prices`,
  context_warn: (d) => `上下文已用 ${d.percent}%（自動壓縮：${d.autoCompact}）`,
  retrying: (d) =>
    `provider 暫時無法回應，${Number(d.waitMs) / 1000} 秒後重試（第 ${d.attempt} 次失敗）`,
  output_capped: (d) => `預算不夠，這次的輸出上限降到 ${d.maxTokens} tokens`,
  effort_unsupported: () => "這個模型不支援推理強度，不送這個參數",
  effort_clamped: (d) => `模型不支援這個推理強度，這個回合用 ${d.effort}`,
  effort_truncated: () => "輸出上限被思考用完，請降低推理強度或調高 max_output_tokens",
  approval_no_tty: () => "沒有終端可以核准，這個動作記為拒絕",
  usage_missing: () => "這個請求沒有回報用量，花費是估的",
};

export const noticeText = (code: NoticeCode, data: Data = {}) => NOTICE_TEXT[code](data);

const RESULT_LINES = 5;

// C0 and C1 controls, DEL, and the format characters that hide or reorder text: any of them in
// a model's or a tool's string could redraw the terminal, so the owner would not see what runs.
// oxlint-disable-next-line no-control-regex -- matching them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;
const NAMED: Readonly<Record<string, string>> = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };
const escapeControl = (c: string) =>
  NAMED[c] ?? `\\u{${(c.codePointAt(0) as number).toString(16)}}`;

/** Text for the terminal: line breaks and tabs stay, every other control is shown as an escape. */
export const visible = (text: string) =>
  text.replace(CONTROL, (c) => (c === "\n" || c === "\t" ? c : escapeControl(c)));

const PLAIN_ARG = /^[\p{L}\p{N}_@%+=:,./-]+$/u;

/**
 * argv as the owner reads it: an argument that is not plain is quoted, with every control
 * (line breaks too) escaped, so two argvs that run differently never print the same.
 */
export const argvText = (argv: readonly string[]) =>
  argv
    .map((a) =>
      PLAIN_ARG.test(a) ? a : `"${a.replace(/["\\]/g, "\\$&").replace(CONTROL, escapeControl)}"`,
    )
    .join(" ");

/** The card the owner approves from: everything the hash covers, in words. */
export function approvalCard(a: ApprovalRecord): string {
  const f = a.fields;
  const line = (text: string) => visible(text).replace(/\n/g, "\\n");
  return [
    "── 需要你核准 ──",
    line(`腳本：${f.script}（版本 ${f.version}）`),
    line(`用途：${f.summary}`),
    line(`影響：${f.effects}`),
    line(`連線：${f.domains.length === 0 ? "（無）" : f.domains.join(", ")}`),
    line(`金鑰：${f.secret ?? "（無）"}`),
    `指令：tars ${argvText(f.argv)}`,
    `期限：${new Date(f.expiresAt).toISOString()}（核准編號 ${shortId(f.approvalId)}）`,
    "",
  ].join("\n");
}

/**
 * The terminal frontend. The reply goes to stdout and everything else to stderr, so
 * `tars chat --message … > reply.txt` keeps only the reply.
 */
export class TtyFrontend implements Frontend {
  readonly via = "tty";
  private thinkingShown = false;
  /** stdout has text not yet ended by a newline. */
  private openLine = false;
  private terminal: Terminal | null | undefined;

  constructor(
    private readonly io: Io,
    /** Throws a TarsError when there is no terminal; called on the first approval only. */
    private readonly openTerminal: () => Terminal,
    /** A usage row's cost, for the compaction line. */
    private readonly costOfUsage: (usageId: number) => number,
  ) {}

  emit(e: FrontendEvent): void {
    if (e.type === "delta") {
      if (e.text === "") return;
      // A reply redirected to a file stays byte for byte; on a screen it must not restyle what follows.
      this.io.write(this.io.stdoutIsTty === true ? visible(e.text) : e.text);
      this.openLine = !e.text.endsWith("\n");
      return;
    }
    if (e.type === "thinking") {
      if (!this.thinkingShown) this.err("（思考中）");
      this.thinkingShown = true;
      return;
    }
    if (e.type === "item") return this.item(e.item);
    // The owner typed the message, and answered the approval here.
    if (e.type === "turn_start" || e.type === "approval_resolved") return;
    if (e.type === "notice") return this.err(noticeText(e.code, e.data));
    this.endLine(true);
    const u = e.usage;
    this.err(
      `用量：輸入 ${totalInputTokens(u)}（快取讀 ${u.cacheReadTokens}、寫 ${u.cacheWriteTokens}）、輸出 ${u.outputTokens}（思考 ${u.thinkingTokens}），${e.requests} 個請求，${usd(e.costUsd)} USD`,
    );
    if (e.state === "aborted") this.err("已中止");
    if (e.state === "failed")
      this.err(`失敗：${reasonText(e.reason)}${e.detail === undefined ? "" : `\n${e.detail}`}`);
  }

  private item(item: Item): void {
    if (item.kind === "usage") this.thinkingShown = false;
    else if (item.kind === "tool_call") {
      const input = item.body.input as Record<string, unknown> | null;
      const what =
        item.body.name === "tars" && Array.isArray(input?.argv)
          ? `tars ${argvText(input.argv.map(String))}`
          : `${item.body.name} ${argvText([String(input?.name ?? input?.path ?? "")])}`;
      this.err(`→ ${what}`);
    } else if (item.kind === "tool_result") {
      const head = item.body.text.split("\n").slice(0, RESULT_LINES);
      this.err([`← ${item.body.status}`, ...head.map((l) => `  ${l}`)].join("\n"));
    } else if (item.kind === "compaction") {
      const b = item.body;
      this.err(
        `已壓縮 ${b.replacedCount} 個項目。壓縮前約 ${b.tokensBefore} tokens，花費 ${usd(this.costOfUsage(b.usageId))} USD`,
      );
    }
  }

  /**
   * Ends the reply's line before a diagnostic, so the two streams do not share a screen line. A
   * redirected reply gets its newline only once, at the end of the turn.
   */
  private endLine(turnEnd = false): void {
    if (!this.openLine || (!turnEnd && this.io.stdoutIsTty !== true)) return;
    this.io.write("\n");
    this.openLine = false;
  }

  private err(line: string): void {
    this.endLine();
    this.io.err(visible(line));
  }

  async askApproval(
    approval: ApprovalRecord,
    signal: AbortSignal,
  ): Promise<"approved" | "denied" | "cancelled"> {
    if (this.terminal === undefined) {
      try {
        this.terminal = this.openTerminal();
      } catch {
        this.terminal = null;
      }
    }
    if (this.terminal === null) {
      this.emit({ type: "notice", code: "approval_no_tty" });
      return "denied";
    }
    this.endLine();
    this.terminal.write(approvalCard(approval));
    try {
      const answer = await this.terminal.askAbortable("核准？輸入 yes 或 no：", signal);
      return answer?.trim() === "yes" ? "approved" : "denied";
    } catch (err) {
      if (!(err instanceof TarsError)) throw err;
      return err.message === "cancelled" ? "cancelled" : "denied";
    }
  }

  close(): void {
    this.terminal?.close();
  }
}
