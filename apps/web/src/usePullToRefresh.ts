import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * Pull to refresh for the home-screen app (M4): iOS gives a standalone PWA no pull of its own,
 * so a new deploy needed the app closed. Touch only: a mouse or trackpad fires no touch events.
 * The page reloads; turns and waiting approvals live at the local end and come back with the
 * snapshot.
 */
export type Pull = "idle" | "pulling" | "ready" | "busy" | "blocked";

export interface PullState {
  /** A finger has touched the scroller: until then nothing is drawn. */
  touched: boolean;
  pull: Pull;
  /** How far, in steps: the indicator's height comes from the class, not the finger. */
  step: 0 | 1 | 2 | 3;
}

/** Pulled this far and let go, the page reloads. */
export const PULL_PX = 70;
/** A finger moved less than this has not chosen up, down or sideways yet. */
const SLOP_PX = 8;

/** Where a pull does not start: the finger is on a control, or on something of its own to drag. */
const OWN_GESTURE =
  'input, textarea, select, button, a[href], label, form, [contenteditable]:not([contenteditable="false"]), pre, table';
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/**
 * An open overlay: our sheets and the drawer say aria-modal, Base UI's modal popups mark the rest
 * of the page inert or aria-hidden, and its menus and lists are there only while open. A closed
 * one leaving the DOM late is hidden.
 */
const OVERLAY = '[aria-modal="true"], [data-base-ui-inert], [role="menu"], [role="listbox"]';

function overlayOpen(el: HTMLElement) {
  if (el.closest('[inert], [aria-hidden="true"]') !== null) return true;
  return [...document.querySelectorAll(OVERLAY)].some((n) => n.closest("[hidden]") === null);
}

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
  return target.closest(OWN_GESTURE) === null && !sideways(target, el) && !overlayOpen(el);
}

const stepOf = (dy: number): PullState["step"] => (dy < 24 ? 1 : dy < 48 ? 2 : 3);

/**
 * Watches `scroller` for a one-finger pull down from its top. `draft` says whether the composer
 * holds unsent text: then a pull says so and letting go does nothing, as a reload would lose it.
 * `off` while the app has an overlay of its own open. `reload` is the page's, for tests.
 */
export function usePullToRefresh(
  scroller: RefObject<HTMLElement | null>,
  options: { draft: () => boolean; off?: boolean; reload?: () => void },
): PullState {
  const [state, setState] = useState<PullState>({ touched: false, pull: "idle", step: 0 });
  // The listeners are added once; what they read changes each render.
  const opts = useRef(options);
  opts.current = options;

  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    let finger: { id: number; x: number; y: number } | undefined;
    let pulling = false;
    let ready = false;
    const show = (pull: Pull, step: PullState["step"]) =>
      setState((s) =>
        s.pull === pull && s.step === step && s.touched ? s : { touched: true, pull, step },
      );
    const stop = () => {
      finger = undefined;
      pulling = false;
      ready = false;
      show("idle", 0);
    };
    const start = (e: TouchEvent) => {
      stop();
      const t = e.touches[0];
      if (e.touches.length !== 1 || t === undefined || opts.current.off === true) return;
      if (!mayStart(el, e.target)) return;
      finger = { id: t.identifier, x: t.clientX, y: t.clientY };
    };
    const move = (e: TouchEvent) => {
      if (finger === undefined) return;
      if (e.touches.length !== 1) return stop();
      const id = finger.id;
      const t = [...e.touches].find((x) => x.identifier === id);
      if (t === undefined) return stop();
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
      if (dy <= 0) return stop();
      // Only now, and only down: iOS's own bounce would fight the pull.
      e.preventDefault();
      if (opts.current.draft()) return show("blocked", stepOf(dy));
      ready = dy >= PULL_PX;
      show(ready ? "ready" : "pulling", ready ? 3 : stepOf(dy));
    };
    const end = (e: TouchEvent) => {
      if (finger === undefined) return;
      const id = finger.id;
      if (![...e.changedTouches].some((x) => x.identifier === id)) return;
      if (!ready) return stop();
      finger = undefined;
      show("busy", 3);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", stop);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", stop);
    };
  }, [scroller]);

  // After the commit, so "重新整理中…" is on the page while the reload starts.
  useEffect(() => {
    if (state.pull === "busy") (opts.current.reload ?? (() => location.reload()))();
  }, [state.pull]);
  return state;
}
