// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { button, render } from "../render.ts";
import { ErrorCard } from "./ErrorCard.tsx";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

test("a key the provider refused: icon, what happened and what it means, the command copied", async () => {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: { writeText: async (t: string) => void written.push(t) },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { root } = await render(<ErrorCard code="auth" provider="openrouter" />);
    const card = root.querySelector(".task-notice") as HTMLElement;
    expect([card.className, card.getAttribute("role")]).toEqual(["task-notice error", "status"]);
    expect(card.querySelector(".task-notice-title svg")).not.toBeNull();
    expect(root.querySelector(".task-notice-title")?.textContent).toBe("provider 拒絕了 API 金鑰");
    expect(root.querySelector(".task-notice-desc")?.textContent).toBe(
      "OpenRouter 回絕這個金鑰。請在本機終端重新設定金鑰。",
    );
    expect(root.querySelector(".cli-copy-cmd")?.textContent).toBe("tars llm key set openrouter");
    await act(async () => button(root, "複製指令").click());
    expect(written).toEqual(["tars llm key set openrouter"]);
    expect(root.querySelector(".cli-copy-row button")?.textContent).toBe("已複製");
    // As the prototype: back to 複製指令 after 1.8 s.
    await act(async () => void vi.advanceTimersByTime(1_799));
    expect(root.querySelector(".cli-copy-row button")?.textContent).toBe("已複製");
    await act(async () => void vi.advanceTimersByTime(1));
    expect(root.querySelector(".cli-copy-row button")?.textContent).toBe("複製指令");
  } finally {
    vi.useRealTimers();
  }
});

test.each<[string, string, string, string | undefined]>([
  [
    "turn_cap",
    "task-notice warn",
    "這個回合已自動結束。要提高上限，請在本機的設定檔調整。",
    undefined,
  ],
  [
    "budget_stopped",
    "task-notice error",
    "Gemini 暫停使用。若帳單頁的實際花費較低，請在本機終端校正。",
    "tars cost adjust gemini --spent <金額>",
  ],
  [
    "provider_spend_limit",
    "task-notice error",
    "這個回合已停止。Gemini 在下次重算或調高上限前無法使用，其他 provider 不受影響。",
    undefined,
  ],
  ["carry_over_stop", "task-notice warn", undefined, undefined],
] as [string, string, string, string | undefined][])(
  "%s: its severity, what it means, and a command when there is one",
  async (code, tone, desc, command) => {
    const { root } = await render(<ErrorCard code={code} provider="gemini" />);
    expect(root.querySelector(".task-notice")?.className).toBe(tone);
    expect(root.querySelector(".task-notice-desc")?.textContent).toBe(desc);
    expect(root.querySelector(".cli-copy-cmd")?.textContent).toBe(command);
  },
);

test("no clipboard: it says so, and the command is still there to select", async () => {
  vi.stubGlobal("navigator", {});
  const { root } = await render(<ErrorCard code="prices_stale" provider={undefined} />);
  expect(root.querySelector(".task-notice-desc")?.textContent).toBe(
    "這家 provider 的價目已過期，暫停送出請求。核對官方價目後，在本機終端確認。",
  );
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
  expect(known.root.textContent).toBe("回應中途斷線已收到的文字保留在上面。可以再送一次。");
  expect(known.root.querySelector("button")).toBeNull();
  known.unmount();
  const unknown = await render(<ErrorCard code="something_new" provider="anthropic" />);
  expect(unknown.root.textContent).toBe("錯誤：something_new");
  expect(unknown.root.querySelector(".task-notice")?.className).toBe("task-notice error");
});
