import { Button } from "@base-ui/react/button";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/** One pinned card, and what the pager's header says of it. */
export interface DockCard {
  id: string;
  title: string;
  /** Its conversation's time and model: the card's own bar does not show it behind the pager. */
  detail: string;
  script: string;
  external: boolean;
  /** wait: its buttons can be pressed; sent: waiting for the local end; done: decided. */
  state: "wait" | "sent" | "done";
  /** The decision, for done: 已核准, 已拒絕, 已過期, 已取消. */
  result?: string;
  node: ReactNode;
}

const dotOf = (c: DockCard) =>
  c.state === "wait"
    ? "wait"
    : c.state === "sent"
      ? "active"
      : c.result === "已核准"
        ? "ok"
        : "error";
const stateOf = (c: DockCard) =>
  c.state === "wait" ? "待核准" : c.state === "sent" ? "等待本機回應" : `已決定（${c.result}）`;

/**
 * The cards from other conversations, above the composer: set off from the thread so none is read
 * as this conversation's, and bounded so the composer always shows. Cut off by the bound, it says
 * there is more below.
 *
 * Two or more go one at a time behind a pager (M4-P4b): only the one shown is in the page, so no
 * other card's button can be pressed, focused or clicked by a script. Which one is shown is App's
 * (`shown`), and only the arrows change it: a decision, a timer or a card that comes does not.
 */
export function PinnedDock(props: {
  cards: readonly DockCard[];
  /** The card shown when there are two or more. */
  shown: string | undefined;
  /** An arrow was pressed. */
  onShow: (id: string) => void;
  /** Bumped when the card shown was just decided: the focus goes to it, not to another card. */
  settled: number;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const check = () => {
    const el = scroll.current;
    if (el !== null) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  };
  // After every render (a card came, went or changed) and whenever its size changes.
  useLayoutEffect(check);
  const { cards } = props;
  const paged = cards.length > 1;
  useEffect(() => {
    const el = scroll.current;
    if (el === null || typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(check);
    watch.observe(el);
    return () => watch.disconnect();
  }, [paged]);
  const shown = paged ? cards.find((c) => c.id === props.shown) : undefined;
  const at = shown === undefined ? -1 : cards.indexOf(shown);
  // A card changed to starts at its top: left scrolled down, its buttons would be where the last
  // one's were.
  useLayoutEffect(() => {
    if (shown !== undefined && scroll.current !== null) scroll.current.scrollTop = 0;
  }, [shown?.id]);
  // Decided, the focus stays on that card: its buttons are off now, and Enter on the card does
  // nothing, where on another card's deny it would decide one not read.
  useEffect(() => {
    if (props.settled > 0) box.current?.focus({ preventScroll: true });
  }, [props.settled]);
  // Said once per card changed to, not again when a count changes (a card that comes is
  // announced by App).
  const [said, setSaid] = useState("");
  const lastShown = useRef(shown?.id);
  useEffect(() => {
    if (shown === undefined || shown.id === lastShown.current) return;
    const first = lastShown.current === undefined;
    lastShown.current = shown.id;
    if (!first)
      setSaid(
        `第 ${at + 1} 張，共 ${cards.length} 張：${shown.title}，${shown.script}，${stateOf(shown)}`,
      );
  }, [shown?.id]);
  const moreNote = more ? (
    <div className="pinned-more" aria-hidden="true">
      還有內容，向下捲動
    </div>
  ) : null;
  const waits = (cs: readonly DockCard[]) => cs.filter((c) => c.state === "wait").length;
  const before = waits(cards.slice(0, at));
  const after = waits(cards.slice(at + 1));
  const arrow = (dir: "prev" | "next") => {
    const to = cards[dir === "prev" ? at - 1 : at + 1];
    const n = dir === "prev" ? before : after;
    const name = dir === "prev" ? "上一張待核准" : "下一張待核准";
    return (
      <Button
        className={`pager-arrow pager-${dir}`}
        disabled={to === undefined}
        // At the end it stays focusable, so the focus is not dropped on the page.
        focusableWhenDisabled
        aria-label={n > 0 ? `${name}（這個方向還有 ${n} 張待核准）` : name}
        onClick={() => {
          if (to !== undefined) props.onShow(to.id);
        }}
      >
        <span aria-hidden="true">{dir === "prev" ? "‹" : "›"}</span>
        {n > 0 ? (
          <span className="pager-badge" aria-hidden="true">
            {n}
          </span>
        ) : null}
      </Button>
    );
  };
  // One tree for one card and for many, the pager's parts empty for one: going from one to two
  // keeps the card shown in the page, and with it the focus.
  return (
    <section
      className={shown === undefined ? "pinned-approvals" : "pinned-approvals paged"}
      aria-label="其他對話的核准"
    >
      <div className="pinned-head">
        其他對話的核准（{cards.length}）
        {shown === undefined ? null : (
          <span className="pinned-head-wait" aria-live="polite">
            {before + after > 0 ? ` · 其他還有 ${before + after} 張待核准` : ""}
          </span>
        )}
      </div>
      {shown === undefined ? null : (
        <div className="pager" role="group" aria-label={`待核准 ${at + 1}／${cards.length}`}>
          {arrow("prev")}
          <div className="pager-title">
            <span className="pager-line">
              <span className={`status-dot ${dotOf(shown)}`} aria-hidden="true" />
              <span className="pager-name">
                {shown.title}
                <span className="pager-script-main">
                  {" · "}
                  <span className="mono">{shown.script}</span>
                </span>
              </span>
            </span>
            <span className="pager-line pager-meta">
              <span className="mono">
                {at + 1}/{cards.length}
              </span>
              <span>· {stateOf(shown)}</span>
              {/* Before the script: on a phone the line is cut at its end, never this warning. */}
              {shown.external ? <span className="sg-tag warn">寫外部</span> : null}
              <span className="mono pager-script-sub">· {shown.script}</span>
              <span className="mono pager-detail">· {shown.detail}</span>
            </span>
          </div>
          {arrow("next")}
        </div>
      )}
      {shown === undefined ? null : (
        <div className="sr-only" aria-live="polite">
          {said}
        </div>
      )}
      <div className="pinned-scroll" ref={scroll} onScroll={check}>
        {(shown === undefined ? cards : [shown]).map((c) => (
          <div
            className="pager-card"
            key={c.id}
            {...(shown === undefined ? {} : { ref: box, tabIndex: -1 })}
          >
            {c.node}
          </div>
        ))}
      </div>
      {moreNote}
    </section>
  );
}
