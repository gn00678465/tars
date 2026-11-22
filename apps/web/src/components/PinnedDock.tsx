import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The cards from other conversations, above the composer: set off from the thread so none is read
 * as this conversation's, and bounded so the composer always shows. Cut off by the bound, it says
 * there is more below.
 */
export function PinnedDock(props: { count: number; children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const check = () => {
    const el = scroll.current;
    if (el !== null) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  };
  // After every render (a card came, went or changed) and whenever its size changes.
  useLayoutEffect(check);
  useEffect(() => {
    const el = scroll.current;
    if (el === null || typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(check);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <section className="pinned-approvals" aria-label="其他對話的核准">
      <div className="pinned-head">其他對話的核准（{props.count}）</div>
      <div className="pinned-scroll" ref={scroll} onScroll={check}>
        {props.children}
      </div>
      {more ? (
        <div className="pinned-more" aria-hidden="true">
          還有內容，向下捲動
        </div>
      ) : null}
    </section>
  );
}
