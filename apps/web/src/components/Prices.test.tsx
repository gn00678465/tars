// @vitest-environment jsdom
import type { WireStatus } from "@tars/protocol";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import type { State } from "../state.ts";
import { PriceNotices, PriceTable, priceButtonText, updatedText } from "./Prices.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const catalog: NonNullable<State["catalog"]> = {
  updatedAt: "2026-11-19",
  total: 9,
  entries: [
    {
      provider: "anthropic",
      id: "claude-opus-4-1",
      label: "Claude Opus 4.1",
      status: "active",
      window: 200_000,
      price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      priceSource: "manual",
      pricedAt: "2026-10-16",
    },
    {
      provider: "gemini",
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      status: "active",
      window: 1_048_576,
      price: { input: 0.3, output: 2.5 },
      priceSource: "openrouter",
      pricedAt: "2026-11-19",
    },
    {
      provider: "anthropic",
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      status: "candidate",
    },
  ],
};

const status = (extra: Partial<WireStatus>): WireStatus => ({
  now: 0,
  providers: [],
  pricesWarn: true,
  pendingApprovals: 0,
  turnRunning: false,
  notify: "ok",
  ...extra,
});

test("F3, F2: the top bar's list date and the first model whose price needs confirming", () => {
  expect(updatedText(catalog)).toBe("11-19");
  expect(updatedText(undefined)).toBeUndefined();
  const s = status({
    prices: [{ provider: "anthropic", model: "claude-opus-4-1", ageDays: 34, state: "stale" }],
  });
  expect(priceButtonText(s, catalog)).toBe("Claude Opus 4.1 價目 34 天未確認");
  // Without the list, the id; without prices (an older local end), nothing.
  expect(priceButtonText(s, undefined)).toBe("claude-opus-4-1 價目 34 天未確認");
  expect(priceButtonText(status({}), catalog)).toBeUndefined();
});

test("F2: one notice per provider: the model, its age, the candidates, the command", async () => {
  const { root } = await render(
    <PriceNotices
      status={status({
        prices: [
          { provider: "anthropic", model: "claude-opus-4-1", ageDays: 34, state: "stale" },
          { provider: "gemini", model: "gemini-2.5-flash", ageDays: 120, state: "refused" },
          { provider: "gemini", model: "gemini-x", state: "missing" },
        ],
        candidates: 1,
      })}
      catalog={catalog}
    />,
  );
  const notices = [...root.querySelectorAll(".task-notice")].map((n) => [
    n.className,
    n.querySelector(".task-notice-title")?.textContent,
    n.querySelector(".task-notice-desc")?.textContent,
    n.querySelector(".cli-copy-cmd")?.textContent,
  ]);
  expect(notices).toEqual([
    [
      "task-notice warn",
      "Anthropic Claude Opus 4.1 價目已 34 天未確認 · 有 1 個候選模型未啟用",
      "超過暫停門檻後會暫停使用。核對官方價目頁後，在本機終端確認日期。",
      "tars models confirm-prices --provider anthropic",
    ],
    [
      "task-notice error",
      "Gemini 有 2 個模型的價目需要確認",
      "Gemini 2.5 Flash（價目 120 天未確認）、gemini-x（沒有價目）。價目過期太久，這個模型已暫停使用。核對官方價目頁後，在本機終端確認日期。",
      "tars models confirm-prices --provider gemini",
    ],
  ]);
});

test("F1: every model with its status, window, four prices, source and date; read only", async () => {
  const { root } = await render(
    <PriceTable
      catalog={catalog}
      warns={[{ provider: "anthropic", model: "claude-opus-4-1", ageDays: 34, state: "stale" }]}
    />,
  );
  const rows = [...root.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent),
  );
  expect(rows).toEqual([
    [
      "Anthropic",
      "Claude Opus 4.1claude-opus-4-1",
      "啟用",
      "200K",
      "15 / 75 / 1.5 / 18.75",
      "手填 · 2026-10-16過期警告",
    ],
    [
      "Gemini",
      "Gemini 2.5 Flashgemini-2.5-flash",
      "啟用",
      "1,049K",
      "0.3 / 2.5 / — / —",
      "OpenRouter · 2026-11-19",
    ],
    ["Anthropic", "Claude Haiku 4.5claude-haiku-4-5", "候選", "—", "—", "—"],
  ]);
  expect(root.querySelector(".provider-group-sub")?.textContent).toBe("2026-11-19 更新");
  expect(root.querySelector(".catalog-note")?.textContent).toBe(
    "單價是每百萬 tokens 的美元價格，日期是確認價目的 UTC 日期。清單共 9 個模型，這裡列出前 3 個，啟用的在前。",
  );
  expect(root.querySelectorAll("input, button, select")).toHaveLength(0);
});
