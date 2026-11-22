import type { WireItem } from "@tars/protocol";
import type { State } from "../state.ts";
import { shortId } from "./time.ts";

const cut = (truncated: boolean) => (truncated ? "（已截斷）" : "");

const ASSISTANT_STATE: Record<string, string> = {
  truncated: "（輸出被截斷）",
  aborted: "（已中止）",
  incomplete: "（沒有完成）",
};

const TURN_STATE: Record<string, string> = {
  started: "回合進行中",
  completed: "回合完成",
  failed: "回合失敗",
  aborted: "回合已中止",
  rejected: "回合沒有開始",
};

function Item({ item }: { item: WireItem }) {
  switch (item.kind) {
    case "user":
      return (
        <li className="user">
          {item.text}
          {cut(item.truncated)}
        </li>
      );
    case "carried":
      return <li className="meta">接續自對話 {shortId(item.from)}</li>;
    case "assistant":
      return (
        <li className="assistant">
          {item.text}
          {cut(item.truncated)}
          {ASSISTANT_STATE[item.state] ?? ""}
        </li>
      );
    case "tool_call":
      return (
        <li className="tool">
          工具 {item.name}：{item.input}
          {cut(item.truncated)}
        </li>
      );
    case "tool_result":
      return (
        <li className="tool">
          結果（{item.status}
          {item.exit === undefined ? "" : `，結束碼 ${item.exit}`}）：{item.text}
          {cut(item.truncated)}
        </li>
      );
    case "usage":
      return (
        <li className="meta">
          用量：輸入 {item.inputTokens}，輸出 {item.outputTokens}，${item.costUsd.toFixed(4)}（
          {item.costSource}）
        </li>
      );
    case "error":
      return <li className="meta">錯誤：{item.code}</li>;
    case "compaction":
      return (
        <li className="meta">
          摘要：{item.text}
          {cut(item.truncated)}
        </li>
      );
  }
}

export function Thread(props: { state: State; onOlder: () => void; ref?: React.Ref<HTMLElement> }) {
  const { items, running, turn, more, notices } = props.state;
  return (
    // Focusable only from code: opening a conversation moves the focus, and so the view, here.
    <section className="thread" aria-label="訊息" tabIndex={-1} ref={props.ref}>
      {more ? (
        <button type="button" onClick={props.onOlder}>
          載入更早的訊息
        </button>
      ) : null}
      <ol>
        {items.map((item) => (
          <Item key={item.seq} item={item} />
        ))}
        {running === undefined ? null : <li className="assistant running">{running.text}</li>}
      </ol>
      {turn === undefined ? null : (
        <p className="meta">
          {TURN_STATE[turn.state] ?? turn.state}
          {turn.reason === undefined ? "" : `：${turn.reason}`}
        </p>
      )}
      {notices.map((n, i) => (
        <p key={i} className="meta">
          {n}
        </p>
      ))}
    </section>
  );
}
