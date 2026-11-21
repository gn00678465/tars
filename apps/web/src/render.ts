import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders into a fresh element in the document; the test removes it with unmount. */
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
  return {
    root,
    rerender: (next) => act(async () => r?.render(next)),
    unmount: () => {
      act(() => r?.unmount());
      root.remove();
    },
  };
}

export const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
export const button = (root: HTMLElement, text: string) => {
  const b = buttons(root).find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
