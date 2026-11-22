import type { WireConv } from "@tars/protocol";
import { useRef } from "react";
import { Icon, Monolith } from "./Icon.tsx";
import { useModal } from "./modal.ts";
import { timeText } from "./time.ts";

const titleOf = (c: WireConv) => (c.title === "" ? "（沒有標題）" : c.title);

/**
 * The prototype's sidebar (ui_spec 5.1, 5.5): a fixed column on desktop that can fold, a drawer
 * from the left below 1024px. The open conversation says 目前 in words, not by its shade alone.
 */
export function ConversationList(props: {
  convs: readonly WireConv[];
  /** conv.list.result has arrived at least once. */
  listed: boolean;
  /** The local end is offline: the list cannot be used. */
  offline: boolean;
  current: string | undefined;
  /** Conversations with an approval waiting. */
  waiting: ReadonlySet<string>;
  collapsed: boolean;
  /** The drawer below 1024px is open: it holds the focus and Esc closes it. */
  drawerOpen: boolean;
  onOpen: (conv: string | undefined) => void;
  onCollapse: () => void;
}) {
  const aside = useRef<HTMLElement>(null);
  // Only the drawer is modal: the desktop column sits beside the thread.
  useModal(aside, props.drawerOpen, props.onCollapse);
  const cls = ["sidebar"];
  if (props.collapsed) cls.push("collapsed");
  if (props.drawerOpen) cls.push("mobile-open");
  return (
    <aside
      ref={aside}
      className={cls.join(" ")}
      aria-label="對話列表"
      {...(props.drawerOpen ? { role: "dialog", "aria-modal": true } : {})}
    >
      <div className="sidebar-header">
        <div className="brand-mark">
          <Monolith />
          <span>TARS</span>
        </div>
        <button
          className="sg-icon-btn"
          type="button"
          aria-label="收合側邊欄"
          title="收合側邊欄"
          onClick={props.onCollapse}
        >
          <Icon name="sidebar" size={16} />
        </button>
      </div>
      <div className="sidebar-actions">
        <button
          className="sg-btn new-chat-btn"
          type="button"
          onClick={() => props.onOpen(undefined)}
        >
          <Icon name="plus" size={15} />
          <span>新對話</span>
        </button>
      </div>
      <div className="conv-list" role="list" aria-label="歷史對話">
        {props.offline ? (
          <div className="conv-offline-box">
            <strong>本機端離線，無法載入歷史</strong>
            <span>對話與記憶只存於你的電腦。本機端重新連線後會自動同步。</span>
          </div>
        ) : !props.listed ? (
          <div className="conv-skeleton" aria-label="載入對話列表中">
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        ) : (
          props.convs.map((c) => {
            const here = c.id === props.current;
            return (
              <div className="conv-list-row" role="listitem" key={c.id}>
                <button
                  className={here ? "conv-item active" : "conv-item"}
                  type="button"
                  aria-current={here ? "true" : undefined}
                  title={titleOf(c)}
                  onClick={() => props.onOpen(c.id)}
                >
                  <div className="conv-title-row">
                    <span className="conv-title">{titleOf(c)}</span>
                    {here ? <span className="sg-tag active">目前</span> : null}
                    {props.waiting.has(c.id) ? <span className="sg-tag wait">待核准</span> : null}
                  </div>
                  <div className="conv-meta">
                    <span>{c.model}</span>
                    <span className="num">{timeText(c.updatedAt)}</span>
                  </div>
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
