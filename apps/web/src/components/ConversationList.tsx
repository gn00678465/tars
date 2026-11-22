import type { WireConv } from "@tars/protocol";
import { shortId, timeText } from "./time.ts";

const titleOf = (c: WireConv) => (c.title === "" ? "（沒有標題）" : c.title);

/**
 * 新對話 stays outside the fold. The list folds while a conversation is open, so the thread and
 * the composer come right after it however long the list is. The key remounts the fold on every
 * conversation opened: `open` is only its first state, and one unfolded by hand folds again.
 */
export function ConversationList(props: {
  convs: readonly WireConv[];
  current: string | undefined;
  onOpen: (conv: string | undefined) => void;
}) {
  const open = props.convs.find((c) => c.id === props.current);
  return (
    <nav className="convs" aria-label="對話">
      <button type="button" onClick={() => props.onOpen(undefined)}>
        新對話
      </button>
      <details key={props.current ?? ""} open={props.current === undefined}>
        <summary>
          對話清單（{props.convs.length} 筆）
          {open === undefined ? "" : `，目前：${titleOf(open)}`}
        </summary>
        <ul>
          {props.convs.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-current={c.id === props.current ? "true" : undefined}
                onClick={() => props.onOpen(c.id)}
              >
                {c.id === props.current ? <strong>目前：</strong> : null}
                <span className="title">{titleOf(c)}</span>
                <small>
                  {c.provider}/{c.model}，{timeText(c.updatedAt)}
                  {c.parentId === undefined ? "" : `，接續 ${shortId(c.parentId)}`}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}
