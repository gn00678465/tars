// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";
import { App } from "./App.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

test("renders", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => createRoot(root).render(<App />));
  expect(root.textContent).toBe("tars");
});
