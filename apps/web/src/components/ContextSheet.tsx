import { COMPACT_FOCUS_CHARS, type WireContext } from "@tars/protocol";
import { type Ref, type RefObject, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { about, contextPct } from "../state.ts";
import { Panel } from "./Panel.tsx";
import { shortId, timeText } from "./time.ts";

const n = (v: number) => v.toLocaleString("en-US");
const share = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** The ring's and the bar's tone: it turns at the local end's warn and stop lines. */
const toneOf = (c: WireContext) => {
  const ratio = c.contextUsed / c.contextLimit;
  return ratio >= c.stopRatio ? "error" : ratio >= c.warnRatio ? "warn" : "";
};

/**
 * The ring beside the top bar's buttons (13-01, 13-02): the context used, and the last
 * request's cache hits.
 */
export function ContextRing(props: {
  context: WireContext;
  onOpen: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const c = props.context;
  const pct = contextPct(c) ?? 0;
  const tone = toneOf(c);
  const r = 6;
  const circ = 2 * Math.PI * r;
  return (
    <button
      ref={props.ref}
      className="context-trigger desktop-only"
      type="button"
      aria-label="上下文用量與壓縮"
      aria-haspopup="dialog"
      onClick={props.onOpen}
    >
      <svg className="context-ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="context-ring-track" cx="8" cy="8" r={r} />
        <circle
          className={`context-ring-fill ${tone}`}
          cx="8"
          cy="8"
          r={r}
          strokeDasharray={circ.toFixed(2)}
          strokeDashoffset={(circ * (1 - Math.min(100, pct) / 100)).toFixed(2)}
        />
      </svg>
      <span className="mono">
        {about(c)}
        {pct}%
      </span>
      {c.cacheHitPct === undefined ? null : (
        <span className="conn-latency">快取 {c.cacheHitPct}%</span>
      )}
    </button>
  );
}

/**
 * 上下文用量與壓縮 (13-03, 13-04): the figures and thresholds as the local end measures and
 * configures them, and the manual compaction with what to keep. It bills one model request.
 */
export function ContextSheet(props: {
  context: WireContext;
  conv: string;
  /** Why a compaction cannot start now (a turn runs, offline); the button is off while set. */
  blocked: string | undefined;
  /** What to keep, as typed after /compact. */
  focus?: string;
  onCompact: (focus: string | undefined) => void;
  onClose: () => void;
  phone: boolean;
  /** The ring in the top bar: on a wider screen the sheet drops from it. */
  at?: RefObject<HTMLButtonElement | null>;
}) {
  const [focus, setFocus] = useState(props.focus ?? "");
  const c = props.context;
  const long = focus.trim().length > COMPACT_FOCUS_CHARS;
  const why =
    props.blocked ??
    (long
      ? `要保留的說明最多 ${COMPACT_FOCUS_CHARS} 字，目前 ${focus.trim().length} 字`
      : undefined);
  return (
    <Panel
      phone={props.phone}
      {...(props.at === undefined ? {} : { at: { ref: props.at, side: "bottom" as const } })}
      title="上下文用量與壓縮"
      titleId="context-title"
      onClose={props.onClose}
      foot={
        <>
          <span className="mono">亦可在輸入框使用 /compact [焦點]</span>
          <div className="sheet-foot-actions">
            <button className="sg-btn" type="button" onClick={props.onClose}>
              取消
            </button>
            <button
              className="sg-btn sg-btn-primary"
              type="button"
              disabled={why !== undefined}
              onClick={() => props.onCompact(focus.trim() === "" ? undefined : focus.trim())}
            >
              立即壓縮
            </button>
          </div>
        </>
      }
    >
      <Progress
        className={`context-progress ${toneOf(c)}`}
        value={Math.min(100, contextPct(c) ?? 0)}
        aria-label="上下文使用量"
      />
      <dl className="approval-grid">
        <div className="approval-field">
          <dt className="approval-field-key">目前上下文使用量</dt>
          <dd className="approval-field-val mono">
            {about(c)}
            {n(c.contextUsed)} / {n(c.contextLimit)} tokens（{contextPct(c)}%）
            {c.estimated === true ? "，壓縮後的估計，下一則訊息後更新" : ""}
          </dd>
        </div>
        <div className="approval-field">
          <dt className="approval-field-key">上回合快取命中率</dt>
          <dd className="approval-field-val mono">
            {c.cacheHitPct === undefined ? "還沒有回合" : `${c.cacheHitPct}%`}
          </dd>
        </div>
        <div className="approval-field">
          <dt className="approval-field-key">上次壓縮時間</dt>
          <dd className="approval-field-val mono">
            {c.lastCompactedAt === undefined ? "還沒有壓縮過" : timeText(c.lastCompactedAt)}
          </dd>
        </div>
        <div className="approval-field">
          <dt className="approval-field-key">自動壓縮 / 硬停門檻</dt>
          <dd className="approval-field-val mono">
            {c.autoCompact ? `${share(c.compactRatio)} 自動` : "自動壓縮關閉"} ·{" "}
            {share(c.stopRatio)} 硬停
          </dd>
        </div>
        <div className="approval-field">
          <dt className="approval-field-key">對話編號</dt>
          <dd className="approval-field-val mono">{shortId(props.conv)}</dd>
        </div>
      </dl>
      <div className="provider-group">
        <label htmlFor="compact-focus-input" className="approval-field-key">
          要特別保留什麼（選填）
        </label>
        <input
          id="compact-focus-input"
          className="focus-input"
          type="text"
          aria-invalid={long}
          placeholder="例如：保留備份快照日期與磁碟容量數字"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />
      </div>
      <div className="task-notice">
        <div className="task-notice-body">
          <div className="task-notice-title">保留原始紀錄的結構化壓縮</div>
          <div className="task-notice-desc">
            壓縮不會刪除本機資料庫的原始對話，只會產生 7
            區段摘要（含已執行腳本、輸出路徑與關鍵事實）並保留近期原文。壓縮會送出一次模型請求，計入這家
            provider 的花費。
          </div>
        </div>
      </div>
      {why === undefined ? null : (
        <p className="composer-disabled-reason" role="status">
          {why}
        </p>
      )}
    </Panel>
  );
}
