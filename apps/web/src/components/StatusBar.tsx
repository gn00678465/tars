import type { WireStatus } from "@tars/protocol";
import { type State, versionText } from "../state.ts";
import { useRef } from "react";
import { Icon } from "./Icon.tsx";
import { useModal } from "./modal.ts";
import { timeText } from "./time.ts";

type Provider = WireStatus["providers"][number];

const LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};
export const providerName = (name: string) => LABEL[name] ?? name;
const label = (p: Provider) => providerName(p.name);
const level = (p: Provider) =>
  p.stopped || p.spentUsd >= p.stopUsd ? "error" : p.spentUsd >= p.warnUsd ? "warn" : "ok";

/**
 * A provider's spending beside its models in the model menus: the figure, or, past its stop
 * threshold, that threshold as a share of the quota, since its models cannot be used then.
 * status carries neither the period nor where the figure came from: 本期, and 估, as the sheet.
 */
export function providerSpend(
  status: WireStatus | undefined,
  name: string,
): { readonly text: string; readonly stopped: boolean } | undefined {
  const p = status?.providers.find((x) => x.name === name);
  if (p === undefined) return undefined;
  if (level(p) === "error")
    return {
      text: `已達停用門檻（${Math.round((p.stopUsd / p.quotaUsd) * 100)}%）`,
      stopped: true,
    };
  return {
    text: `本期 ${p.spentUsd.toFixed(2)} / ${p.quotaUsd.toLocaleString("en-US")} USD 估`,
    stopped: false,
  };
}

/**
 * ui_spec 5.2's connection pill, as the prototype's scene 5: the dot's tone, the pill's class
 * ("" plain, warn, error) and the text. Reconnecting is a warn pill with an active dot.
 */
export function connection(state: State): { tone: string; pill: string; text: string } {
  if (state.connection === "auth_expired")
    return { tone: "error", pill: "error", text: "登入已過期" };
  if (state.connection === "version")
    return { tone: "warn", pill: "warn", text: versionText(state.need) };
  if (state.connection === "keys_unavailable")
    return { tone: "warn", pill: "warn", text: "本機端暫時無法驗證登入，稍後自動重試" };
  if (state.reconnect !== undefined)
    return { tone: "active", pill: "warn", text: `重連中，第 ${state.reconnect} 次` };
  if (state.connection !== "open") return { tone: "active", pill: "", text: "連線中" };
  if (!state.relay.online)
    return {
      tone: "error",
      pill: "error",
      text:
        state.relay.lastSeenAt === undefined
          ? "本機端離線"
          : `本機端離線，最後在線 ${timeText(state.relay.lastSeenAt)}`,
    };
  return { tone: "ok", pill: "", text: "在線" };
}

const DAY_MS = 86_400_000;
/** ui_spec 5.2: the local end's certificate is warned of 30 days before it expires. */
const CERT_WARN_DAYS = 30;

/** Whole days left on the local end's certificate, by the local end's clock; undefined unknown. */
export function certDays(status: WireStatus | undefined): number | undefined {
  if (status?.certExpiresAt === undefined) return undefined;
  return Math.floor((status.certExpiresAt - status.now) / DAY_MS);
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
  const days = certDays(status);
  if (days !== undefined && days < CERT_WARN_DAYS)
    return {
      tone: days < 0 ? "error" : "warn",
      text: days < 0 ? "憑證已過期" : `憑證剩 ${days} 天`,
    };
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
        <div className={`conn-pill ${c.pill}`} role="status">
          <span className={`status-dot ${c.tone}`} />
          <span>{c.text}</span>
          {/* Hidden from screen readers: the pill is a status region, and a figure changing every
              half minute would be read out each time. The sheet says it too. */}
          {c.tone === "ok" && props.state.rtt !== undefined ? (
            <span className="mono conn-latency" aria-hidden="true">
              {Math.round(props.state.rtt)} ms
            </span>
          ) : null}
          {props.state.connection === "auth_expired" ||
          (props.state.connection === "version" && props.state.need !== "local") ? (
            <button className="sg-btn sg-btn-sm" type="button" onClick={() => location.reload()}>
              {props.state.connection === "auth_expired" ? "重新登入" : "重新載入"}
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
  const panel = useRef<HTMLElement>(null);
  useModal(panel, true, props.onClose);
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
        ref={panel}
        className="sheet-panel sg-popover wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
      >
        <div className="sheet-head">
          <h2 id="sheet-title">花費與狀態</h2>
          <button className="sg-icon-btn" type="button" aria-label="關閉" onClick={props.onClose}>
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
            <div className="model-option">
              <span>往返延遲</span>
              <span className="mono">
                {props.state.rtt === undefined ? "量測中" : `${Math.round(props.state.rtt)} ms`}
              </span>
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
              {status.certExpiresAt === undefined ? null : (
                <div className="model-option">
                  <span>
                    本機端憑證
                    {(certDays(status) ?? 0) < CERT_WARN_DAYS ? (
                      <span className="sg-tag warn">{CERT_WARN_DAYS} 天內到期</span>
                    ) : null}
                  </span>
                  <span className="mono">
                    到期 {timeText(status.certExpiresAt)}（剩 {certDays(status)} 天）
                  </span>
                </div>
              )}
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
