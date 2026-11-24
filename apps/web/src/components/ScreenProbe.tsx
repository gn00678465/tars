import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * What this page sees of the screen, to find out why the composer has more room under it on an
 * iPhone's home-screen window than the code leaves (docs: M4/research/ios_pwa_safe_area.md).
 * The probes are elements measured at run time, set in app.css, not styled from here; they are
 * portaled to <body> because a drawer's transform would make `position: fixed` mean "inside
 * the drawer". The numbers are printed on the screen: the owner has no inspector on the phone.
 */
const PROBES = ["vh", "svh", "lvh", "dvh", "fixed", "env-top", "env-bottom"] as const;
type Probe = (typeof PROBES)[number];

const px = (n: number | undefined) => (n === undefined ? "—" : String(Math.round(n * 10) / 10));

export function ScreenProbe() {
  const refs = useRef<Partial<Record<Probe, HTMLDivElement | null>>>({});
  const [text, setText] = useState("");
  const [line, setLine] = useState(false);
  const [open, setOpen] = useState(false);

  const read = useCallback(() => {
    const h = (p: Probe) => refs.current[p]?.getBoundingClientRect().height;
    const bottom = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().bottom;
    const vv = window.visualViewport;
    const dock = document.querySelector(".composer-dock");
    const at = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 4);
    const nav = navigator as Navigator & { standalone?: boolean };
    const rows: [string, string][] = [
      ["standalone", String(nav.standalone)],
      ["display-mode standalone", String(matchMedia("(display-mode: standalone)").matches)],
      ["devicePixelRatio", px(window.devicePixelRatio)],
      ["screen 寬×高", `${screen.width}×${screen.height}`],
      ["innerHeight", px(window.innerHeight)],
      ["documentElement.clientHeight", px(document.documentElement.clientHeight)],
      ["visualViewport 高", px(vv?.height)],
      ["visualViewport.offsetTop", px(vv?.offsetTop)],
      ["scrollY", px(window.scrollY)],
      ["100vh", px(h("vh"))],
      ["100svh", px(h("svh"))],
      ["100lvh", px(h("lvh"))],
      ["100dvh", px(h("dvh"))],
      ["fixed top:0 bottom:0 的高", px(h("fixed"))],
      ["env(safe-area-inset-top)", px(h("env-top"))],
      ["env(safe-area-inset-bottom)", px(h("env-bottom"))],
      ["html 下緣", px(document.documentElement.getBoundingClientRect().bottom)],
      ["body 下緣", px(document.body.getBoundingClientRect().bottom)],
      ["app-viewport 下緣", px(bottom(".app-viewport"))],
      ["composer-dock 下緣", px(dock?.getBoundingClientRect().bottom)],
      ["composer-dock 底部 padding", dock === null ? "—" : getComputedStyle(dock).paddingBottom],
      ["輸入框下緣到 innerHeight", px(window.innerHeight - (bottom(".composer-wrap") ?? 0))],
      [
        "最底下 4px 處的元素",
        at === null ? "（無）" : `${at.tagName.toLowerCase()}.${String(at.className).slice(0, 40)}`,
      ],
      ["userAgent", navigator.userAgent],
    ];
    setText(rows.map(([k, v]) => `${k}: ${v}`).join("\n"));
  }, []);

  // Read only while it is open: the sheet opens often, and the numbers are for one look.
  useEffect(() => {
    if (!open) return;
    read();
    window.addEventListener("resize", read);
    window.visualViewport?.addEventListener("resize", read);
    return () => {
      window.removeEventListener("resize", read);
      window.visualViewport?.removeEventListener("resize", read);
    };
  }, [open, read]);

  return (
    <details className="screen-probe" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>畫面診斷（排查底部空白用）</summary>
      <pre className="screen-probe-out">{text}</pre>
      <div className="screen-probe-actions">
        <button className="sg-btn" type="button" onClick={read}>
          重新讀取
        </button>
        <button className="sg-btn" type="button" onClick={() => setLine((v) => !v)}>
          {line ? "隱藏" : "顯示"}螢幕底緣的紅線
        </button>
      </div>
      {createPortal(
        <>
          {PROBES.map((p) => (
            <div
              key={p}
              ref={(el) => {
                refs.current[p] = el;
              }}
              className={`probe probe-${p}`}
              aria-hidden="true"
            />
          ))}
          {line ? <div className="probe-line" aria-hidden="true" /> : null}
        </>,
        document.body,
      )}
    </details>
  );
}
