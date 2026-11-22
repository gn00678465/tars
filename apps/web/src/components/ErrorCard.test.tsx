// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { button, render } from "../render.ts";
import { ErrorCard } from "./ErrorCard.tsx";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

test("a key the provider refused: what happened, and the command for this provider, copied", async () => {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: { writeText: async (t: string) => void written.push(t) },
  });
  const { root } = await render(<ErrorCard code="auth" provider="openrouter" />);
  expect(root.querySelector(".task-notice-title")?.textContent).toBe("provider 拒絕了 API 金鑰");
  expect(root.querySelector(".cli-copy-cmd")?.textContent).toBe("tars llm key set openrouter");
  await act(async () => button(root, "複製指令").click());
  expect(written).toEqual(["tars llm key set openrouter"]);
  expect(root.textContent).toContain("已複製");
});

test("no clipboard: it says so, and the command is still there to select", async () => {
  vi.stubGlobal("navigator", {});
  const { root } = await render(<ErrorCard code="prices_stale" provider={undefined} />);
  expect(root.querySelector(".cli-copy-cmd")?.textContent).toBe(
    "tars models confirm-prices --provider <provider>",
  );
  await act(async () => button(root, "複製指令").click());
  expect(root.querySelector("[role=alert]")?.textContent).toBe(
    "無法寫入剪貼簿，請手動選取上面的指令",
  );
});

test("a reason with nothing to run shows only what happened; an unknown code shows as itself", async () => {
  const known = await render(<ErrorCard code="stream_interrupted" provider="anthropic" />);
  expect(known.root.textContent).toBe("回應中途斷線");
  expect(known.root.querySelector("button")).toBeNull();
  known.unmount();
  const unknown = await render(<ErrorCard code="something_new" provider="anthropic" />);
  expect(unknown.root.textContent).toBe("錯誤：something_new");
});
