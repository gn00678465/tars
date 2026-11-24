import { Panel } from "../Panel.tsx";
import type { WikiState } from "../../wiki/state.ts";
import { momentText } from "../../wiki/time.ts";

/**
 * 「原始對話出處對證」(15-11): the turn a source mark names, read from agent.db. A centred Dialog, as
 * the signed-off prototype has it; a phone's bottom Drawer. What it shows is the conversation's own
 * words: data, never acted on.
 */
export function SourceOverlay(props: {
  source: NonNullable<WikiState["source"]>;
  now: number;
  onClose: () => void;
  phone: boolean;
  onJump: (conv: string) => void;
}) {
  const { ref, result } = props.source;
  const found = result?.found === true ? result : undefined;
  return (
    <Panel
      phone={props.phone}
      title="原始對話出處對證"
      titleId="sheet-title"
      onClose={props.onClose}
      foot={
        <>
          <span>關閉後停留在目前知識庫頁面</span>
          <div className="sheet-foot-actions">
            <button className="sg-btn" type="button" onClick={props.onClose}>
              關閉
            </button>
            {found === undefined ? null : (
              <button
                className="sg-btn sg-btn-primary"
                type="button"
                onClick={() => props.onJump(found.conv)}
              >
                前往原對話
              </button>
            )}
          </div>
        </>
      }
    >
      <div className="approval-grid">
        <div className="approval-field">
          <span className="approval-field-key">來源標記</span>
          <span className="approval-field-val mono">[[source:{ref}]]</span>
        </div>
        <div className="approval-field">
          <span className="approval-field-key">資料來源</span>
          <span className="approval-field-val mono">agent.db（唯讀對證）</span>
        </div>
        {found === undefined ? null : (
          <div className="approval-field">
            <span className="approval-field-key">對話</span>
            <span className="approval-field-val">
              {found.convTitle === "" ? "（沒有標題）" : found.convTitle} ·{" "}
              {momentText(found.at, props.now)} · 第 {found.turnNo} 回合
            </span>
          </div>
        )}
      </div>
      {result === undefined ? (
        <div className="conv-skeleton" aria-label="讀取原始對話中">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      ) : found === undefined ? (
        <div className="task-notice warn">
          <div className="task-notice-body">
            <div className="task-notice-title">找不到這個回合</div>
            <div className="task-notice-desc">
              原始對話可能已刪除，或這個來源標記對到不只一個回合。
            </div>
          </div>
        </div>
      ) : (
        <>
          {found.quotes.length === 0 ? null : (
            <div className="task-notice active">
              <div className="task-notice-body">
                <div className="task-notice-title">原始對話節錄</div>
                {found.quotes.map((q, i) => (
                  <div className="task-notice-desc" key={i}>
                    「{q}」
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="wiki-turn-text">
            <div className="wiki-turn-side">
              <span className="approval-field-key">擁有者</span>
              <p>{found.owner}</p>
            </div>
            {found.assistant === "" ? null : (
              <div className="wiki-turn-side">
                <span className="approval-field-key">tars</span>
                <p>{found.assistant}</p>
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
