import type { WireStatus } from "@tars/protocol";
import type { Ref } from "react";
import { about, contextPct, type State, versionText } from "../state.ts";
import { ContextRing } from "./ContextSheet.tsx";
import { PriceNotices, PriceTable, priceButtonText, updatedText } from "./Prices.tsx";
import { Icon } from "./Icon.tsx";
import { Panel } from "./Panel.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
 * How a provider counts its spending, as status says: per UTC month or since the start. A local
 * end older than period says neither, and the page says 本期.
 */
export const periodName = (p: Pick<Provider, "period">) =>
  p.period === "month" ? "本月" : p.period === "cumulative" ? "累計" : "本期";

/** The figure with its period; 估 unless status says it is the bill's alone (tars cost adjust). */
export const spendFigure = (p: Provider) =>
  `${periodName(p)} ${p.spentUsd.toFixed(2)} / ${p.quotaUsd.toLocaleString("en-US")} USD${
    p.estimated === false ? "" : " 估"
  }`;

/**
 * A provider's spending beside its models in the model menus: the figure, or, past its stop
 * threshold, that threshold as a share of the quota, since its models cannot be used then.
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
  return { text: spendFigure(p), stopped: false };
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
function certDays(status: WireStatus | undefined): number | undefined {
  if (status?.certExpiresAt === undefined) return undefined;
  return Math.floor((status.certExpiresAt - status.now) / DAY_MS);
}

/**
 * The certificate as a tag: plain while more than 30 days are left, then warned, then an error
 * once expired; undefined while the local end has not said when it expires.
 */
export function certTag(
  status: WireStatus | undefined,
): { readonly tone: "" | "warn" | "error"; readonly text: string } | undefined {
  const days = certDays(status);
  if (days === undefined) return undefined;
  if (days < 0) return { tone: "error", text: "憑證已過期" };
  if (days < CERT_WARN_DAYS) return { tone: "warn", text: `憑證剩 ${days} 天` };
  return { tone: "", text: "連線憑證正常" };
}

/**
 * The catalog button: 花費與模型 with the list's last update, or the provider past a threshold,
 * or the model whose price needs confirming. Stopping wins over warning.
 */
function spendButton(state: State): {
  tone?: string;
  text: string;
  date?: string;
  /** At phone width, where a model's name would push the button past the edge. */
  short?: string;
} {
  const { status, catalog } = state;
  const providers = status?.providers ?? [];
  const stopped = providers.find((p) => level(p) === "error");
  if (stopped !== undefined) return { tone: "error", text: `${label(stopped)} 已達停用門檻` };
  const warned = providers.find((p) => level(p) === "warn");
  if (warned !== undefined)
    return {
      tone: "warn",
      text: `${label(warned)} 已用 ${Math.round((warned.spentUsd / warned.quotaUsd) * 100)}%`,
    };
  if (status?.pricesWarn === true)
    return {
      tone: "warn",
      text: priceButtonText(status, catalog) ?? "價目表過期",
      short: "價目待確認",
    };
  const cert = certTag(status);
  if (cert !== undefined && cert.tone !== "") return cert;
  const date = updatedText(catalog);
  return { text: "花費與模型", ...(date === undefined ? {} : { date }) };
}

export function TopBar(props: {
  state: State;
  onMenu: () => void;
  menuHidden: boolean;
  /** A phone reading a page of the knowledge base: back to where it was opened from. */
  onBack?: () => void;
  onSheet: () => void;
  /** Opens the context sheet; absent when the page has no context to show. */
  onContext?: () => void;
  /** Whether the context sheet is open. */
  contextOpen: boolean;
  /** The context ring, which the context sheet drops from. */
  ringRef?: Ref<HTMLButtonElement>;
}) {
  const c = connection(props.state);
  const spend = spendButton(props.state);
  const warn = c.tone !== "ok" || spend.tone !== undefined;
  return (
    <header className="topbar">
      <div className="topbar-left">
        {props.onBack === undefined ? null : (
          <button
            className="sg-icon-btn topbar-back"
            type="button"
            aria-label="返回"
            onClick={props.onBack}
          >
            <Icon name="back" size={19} />
          </button>
        )}
        {/* The button's name, shown on hover and on focus as its title was. */}
        <Tooltip>
          <TooltipTrigger
            className={
              props.menuHidden ? "sg-icon-btn btn-open-sidebar-desktop-hidden" : "sg-icon-btn"
            }
            aria-label="展開對話列表"
            onClick={props.onMenu}
          >
            <Icon name="menu" size={17} />
          </TooltipTrigger>
          <TooltipContent side="bottom">展開對話列表</TooltipContent>
        </Tooltip>
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
          {spend.date === undefined ? null : (
            <span className="mono conn-latency" aria-label={`模型清單 ${spend.date} 更新`}>
              {spend.date}
            </span>
          )}
        </button>
        {props.state.context === undefined || props.onContext === undefined ? null : (
          <ContextRing
            context={props.state.context}
            onOpen={props.onContext}
            open={props.contextOpen}
            ref={props.ringRef}
          />
        )}
        <button
          className="sg-btn mobile-only"
          type="button"
          aria-label="開啟系統狀態與花費面板"
          onClick={props.onSheet}
        >
          <span className={`status-dot ${warn ? "warn" : "ok"}`} />
          {/* The pill beside it already says the connection; a second copy pushed this one past
              the edge at 375px. */}
          <span>{spend.tone === undefined ? "狀態" : (spend.short ?? spend.text)}</span>
        </button>
      </div>
    </header>
  );
}

/** The status sheet: a dialog on desktop, a drawer from the bottom on a phone. */
export function StatusSheet(props: {
  state: State;
  phone: boolean;
  onClose: () => void;
  /** Opens the context sheet (13-12); absent when the page has no context to show. */
  onCompact?: () => void;
}) {
  const { status, context } = props.state;
  const c = connection(props.state);
  return (
    <Panel
      phone={props.phone}
      title="花費、模型清單與價目表（唯讀）"
      titleId="sheet-title"
      wide
      onClose={props.onClose}
      foot={
        <>
          <span>模型啟用、單價與額度只能在本機終端修改</span>
          <div className="sheet-foot-actions">
            {context === undefined || props.onCompact === undefined ? null : (
              <button className="sg-btn" type="button" onClick={props.onCompact}>
                開啟壓縮
              </button>
            )}
            <button className="sg-btn" type="button" onClick={props.onClose}>
              關閉
            </button>
          </div>
        </>
      }
    >
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
                <span className="mono">{spendFigure(p)}</span>
              </div>
            );
          })
        )}
      </div>
      {status === undefined ? null : <PriceNotices status={status} catalog={props.state.catalog} />}
      {props.state.catalog === undefined || props.state.catalog.entries.length === 0 ? null : (
        <PriceTable catalog={props.state.catalog} warns={status?.prices ?? []} />
      )}
      {context === undefined ? null : (
        <div className="provider-group">
          <div className="provider-group-head">
            <span>目前對話</span>
          </div>
          <div className="model-option">
            <span>上下文用量</span>
            <span className="mono">
              {about(context)}
              {contextPct(context)}%
              {context.cacheHitPct === undefined ? "" : `（快取 ${context.cacheHitPct}%）`}
            </span>
          </div>
        </div>
      )}
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
          {/* A local end older than prices says only that some are old. */}
          {status.pricesWarn && status.prices === undefined ? (
            <div className="task-notice warn">
              <div className="task-notice-body">
                <div className="task-notice-title">價目表過期</div>
                <div className="task-notice-desc">請在本機終端更新模型清單與價目。</div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
