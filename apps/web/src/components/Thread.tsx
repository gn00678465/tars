import type { WireItem } from "@tars/protocol";
import { Fragment, type ReactNode, useState } from "react";
import type { State } from "../state.ts";
import { Icon, Monolith } from "./Icon.tsx";
import { reasonText } from "../reasons.ts";
import { ErrorCard } from "./ErrorCard.tsx";
import { NoticeCard } from "./Notices.tsx";
import { Markdown } from "./Markdown.tsx";
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

/**
 * ui_spec 5.3: a tool step's results, as the prototype's tags, keyed by the local end's
 * ToolCallEndState. refused covers more than the whitelist (a script changed after approval, a
 * budget reached), and the result says which only in its text, so its tag says what happened,
 * not why.
 */
const RESULT: Record<string, [string, string]> = {
  done: ["ok", "完成"],
  failed: ["error", "失敗"],
  denied: ["error", "已拒絕"],
  expired: ["error", "已過期"],
  cancelled: ["", "已取消"],
  skipped: ["", "已略過"],
  refused: ["warn", "沒有執行"],
  interrupted: ["warn", "中斷（結果不明）"],
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
          <span>{result?.status === "refused" ? "已擋下" : call.name}</span>
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

export function Thread(props: {
  state: State;
  onOlder: () => void;
  after: After;
  /**
   * The new conversation's model label; "" when the local end lists none; absent from a local
   * end older than models.list.
   */
  model?: string;
  /** No conversation was opened or started yet: the page says it is connected. */
  welcome?: boolean;
  /** Opens the effort control; absent when the page offers none. */
  onEffort?: () => void;
}) {
  const { items, running, turn, more, notices, conv } = props.state;
  if (conv === undefined && items.length === 0)
    return (
      <div className="empty-state">
        <Monolith large />
        {props.welcome === true ? (
          <>
            <h2>已連線至本機 TARS</h2>
            <p>
              可進行日常對話，或透過白名單查詢與執行已入庫的安全腳本。輸入 / 可查看指令與可用
              skills。
            </p>
          </>
        ) : (
          <>
            <h2>新對話</h2>
            <p>
              {props.model === ""
                ? "還沒有可用的模型。請先在本機終端更新模型清單。"
                : `${props.model === undefined ? "模型用本機端設定的預設。" : `目前用 ${props.model}。要換模型或推理強度，在輸入框右下角選。`}送出第一則訊息後，模型就綁在這個對話上。`}
            </p>
          </>
        )}
      </div>
    );
  const all = groups(items);
  const here = props.state.convs.find((c) => c.id === conv);
  const provider = here?.provider;
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
      {notices.map((n, i) => (
        <NoticeCard
          key={i}
          notice={n}
          context={{ provider, effort: here?.effort }}
          {...(props.onEffort === undefined ? {} : { onEffort: props.onEffort })}
        />
      ))}
    </>
  );
}
