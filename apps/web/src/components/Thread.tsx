import type { WireItem } from "@tars/protocol";
import { Fragment, type ReactNode, useState } from "react";
import type { Notice, State } from "../state.ts";
import { Icon, Monolith } from "./Icon.tsx";
import { reasonText } from "../reasons.ts";
import { ErrorCard } from "./ErrorCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { effortName } from "./RunSetup.tsx";
import { shortId } from "./time.ts";

const cut = (truncated: boolean) => (truncated ? "（已截斷）" : "");

const ASSISTANT_STATE: Record<string, string> = {
  truncated: "（輸出被截斷）",
  aborted: "（已中止）",
  incomplete: "（不完整）",
};

const TURN_STATE: Record<string, string> = {
  started: "回覆中…",
  completed: "回合完成",
  failed: "回合失敗",
  aborted: "回合已中止",
  rejected: "回合沒有開始",
};

/** ui_spec 5.3: a tool step's six results, as the prototype's tags. */
const RESULT: Record<string, [string, string]> = {
  ok: ["ok", "完成"],
  completed: ["ok", "完成"],
  error: ["error", "失敗"],
  failed: ["error", "失敗"],
  denied: ["error", "已拒絕"],
  expired: ["error", "已過期"],
  cancelled: ["", "已取消"],
  interrupted: ["warn", "中斷（結果不明）"],
  blocked: ["warn", "這個入口不提供"],
};

const OUTPUT_LINES = 20;

type ToolCall = Extract<WireItem, { kind: "tool_call" }>;
type ToolResult = Extract<WireItem, { kind: "tool_result" }>;

function ToolStep({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [tone, label] =
    result === undefined ? ["active", "執行中"] : (RESULT[result.status] ?? ["", result.status]);
  const lines = result === undefined ? [] : result.text.split("\n");
  const shown = full ? lines : lines.slice(0, OUTPUT_LINES);
  return (
    <div className="tool-step">
      <button
        className="tool-step-summary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <div className="tool-step-left">
          <Icon name="terminal" />
          <span>{call.name}</span>
          <span className="tool-step-target">{call.input}</span>
        </div>
        <div className="tool-step-right">
          {result?.exit === undefined ? null : <span className="mono">結束碼 {result.exit}</span>}
          <span className={`sg-tag ${tone}`}>{label}</span>
          <span className="tool-step-chevron">
            <Icon name="chevron" />
          </span>
        </div>
      </button>
      {open ? (
        <div className="tool-step-body">
          <div>
            <div className="tool-kv-label">指令參數{cut(call.truncated)}</div>
            <pre className="tool-code-box">{call.input}</pre>
          </div>
          {result === undefined ? null : (
            <div>
              <div className="tool-kv-label">
                執行輸出（純文字，共 {lines.length} 行）{cut(result.truncated)}
              </div>
              <pre className="tool-code-box">{shown.join("\n")}</pre>
              {lines.length > OUTPUT_LINES ? (
                <div className="btn-chip-row">
                  <button className="sg-btn sg-btn-sm" type="button" onClick={() => setFull(!full)}>
                    {full
                      ? `收合至前 ${OUTPUT_LINES} 行`
                      : `展開其餘 ${lines.length - OUTPUT_LINES} 行`}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What is drawn right after an item: the approval cards that belong to it. */
export type After = (seq: number) => ReactNode;

function Rest({
  items,
  after,
  provider,
}: {
  items: readonly WireItem[];
  after: After;
  provider: string | undefined;
}) {
  const results = new Map(
    items.filter((i): i is ToolResult => i.kind === "tool_result").map((i) => [i.callId, i]),
  );
  return items.map((item) => (
    <Fragment key={item.seq}>
      <One
        item={item}
        result={item.kind === "tool_call" ? results.get(item.callId) : undefined}
        provider={provider}
      />
      {after(item.seq)}
    </Fragment>
  ));
}

function One({
  item,
  result,
  provider,
}: {
  item: WireItem;
  result: ToolResult | undefined;
  provider: string | undefined;
}) {
  switch (item.kind) {
    case "user":
    case "tool_result":
      return null;
    case "carried":
      return (
        <div key={item.seq} className="compaction-meta">
          接續自對話 {shortId(item.from)}
        </div>
      );
    case "assistant":
      return (
        <div key={item.seq} className="msg-assistant-text">
          <Markdown text={item.text} />
          {item.truncated || item.state in ASSISTANT_STATE ? (
            <p>{`${cut(item.truncated)}${ASSISTANT_STATE[item.state] ?? ""}`}</p>
          ) : null}
        </div>
      );
    case "tool_call":
      return <ToolStep key={item.seq} call={item} result={result} />;
    case "usage":
      return (
        <div key={item.seq} className="msg-usage-line mono">
          <span>輸入 {item.inputTokens.toLocaleString("en-US")}</span>
          <span>輸出 {item.outputTokens.toLocaleString("en-US")}</span>
          <span>
            {/* Only a cost the provider reported is exact; table and estimate are tars's own. */}
            {item.costUsd.toFixed(4)} USD{item.costSource === "provider" ? "" : " 估"}
          </span>
        </div>
      );
    case "error":
      return <ErrorCard key={item.seq} code={item.code} provider={provider} />;
    case "compaction":
      return (
        <div key={item.seq} className="compaction-divider">
          <details>
            <summary className="compaction-trigger">這之前的內容已壓縮成摘要</summary>
            <div className="compaction-body">
              <p>
                {item.text}
                {cut(item.truncated)}
              </p>
            </div>
          </details>
        </div>
      );
  }
}

/** Each message the owner sent starts a group; what the turn wrote follows it. */
function groups(items: readonly WireItem[]) {
  const out: { user?: Extract<WireItem, { kind: "user" }>; rest: WireItem[] }[] = [];
  for (const item of items) {
    if (item.kind === "user") out.push({ user: item, rest: [] });
    else if (out.length === 0) out.push({ rest: [item] });
    else out[out.length - 1]?.rest.push(item);
  }
  return out;
}

/** The effort notices in words; any other by its code and data, as before. */
function noticeText(n: Notice): string {
  if (n.code === "effort_clamped" && typeof n.data?.effort === "string")
    return `這個模型不支援原本的推理強度，這次用「${effortName(n.data.effort)}」`;
  if (n.code === "effort_unsupported") return "這個模型不支援推理強度，這次不帶這個設定";
  const data =
    n.data === undefined
      ? ""
      : `（${Object.entries(n.data)
          .map(([k, v]) => `${k}=${v}`)
          .join("，")}）`;
  return `${n.code}${data}`;
}

export function Thread(props: {
  state: State;
  onOlder: () => void;
  after: After;
  /** A new conversation's model, when one was chosen. */
  model?: string;
  /** Opens the effort control; absent when the page offers none. */
  onEffort?: () => void;
}) {
  const { items, running, turn, more, notices, conv } = props.state;
  if (conv === undefined && items.length === 0)
    return (
      <div className="empty-state">
        <Monolith large />
        <h2>新對話</h2>
        <p>
          {props.model === undefined ? "模型用本機端設定的預設。" : `模型：${props.model}。`}
          送出第一則訊息後，模型就綁在這個對話上。輸入 / 可查看指令與可用 skills。
        </p>
      </div>
    );
  const all = groups(items);
  const provider = props.state.convs.find((c) => c.id === conv)?.provider;
  return (
    <>
      {more ? (
        <div className="btn-chip-row">
          <button className="sg-btn sg-btn-sm" type="button" onClick={props.onOlder}>
            載入更早的訊息
          </button>
        </div>
      ) : null}
      {all.map((g, i) => (
        <div className="msg-group" key={g.user?.seq ?? `g${i}`}>
          {g.user === undefined ? null : (
            <div className="msg-user">
              {g.user.text}
              {cut(g.user.truncated)}
            </div>
          )}
          <div className="msg-assistant">
            {g.user === undefined ? null : props.after(g.user.seq)}
            <Rest items={g.rest} after={props.after} provider={provider} />
            {i === all.length - 1 && running !== undefined ? (
              <div className="msg-assistant-text streaming">
                <Markdown text={running.text} />
              </div>
            ) : null}
          </div>
        </div>
      ))}
      {all.length === 0 && running !== undefined ? (
        <div className="msg-assistant-text streaming">
          <Markdown text={running.text} />
        </div>
      ) : null}
      {turn === undefined ? null : (
        <div className="turn-status" role="status">
          {turn.state === "started" ? (
            <span className="status-glyph" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : null}
          <span>
            {TURN_STATE[turn.state] ?? turn.state}
            {turn.reason === undefined ? "" : `：${reasonText(turn.reason)}`}
          </span>
        </div>
      )}
      {notices.map((n, i) =>
        n.code === "effort_truncated" ? (
          <div key={i} className="task-notice warn">
            <div className="task-notice-body">
              <div className="task-notice-title">
                <Icon name="alert" />
                輸出上限被思考用完，請降低推理強度
              </div>
              <div className="task-notice-desc">這次請求用完了單次輸出上限，但沒有輸出正文。</div>
            </div>
            {props.onEffort === undefined ? null : (
              <button className="sg-btn" type="button" onClick={props.onEffort}>
                調整推理強度
              </button>
            )}
          </div>
        ) : (
          <div key={i} className="compaction-meta">
            {noticeText(n)}
          </div>
        ),
      )}
    </>
  );
}
