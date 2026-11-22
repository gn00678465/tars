// @vitest-environment jsdom
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import { Prose } from "./Thread.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

test("line breaks stay in the text, and a fenced block is code, as text only", async () => {
  const text =
    '分三行：\n一\n二\n三\n```ts\n2026-11-22 * "午餐"\n  <b>Expenses</b>  120 TWD\n```\n完成';
  const { root, unmount } = await render(<Prose text={text} tail="（不完整）" />);
  const [first, last] = [...root.querySelectorAll("p")];
  expect(first?.textContent).toBe("分三行：\n一\n二\n三\n");
  const code = root.querySelectorAll("pre.tool-code-box");
  expect(code).toHaveLength(1);
  // The language name is dropped; the markup-looking text stays text.
  expect(code[0]?.textContent).toBe('2026-11-22 * "午餐"\n  <b>Expenses</b>  120 TWD');
  expect(root.querySelector("b")).toBeNull();
  expect(last?.textContent).toBe("\n完成（不完整）");
  unmount();
});

test("a fence still open while streaming is drawn as code", async () => {
  const { root, unmount } = await render(<Prose text={"預覽：\n```\nline 1\nline 2"} />);
  expect(root.querySelector("pre")?.textContent).toBe("line 1\nline 2");
  unmount();
});
