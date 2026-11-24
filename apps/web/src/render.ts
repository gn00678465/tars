import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every root render made and not yet unmounted. test-setup.ts unmounts them after each test: a
 * root left mounted can schedule work (Base UI's Collapsible a few ms after it opens) that React
 * runs after the file's jsdom is gone, a "window is not defined" outside any test.
 */
const mounted = new Set<() => void>();

/** Unmounts every root a test left; test-setup.ts runs it after each test. */
export function unmountAll() {
  for (const unmount of mounted) unmount();
}

/** Renders into a fresh element in the document; the test may remove it with unmount. */
export async function render(el: ReactElement): Promise<{
  root: HTMLElement;
  unmount: () => void;
  rerender: (el: ReactElement) => Promise<void>;
}> {
  const root = document.createElement("div");
  document.body.append(root);
  let r: Root | undefined;
  await act(async () => {
    r = createRoot(root);
    r.render(el);
  });
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => r?.unmount());
    root.remove();
  };
  mounted.add(unmount);
  return { root, rerender: (next) => act(async () => r?.render(next)), unmount };
}

export const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
export const button = (root: HTMLElement, text: string) => {
  const b = buttons(root).find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
