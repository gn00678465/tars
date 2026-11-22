import type { WireItem } from "@tars/protocol";
import { useState } from "react";
import type { State } from "../state.ts";
import { Icon, Monolith } from "./Icon.tsx";
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

function Rest({ items }: { items: readonly WireItem[] }) {
  const results = new Map(
    items.filter((i): i is ToolResult => i.kind === "tool_result").map((i) => [i.callId, i]),
  );
  return items.map((item) => {
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
            <p>
              {item.text}
              {cut(item.truncated)}
              {ASSISTANT_STATE[item.state] ?? ""}
            </p>
          </div>
        );
      case "tool_call":
        return <ToolStep key={item.seq} call={item} result={results.get(item.callId)} />;
      case "usage":
        return (
          <div key={item.seq} className="msg-usage-line mono">
            <span>輸入 {item.inputTokens.toLocaleString("en-US")}</span>
            <span>輸出 {item.outputTokens.toLocaleString("en-US")}</span>
            <span>
              {item.costUsd.toFixed(4)} USD{item.costSource === "estimate" ? " 估" : ""}
            </span>
          </div>
        );
      case "error":
        return (
          <div key={item.seq} className="composer-inline-err" role="status">
            錯誤：{item.code}
          </div>
        );
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
  });
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

export function Thread(props: { state: State; onOlder: () => void }) {
  const { items, running, turn, more, notices, conv } = props.state;
  if (conv === undefined && items.length === 0)
    return (
      <div className="empty-state">
        <Monolith large />
        <h2>新對話</h2>
        <p>
          模型用本機端設定的預設。送出第一則訊息後，模型就綁在這個對話上。輸入 / 可查看指令與可用
          skills。
        </p>
      </div>
    );
  const all = groups(items);
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
            <Rest items={g.rest} />
            {i === all.length - 1 && running !== undefined ? (
              <div className="msg-assistant-text streaming">
                <p>{running.text}</p>
              </div>
            ) : null}
          </div>
        </div>
      ))}
      {all.length === 0 && running !== undefined ? (
        <div className="msg-assistant-text streaming">
          <p>{running.text}</p>
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
            {turn.reason === undefined ? "" : `：${turn.reason}`}
          </span>
        </div>
      )}
      {notices.map((n, i) => (
        <div key={i} className="compaction-meta">
          {n}
        </div>
      ))}
    </>
  );
}
