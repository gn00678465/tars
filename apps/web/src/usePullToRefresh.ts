import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * Pull to refresh for the home-screen app (M4): iOS gives a standalone PWA no pull of its own,
 * so a new deploy needed the app closed. Touch only: a mouse or trackpad fires no touch events.
 * The page reloads; turns and waiting approvals live at the local end and come back with the
 * snapshot. As iOS's own pull, the page above the composer follows the finger down and the
 * indicator is in the space it leaves at the top.
 */
export type Pull = "idle" | "pulling" | "ready" | "blocked" | "busy" | "back";

export interface PullState {
  /** A finger has touched the scroller: until then nothing is drawn. */
  touched: boolean;
  /** busy: let go past the rest, settling there, then the reload; back: settling to 0. */
  pull: Pull;
}

/** The page moves this much of the finger's way, up to MAX_PX. */
export const DAMPING = 0.5;
export const MAX_PX = 120;
/**
 * Where the page rests while it reloads: the indicator's height (app.css). Moved this far, the
 * indicator is all in sight and letting go reloads.
 */
export const REST_PX = 56;
/** The settle to REST_PX or back to 0; app.css's transition is as long. */
export const SETTLE_MS = 200;
/** A finger moved less than this has not chosen up, down or sideways yet. */
const SLOP_PX = 8;

/** Where a pull does not start: the finger is on a control, or on something of its own to drag. */
const OWN_GESTURE =
  'input, textarea, select, button, a[href], label, form, [contenteditable]:not([contenteditable="false"]), pre, table';
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/**
 * An open overlay. Each of Base UI's (Dialog, Drawer, Sheet, Popover, DropdownMenu) marks the page
 * root outside its portal data-base-ui-inert while open, and takes it off on closing: measured in
 * Chromium on every one at both widths (tools/visual/pull.ts). The workspace is not made
 * aria-hidden (App.tsx keeps it exposed), so that mark is the one to read; inert and aria-hidden
 * are content that takes no input anyway.
 */
const BEHIND_OVERLAY = '[data-base-ui-inert], [inert], [aria-hidden="true"]';

/** Between the finger and the scroller, something that scrolls sideways takes the drag. */
function sideways(from: Element, el: HTMLElement) {
  for (let n: Element | null = from; n !== null && n !== el; n = n.parentElement) {
    const x = getComputedStyle(n).overflowX;
    if ((x === "auto" || x === "scroll") && n.scrollWidth > n.clientWidth) return true;
  }
  return false;
}

function mayStart(el: HTMLElement, target: EventTarget | null) {
  if (el.scrollTop > 0 || !(target instanceof Element)) return false;
  // The soft keyboard is up: the drag is the owner's, and a reload would close it.
  if (document.activeElement?.matches(EDITABLE) === true) return false;
  return (
    target.closest(OWN_GESTURE) === null &&
    !sideways(target, el) &&
    el.closest(BEHIND_OVERLAY) === null
  );
}

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Watches `scroller` for a one-finger pull down from its top, and moves `page` with the finger.
 * `draft` says whether the composer holds unsent text: then a pull says so and letting go does
 * nothing, as a reload would lose it. `reload` is the page's, for tests.
 */
export function usePullToRefresh(
  scroller: RefObject<HTMLElement | null>,
  options: { page: RefObject<HTMLElement | null>; draft: () => boolean; reload?: () => void },
): PullState {
  const [state, setState] = useState<PullState>({ touched: false, pull: "idle" });
  // The listeners are added once; what they read changes each render.
  const opts = useRef(options);
  opts.current = options;

  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    let finger: { id: number; x: number; y: number } | undefined;
    let pulling = false;
    let ready = false;
    let busy = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const show = (pull: Pull) =>
      setState((s) => (s.pull === pull && s.touched ? s : { touched: true, pull }));
    /**
     * The one style this file writes, and the only exception to "no style in the source"
     * (components/ui/ui.test.ts checks it is this call and this variable only): the page's
     * offset follows the finger by the pixel, which no set of classes can. It is the CSSOM, which
     * the CSP lets through (as Base UI's own, tools/visual/csp.ts), not a style attribute. app.css
     * turns it into a transform only while a pull is on.
     */
    const moveTo = (y: number) =>
      opts.current.page.current?.style.setProperty("--pull-y", `${y}px`);
    /** Back to 0, eased unless the owner asked for less motion; then nothing is drawn moved. */
    const back = () => {
      finger = undefined;
      clearTimeout(settle);
      const was = pulling;
      pulling = false;
      ready = false;
      moveTo(0);
      if (!was || reducedMotion()) return show("idle");
      show("back");
      settle = setTimeout(() => {
        settle = undefined;
        show("idle");
      }, SETTLE_MS);
    };
    const start = (e: TouchEvent) => {
      if (busy) return;
      finger = undefined;
      // A new touch while the page settles back: it is at 0 from here.
      if (pulling || settle !== undefined) {
        clearTimeout(settle);
        settle = undefined;
        pulling = false;
        ready = false;
        moveTo(0);
      }
      show("idle");
      const t = e.touches[0];
      if (e.touches.length !== 1 || t === undefined) return;
      if (!mayStart(el, e.target)) return;
      finger = { id: t.identifier, x: t.clientX, y: t.clientY };
    };
    const move = (e: TouchEvent) => {
      if (finger === undefined) return;
      if (e.touches.length !== 1) return back();
      const id = finger.id;
      const t = [...e.touches].find((x) => x.identifier === id);
      if (t === undefined) return back();
      const dy = t.clientY - finger.y;
      const dx = t.clientX - finger.x;
      if (!pulling) {
        if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
        // Up is scrolling the thread, sideways is someone else's: the gesture is left alone.
        if (dy <= 0 || Math.abs(dx) > dy || el.scrollTop > 0) {
          finger = undefined;
          return;
        }
        pulling = true;
      }
      if (dy <= 0) return back();
      // Only now, and only down: iOS's own bounce would fight the pull.
      e.preventDefault();
      const y = Math.min(dy * DAMPING, MAX_PX);
      moveTo(y);
      if (opts.current.draft()) {
        ready = false;
        return show("blocked");
      }
      ready = y >= REST_PX;
      show(ready ? "ready" : "pulling");
    };
    const end = (e: TouchEvent) => {
      if (finger === undefined) return;
      const id = finger.id;
      if (![...e.changedTouches].some((x) => x.identifier === id)) return;
      if (!ready) return back();
      finger = undefined;
      busy = true;
      moveTo(REST_PX);
      show("busy");
      // At rest first, so 重新整理中… is still where it was when the reload starts.
      settle = setTimeout(
        () => (opts.current.reload ?? (() => location.reload()))(),
        reducedMotion() ? 0 : SETTLE_MS,
      );
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", back);
    return () => {
      clearTimeout(settle);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", back);
    };
  }, [scroller]);
  return state;
}
