import { type RefObject, useEffect, useRef } from "react";

const OPTION = 'button[role^="menuitem"]:not(:disabled)';

/**
 * A desktop menu that drops from its button (the prototype's model and effort popovers): while
 * `open`, the chosen option or else the first takes the focus; ↑ ↓ Home End move it; Esc closes
 * and gives the focus back to the button; a press outside `anchor`, or Tab out of it, closes.
 */
export function usePopover(
  anchor: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const box = menu.current;
    if (!open || box === null) return;
    const options = () => [...box.querySelectorAll<HTMLElement>(OPTION)];
    (box.querySelector<HTMLElement>(`${OPTION}[aria-checked="true"]`) ?? options()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        anchor.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
        return close.current();
      }
      if (!box.contains(document.activeElement)) return;
      const all = options();
      const at = all.indexOf(document.activeElement as HTMLElement);
      const to =
        e.key === "ArrowDown"
          ? (at + 1) % all.length
          : e.key === "ArrowUp"
            ? (at - 1 + all.length) % all.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? all.length - 1
                : undefined;
      if (to !== undefined) {
        e.preventDefault();
        all[to]?.focus();
      }
    };
    const onPress = (e: PointerEvent) => {
      if (!(anchor.current?.contains(e.target as Node) ?? false)) close.current();
    };
    const onFocus = (e: FocusEvent) => {
      if (!(anchor.current?.contains(e.target as Node) ?? false)) close.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("focusin", onFocus);
    };
  }, [anchor, menu, open]);
}
