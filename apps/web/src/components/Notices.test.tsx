// @vitest-environment jsdom
import { noticeTone } from "../testing.ts";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import type { Notice } from "../state.ts";
import { NoticeCard } from "./Notices.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

async function shown(notice: Notice, effort?: string) {
  const { root } = await render(
    <NoticeCard notice={notice} context={{ provider: "gemini", effort }} />,
  );
  const card = root.querySelector(".task-notice") as HTMLElement;
  return {
    tone: noticeTone(card),
    role: card.getAttribute("role"),
    icon: card.querySelector(".task-notice-title svg") !== null,
    title: card.querySelector(".task-notice-title")?.textContent,
    desc: card.querySelector(".task-notice-desc")?.textContent,
    command: card.querySelector(".cli-copy-cmd")?.textContent,
  };
}

// Each code with the data the engine sends (src/features/agent/engine.ts).
test.each<[Notice, string, string, string | undefined]>([
  [
    { code: "compact_start" },
    "task-notice active",
    "上下文接近上限，正在壓縮較早的部分",
    "較早的訊息會換成摘要，本機資料庫的原始紀錄仍完整保存。",
  ],
  [
    { code: "compact_skipped" },
    "task-notice warn",
    "上下文接近上限，但沒有可以壓縮的部分",
    "可以開新對話，或以另一個模型接續。",
  ],
  [
    { code: "compact_failed", data: { reason: "provider_error" } },
    "task-notice warn",
    "自動壓縮失敗",
    "provider 暫時無法回應，重試用完了，請稍後再試。這則訊息照常送出。",
  ],
  [
    { code: "budget_warn", data: { spentUsd: 81.234, quotaUsd: 100 } },
    "task-notice warn",
    "本期已用 81.23 / 100.00 USD，已過提醒門檻",
    "到停用門檻時，本機端會停止送出這家 provider 的請求。",
  ],
  [
    { code: "context_warn", data: { percent: 72, autoCompact: "on" } },
    "task-notice warn",
    "上下文已用 72%",
    "達到壓縮門檻時，會自動把較早的部分壓縮成摘要。",
  ],
  [
    { code: "context_warn", data: { percent: 72, autoCompact: "off" } },
    "task-notice warn",
    "上下文已用 72%",
    "自動壓縮沒有開啟。用完之前，請開新對話或以另一個模型接續。",
  ],
  [
    { code: "retrying", data: { attempt: 2, waitMs: 4000 } },
    "task-notice active",
    "provider 暫時無法回應，4 秒後重試",
    "已失敗 2 次。",
  ],
  [
    { code: "output_capped", data: { maxTokens: 12000 } },
    "task-notice warn",
    "這次的輸出上限降到 12,000 tokens",
    "剩下的預算不夠原本的輸出上限，回覆可能被截斷。",
  ],
  [
    { code: "effort_unsupported" },
    "task-notice",
    "這個模型不支援推理強度",
    "這次請求不帶推理強度設定。",
  ],
  [
    { code: "usage_missing" },
    "task-notice warn",
    "這個請求沒有回報用量",
    "這次的花費依輸入與輸出長度估算。",
  ],
  [
    { code: "blocked", data: { reason: "memory remember 只在本機終端執行" } },
    "task-notice warn",
    "已擋下：這個入口不提供這個指令",
    "memory remember 只在本機終端執行",
  ],
  [{ code: "later_code", data: { n: 1 } }, "task-notice", "本機端通知：later_code", "n=1"],
])("%o: a task-notice with an icon, title and what it means", async (notice, tone, title, desc) => {
  const s = await shown(notice);
  expect(s).toMatchObject({ tone, role: "status", icon: true, title, desc });
});

test("prices_warn: the days, and the command for this conversation's provider", async () => {
  expect(await shown({ code: "prices_warn", data: { days: 34 } })).toMatchObject({
    tone: "task-notice warn",
    title: "模型價目已 34 天沒有確認",
    command: "tars models confirm-prices --provider gemini",
  });
});

test("effort_clamped: the level asked for and the one used, as the prototype says", async () => {
  expect((await shown({ code: "effort_clamped", data: { effort: "medium" } }, "xhigh")).title).toBe(
    "模型不支援「極高」，已改用「中」",
  );
  document.body.innerHTML = "";
  // The conversation's level unknown: only the one used.
  expect((await shown({ code: "effort_clamped", data: { effort: "medium" } })).title).toBe(
    "模型不支援原本的推理強度，已改用「中」",
  );
});
