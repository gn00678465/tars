import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * While `open`: Tab and Shift+Tab stay inside `ref`, Esc calls `onClose`, and the focus goes in.
 * On closing, the focus goes back to where it was, unless something else has taken it since
 * (opening a conversation from the drawer moves it to the thread).
 */
export function useModal(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  // The caller's onClose is a new function each render; the effect must not rerun for it, or
  // its cleanup would pull the focus back on every render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const box = ref.current;
    if (!open || box === null) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The first control takes the focus here, not by autoFocus: React focuses those before this
    // effect runs, and `before` would be lost.
    if (!box.contains(document.activeElement)) box.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        return close.current();
      }
      if (e.key !== "Tab") return;
      const all = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = all[0];
      const last = all.at(-1);
      if (first === undefined || last === undefined) return;
      const at = document.activeElement;
      if (e.shiftKey ? at === first || !box.contains(at) : at === last || !box.contains(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const now = document.activeElement;
      if (
        before?.isConnected === true &&
        (now === null || now === document.body || box.contains(now))
      )
        before.focus();
    };
  }, [ref, open]);
}
