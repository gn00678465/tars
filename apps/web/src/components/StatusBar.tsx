import type { WireStatus } from "@tars/protocol";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { timeText } from "./time.ts";

type Provider = WireStatus["providers"][number];

const LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};
const label = (p: Provider) => LABEL[p.name] ?? p.name;
const level = (p: Provider) =>
  p.stopped || p.spentUsd >= p.stopUsd ? "error" : p.spentUsd >= p.warnUsd ? "warn" : "ok";

/** ui_spec 5.2's connection pill: [dot tone, text]. */
export function connection(state: State): { tone: string; text: string } {
  if (state.connection === "auth_expired") return { tone: "error", text: "登入已過期" };
  if (state.connection === "keys_unavailable")
    return { tone: "warn", text: "本機端暫時無法驗證登入，稍後自動重試" };
  if (state.connection === "connecting") return { tone: "active", text: "連線中" };
  if (state.connection === "offline") return { tone: "active", text: "重連中" };
  if (!state.relay.online)
    return {
      tone: "error",
      text:
        state.relay.lastSeenAt === undefined
          ? "本機端離線"
          : `本機端離線，最後在線 ${timeText(state.relay.lastSeenAt)}`,
    };
  return { tone: "ok", text: "在線" };
}

/** The catalog button: 花費與模型, or the provider past a threshold. Stopping wins over warning. */
function spendButton(status: WireStatus | undefined): { tone?: string; text: string } {
  const providers = status?.providers ?? [];
  const stopped = providers.find((p) => level(p) === "error");
  if (stopped !== undefined) return { tone: "error", text: `${label(stopped)} 已達停用門檻` };
  const warned = providers.find((p) => level(p) === "warn");
  if (warned !== undefined)
    return {
      tone: "warn",
      text: `${label(warned)} 已用 ${Math.round((warned.spentUsd / warned.quotaUsd) * 100)}%`,
    };
  if (status?.pricesWarn === true) return { tone: "warn", text: "價目表過期" };
  return { text: "花費與模型" };
}

export function TopBar(props: {
  state: State;
  onMenu: () => void;
  menuHidden: boolean;
  onSheet: () => void;
}) {
  const c = connection(props.state);
  const spend = spendButton(props.state.status);
  const warn = c.tone !== "ok" || spend.tone !== undefined;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className={
            props.menuHidden ? "sg-icon-btn btn-open-sidebar-desktop-hidden" : "sg-icon-btn"
          }
          type="button"
          aria-label="展開對話列表"
          title="展開對話列表"
          onClick={props.onMenu}
        >
          <Icon name="menu" size={17} />
        </button>
        <div
          className={`conn-pill ${c.tone === "ok" || c.tone === "active" ? "" : c.tone}`}
          role="status"
        >
          <span className={`status-dot ${c.tone}`} />
          <span>{c.text}</span>
          {props.state.connection === "auth_expired" ? (
            <button className="sg-btn sg-btn-sm" type="button" onClick={() => location.reload()}>
              重新登入
            </button>
          ) : null}
        </div>
      </div>
      <div className="topbar-right">
        <button className="sg-btn desktop-only" type="button" onClick={props.onSheet}>
          {spend.tone === undefined ? null : <span className={`status-dot ${spend.tone}`} />}
          <span>{spend.text}</span>
        </button>
        <button
          className="sg-btn mobile-only"
          type="button"
          aria-label="開啟系統狀態與花費面板"
          onClick={props.onSheet}
        >
          <span className={`status-dot ${warn ? "warn" : "ok"}`} />
          <span>{warn ? (spend.tone === undefined ? c.text : spend.text) : "狀態"}</span>
        </button>
      </div>
    </header>
  );
}

/** The status sheet: a dialog on desktop, a bottom sheet on a phone (the CSS decides). */
export function StatusSheet(props: { state: State; onClose: () => void }) {
  const { status } = props.state;
  const c = connection(props.state);
  return (
    <div
      className="overlay-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <section
        className="sheet-panel sg-popover wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
      >
        <div className="sheet-head">
          <h2 id="sheet-title">花費與狀態</h2>
          <button
            className="sg-icon-btn"
            type="button"
            aria-label="關閉"
            autoFocus
            onClick={props.onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="sheet-body">
          <div className="provider-group">
            <div className="provider-group-head">
              <span>連線</span>
            </div>
            <div className="model-option">
              <span>
                <span className={`status-dot ${c.tone}`} /> {c.text}
              </span>
              {props.state.localSince === undefined ? null : (
                <span className="mono">這一次連上 {timeText(props.state.localSince)}</span>
              )}
            </div>
          </div>
          <div className="provider-group">
            <div className="provider-group-head">
              <span>三家 Provider 花費</span>
            </div>
            {status === undefined ? (
              <div className="model-option">
                <span>還沒有收到本機端的狀態</span>
              </div>
            ) : (
              status.providers.map((p) => {
                const l = level(p);
                return (
                  <div className="model-option" key={p.name}>
                    <span>
                      {label(p)}
                      {l === "error" ? <span className="sg-tag error">已達停用門檻</span> : null}
                      {l === "warn" ? <span className="sg-tag warn">已過提醒門檻</span> : null}
                    </span>
                    {/* status carries neither the period nor where the figure came from:
                        本期, and 估 on every one, until the protocol says. */}
                    <span className="mono">
                      本期 {p.spentUsd.toFixed(2)} / {p.quotaUsd.toLocaleString("en-US")} USD 估
                    </span>
                  </div>
                );
              })
            )}
          </div>
          {status === undefined ? null : (
            <div className="provider-group">
              <div className="provider-group-head">
                <span>其他</span>
              </div>
              <div className="model-option">
                <span>通知</span>
                <span>{status.notify === "ok" ? "已設定" : "未設定"}</span>
              </div>
              <div className="model-option">
                <span>待核准</span>
                <span className="num">{status.pendingApprovals}</span>
              </div>
              {status.pricesWarn ? (
                <div className="task-notice warn">
                  <div className="task-notice-body">
                    <div className="task-notice-title">價目表過期</div>
                    <div className="task-notice-desc">請在本機終端更新模型清單與價目。</div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
