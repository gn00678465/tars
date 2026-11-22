import { useEffect, useRef } from "react";
import type { WireApproval } from "@tars/protocol";
import type { Card } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { leftText, shortId, timeText } from "./time.ts";

const EFFECTS: Record<string, string> = {
  "read-only": "只讀",
  "local-write": "寫本機",
  "external-write": "寫外部",
};

/**
 * What a screen reader says when a card comes to wait (the prototype's approval-live-alert): the
 * script, its effect and where it connects, the fields an owner decides on first.
 */
export function announceText(a: WireApproval): string {
  const hosts = a.domains.map((d) => (d === "*" ? "任意主機" : d)).join("、");
  // As the prototype: a space before a host name, none before Chinese.
  const where =
    a.domains.length === 0 ? "不連線" : `連線${hosts.startsWith("任意主機") ? "" : " "}${hosts}`;
  const action = a.action === "run_script" ? "執行腳本" : a.action;
  return `需要核准：${action} ${a.script}，影響${EFFECTS[a.effects] ?? a.effects}，${where}。預設焦點在拒絕按鈕。`;
}

// Everything that prints as nothing or as something else: control and format characters
// (zero-width, bidi overrides), line and paragraph separators, every space but U+0020, the
// general-purpose combining marks (e + U+0301 looks like é) and variation selectors. Not all of
// \p{M}: scripts such as Thai and the Indic ones need theirs to be read at all.
const UNSEEN_CLASS = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
const UNSEEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
];

function unseen(c: string, n: number): boolean {
  return UNSEEN_CLASS.test(c) || UNSEEN_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * One argument as the script receives it: quoted, so its ends, an empty one and inner spaces
 * show, and anything unseen written as its \u code (A13: the card is what runs).
 */
export function argText(arg: string): string {
  return Array.from(JSON.stringify(arg), (c) => {
    const n = c.codePointAt(0) as number;
    if (!unseen(c, n)) return c;
    return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, "0")}`;
  }).join("");
}

const STATUS: Record<string, [string, string]> = {
  approved: ["ok", "已核准"],
  denied: ["error", "已拒絕"],
  expired: ["error", "已過期"],
  cancelled: ["", "已取消"],
};

const hhmm = (ms: number) => {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
};

/**
 * A decided card's tag (B1, B2): the result, when, and which device, as the local end says.
 * Another device's decision leads with that it was made elsewhere. An older local end says
 * neither when nor who: a decision this page did not see acked is said to be elsewhere.
 */
function resolvedText(r: NonNullable<Card["resolved"]>, label: string): string {
  const time = r.at === undefined ? "" : `${hhmm(r.at)} `;
  if (r.source === "this") return `${label} · ${time}這台裝置`;
  if (r.source === "other_device") return `已在別處決定 · ${time}另一台裝置${label}`;
  return r.here ? label : `${label}（在別處決定）`;
}

/** How long after the ack a missing result is said to be missing (the protocol cannot ask). */
const RESULT_MS = 15_000;

const OUTCOME: Record<string, string> = {
  approved: "已核准並放行執行",
  denied: "已拒絕，沒有執行這個腳本",
  expired: "10 分鐘內沒有回應，沒有執行",
  cancelled: "回合已中止，沒有執行",
};

function Field(props: { k: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="approval-field">
      <dt className="approval-field-key">{props.k}</dt>
      <dd className={props.mono === true ? "approval-field-val mono" : "approval-field-val"}>
        {props.children}
      </dd>
    </div>
  );
}

/**
 * The prototype's two-part card (ui_spec 5.4): above, what the owner approved when the script
 * went in; below, what TARS passes this time. Deny comes first and has the focus; no shortcuts.
 */
export function ApprovalCard(props: {
  card: Card;
  /** The local end's clock now; undefined before its first status. */
  localNow: number | undefined;
  onDecide: (decision: "approved" | "denied") => void;
  /** Pinned above the composer while the page is on another conversation: says which. */
  /**
   * A card from another conversation: its title, and what tells two of the same title apart
   * (their time and model, or the card's own hash when the list does not have it).
   */
  origin?: { title: string; detail: string; onJump: () => void; onDismiss?: () => void };
  /** Why a decision cannot be sent now (offline); the buttons are off while it is set. */
  blocked?: string;
  /** Takes the focus when this becomes true; false for all but the oldest card to decide. */
  focus?: boolean;
  /** The page's clock, as the ack's time was taken. */
  pageNow?: number;
}) {
  const { approval: a, resolved, deciding } = props.card;
  // Acked but not resolved yet: the local end has the decision, a second one must not go.
  const waiting = resolved === undefined && props.card.acked === true;
  const off =
    resolved !== undefined || deciding !== undefined || waiting || props.blocked !== undefined;
  // A decision once sent may have been taken until the result says otherwise: only it may go
  // again, never the other one.
  const only = resolved === undefined ? props.card.choice : undefined;
  const missing =
    waiting &&
    props.card.ackedAt !== undefined &&
    props.pageNow !== undefined &&
    props.pageNow - props.card.ackedAt > RESULT_MS;
  const deny = useRef<HTMLButtonElement>(null);
  // Only the card App names gets the focus, each time it is named, and not from someone typing.
  useEffect(() => {
    if (props.focus === false) return;
    if (document.activeElement?.closest(".composer") != null) return;
    deny.current?.focus();
  }, [props.focus]);
  const left = props.localNow === undefined ? undefined : a.expiresAt - props.localNow;
  const external = a.effects === "external-write";
  const [tone, label] =
    resolved === undefined
      ? waiting
        ? ["active", "等待結果…"]
        : deciding === undefined
          ? ["wait", "等待核准"]
          : ["active", "送出決定中…"]
      : (STATUS[resolved.state] ?? ["", resolved.state]);
  const status = resolved === undefined ? label : resolvedText(resolved, label);
  const cls = ["approval-card"];
  if (resolved !== undefined) cls.push("state-resolved");
  return (
    <article className={cls.join(" ")} role="region" aria-label="腳本執行核准卡">
      {props.origin === undefined ? null : (
        <div className="approval-origin-bar">
          <div className="approval-origin-text">
            <span>{resolved === undefined ? "待核准" : "已決定"}（來自其他對話）</span>
            <span className="approval-origin-title">{props.origin.title}</span>
            <span className="approval-origin-detail mono">{props.origin.detail}</span>
          </div>
          <div className="approval-origin-actions">
            <button className="sg-btn sg-btn-sm" type="button" onClick={props.origin.onJump}>
              跳至該對話
            </button>
            {props.origin.onDismiss === undefined ? null : (
              <button className="sg-btn sg-btn-sm" type="button" onClick={props.origin.onDismiss}>
                關閉
              </button>
            )}
          </div>
        </div>
      )}
      <div className="approval-head">
        <div className="approval-head-title">
          <Icon name="shield" size={15} />
          <span>{a.action === "run_script" ? "執行腳本" : a.action}</span>
          <span className={`sg-tag ${tone}`}>{status}</span>
        </div>
        {resolved === undefined && left !== undefined ? (
          <span className="approval-countdown">{leftText(left)}</span>
        ) : null}
      </div>
      <div className="approval-section">
        <div className="approval-section-label">入庫時你核可過的腳本屬性</div>
        <dl className="approval-grid">
          <Field k="對象與版本" mono>
            {`${a.script} @ ${a.version}`}
          </Field>
          <Field k="影響範圍">
            <span className={external ? "sg-tag warn" : "sg-tag"}>
              {EFFECTS[a.effects] ?? a.effects}
              {external ? "（高風險）" : ""}
            </span>
          </Field>
          <Field k="腳本說明">{a.summary}</Field>
          <Field k="連線對象">
            {a.domains.length === 0
              ? "無"
              : a.domains.map((d, i) => (
                  <span key={i}>
                    {i === 0 ? "" : "、"}
                    {d === "*" ? (
                      <span className="sg-tag warn">任意主機（*）</span>
                    ) : (
                      <span className="mono">{d}</span>
                    )}
                  </span>
                ))}
          </Field>
          <Field k="用到的金鑰" mono>
            {a.secret ?? "無"}
          </Field>
        </dl>
      </div>
      <div className="approval-section">
        <div className="approval-section-label">這次 TARS 要帶的參數（純文字原樣顯示）</div>
        <dl>
          <dt className="sr-only">內容</dt>
          <dd className="approval-argv-wrap">
            <ol className="argv approval-argv">
              {a.argv.map((arg, i) => (
                <li key={i}>
                  <code>{argText(arg)}</code>
                </li>
              ))}
            </ol>
          </dd>
        </dl>
      </div>
      <div className="approval-foot">
        <dl className="approval-foot-meta">
          {/* The countdown is in the head, as the prototype; without the page's clock there is
              none, so the time it expires is said here instead. Decided, neither: a countdown
              would read as still waiting. */}
          {resolved === undefined && left === undefined ? (
            <>
              <dt className="sr-only">到期時間</dt>
              <dd className="compaction-meta">{`到期 ${timeText(a.expiresAt)}`}</dd>
            </>
          ) : null}
          <dt className="sr-only">核准編號、雜湊前 8 碼</dt>
          <dd className="approval-ids">{`核准 #${shortId(a.approvalId)} · sha256: ${a.hash.slice(0, 8)}`}</dd>
          {resolved === undefined ? (
            <>
              <dt className="sr-only">鍵盤</dt>
              <dd className="compaction-meta">無單鍵快捷鍵 · 預設焦點在拒絕</dd>
            </>
          ) : null}
        </dl>
        {resolved === undefined ? (
          <div className="approval-actions">
            {/* Deny comes first and has the focus; there are no keyboard shortcuts (A14). */}
            <button
              className="sg-btn sg-btn-danger"
              type="button"
              ref={deny}
              disabled={off || only === "approved"}
              onClick={() => props.onDecide("denied")}
            >
              拒絕（預設）
            </button>
            <button
              className={external ? "sg-btn sg-btn-warn-action" : "sg-btn sg-btn-approve"}
              type="button"
              disabled={off || only === "denied"}
              onClick={() => props.onDecide("approved")}
            >
              {waiting
                ? "等待結果…"
                : deciding !== undefined
                  ? "等待本機回應…"
                  : external
                    ? "確認核准寫外部"
                    : "核准執行"}
            </button>
          </div>
        ) : (
          <div className="compaction-meta">{OUTCOME[resolved.state] ?? ""}</div>
        )}
      </div>
      {props.blocked === undefined || resolved !== undefined ? null : (
        <p className="composer-disabled-reason" role="status">
          {props.blocked}
        </p>
      )}
      {only === undefined || off ? null : (
        <p className="composer-disabled-reason" role="status">
          你剛才選的是「{only === "approved" ? "核准" : "拒絕"}」，
          {props.card.lost === true ? "連線中斷後沒有收到結果" : "還沒有收到結果"}
          ；只能重送同一個決定，或重新整理頁面確認
        </p>
      )}
      {missing ? (
        <p className="composer-disabled-reason" role="status">
          還沒收到結果。腳本可能已執行或已被拒絕，請重新整理頁面確認
        </p>
      ) : null}
      {props.card.error === undefined ? null : (
        <p className="composer-inline-err" role="alert">
          {props.card.error}
        </p>
      )}
    </article>
  );
}
