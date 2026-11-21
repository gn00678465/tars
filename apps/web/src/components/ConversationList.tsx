import type { WireConv } from "@tars/protocol";
import { shortId, timeText } from "./time.ts";

export function ConversationList(props: {
  convs: readonly WireConv[];
  current: string | undefined;
  onOpen: (conv: string | undefined) => void;
}) {
  return (
    <nav className="convs">
      <button type="button" onClick={() => props.onOpen(undefined)}>
        新對話
      </button>
      <ul>
        {props.convs.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              aria-current={c.id === props.current ? "true" : undefined}
              onClick={() => props.onOpen(c.id)}
            >
              {c.title === "" ? "（沒有標題）" : c.title}
              <small>
                {c.provider}/{c.model}，{timeText(c.updatedAt)}
                {c.parentId === undefined ? "" : `，接續 ${shortId(c.parentId)}`}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
