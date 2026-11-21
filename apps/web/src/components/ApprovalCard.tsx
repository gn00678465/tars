import type { Card } from "../state.ts";
import { leftText, shortId, timeText } from "./time.ts";

const EFFECTS: Record<string, string> = {
  "read-only": "只讀",
  "local-write": "寫本機",
  "external-write": "寫外部",
};

const RESOLVED: Record<string, string> = {
  approved: "已核准",
  denied: "已拒絕",
  expired: "已過期",
  cancelled: "已取消",
};

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

export function ApprovalCard(props: {
  card: Card;
  /** The local end's clock now; undefined before its first status. */
  localNow: number | undefined;
  onDecide: (decision: "approved" | "denied") => void;
}) {
  const { approval: a, resolved, deciding } = props.card;
  const done = resolved !== undefined || deciding !== undefined;
  const left = props.localNow === undefined ? undefined : a.expiresAt - props.localNow;
  const rows: [string, React.ReactNode][] = [
    ["動作", a.action === "run_script" ? "執行腳本" : a.action],
    ["對象", `${a.script}（版本 ${a.version}）`],
    [
      "內容",
      <ol className="argv">
        {a.argv.map((arg, i) => (
          <li key={i}>
            <code>{argText(arg)}</code>
          </li>
        ))}
      </ol>,
    ],
    ["腳本說明", a.summary],
    ["影響", EFFECTS[a.effects] ?? a.effects],
    [
      "連線對象",
      a.domains.length === 0 ? "無" : a.domains.map((d) => (d === "*" ? "任意主機" : d)).join("、"),
    ],
    ["用到的金鑰", a.secret ?? "無"],
    ["到期時間", `${timeText(a.expiresAt)}${left === undefined ? "" : `（${leftText(left)}）`}`],
    ["核准編號、雜湊前 8 碼", `${shortId(a.approvalId)}、${a.hash.slice(0, 8)}`],
  ];
  return (
    <article className="approval" aria-label="核准">
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {/* Deny comes first and has the focus; there are no keyboard shortcuts (A14). */}
      <button type="button" autoFocus disabled={done} onClick={() => props.onDecide("denied")}>
        拒絕
      </button>
      <button type="button" disabled={done} onClick={() => props.onDecide("approved")}>
        核准
      </button>
      {resolved === undefined ? null : (
        <p className="reason">
          {resolved.here ? RESOLVED[resolved.state] : `${RESOLVED[resolved.state]}（在別處決定）`}
        </p>
      )}
      {props.card.error === undefined ? null : (
        <p className="reason" role="alert">
          {props.card.error}
        </p>
      )}
    </article>
  );
}
