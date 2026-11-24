// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { App } from "./App.tsx";
import { render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

test("F2, F3: the top bar says the list's date, then the model whose price needs confirming", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  const status = (extra: object) =>
    server("status", {
      now: 1,
      providers: [],
      pricesWarn: false,
      pendingApprovals: 0,
      turnRunning: false,
      notify: "ok",
      ...extra,
    });
  await act(async () => {
    h.last().receive(server("relay.status", { online: true }));
    h.last().receive(status({}));
    h.last().receive(
      server("models.result", {
        models: [],
        updatedAt: "2026-11-19",
        catalog: [
          {
            provider: "anthropic",
            id: "claude-opus-4-1",
            label: "Claude Opus 4.1",
            status: "active",
          },
        ],
      }),
    );
  });
  const desktop = () => root.querySelector(".topbar-right .desktop-only") as HTMLElement;
  const phone = () => root.querySelector(".topbar-right .mobile-only") as HTMLElement;
  expect(desktop().textContent).toBe("花費與模型11-19");
  await act(async () =>
    h.last().receive(
      status({
        pricesWarn: true,
        prices: [{ provider: "anthropic", model: "claude-opus-4-1", ageDays: 34, state: "stale" }],
      }),
    ),
  );
  expect(desktop().textContent).toBe("Claude Opus 4.1 價目 34 天未確認");
  expect(phone().textContent).toBe("價目待確認");
  await act(async () => desktop().click());
  const sheet = document.querySelector(".sheet-panel") as HTMLElement;
  expect(sheet.querySelector("h2")?.textContent).toBe("花費、模型清單與價目表（唯讀）");
  expect(sheet.querySelectorAll(".catalog-table tbody tr")).toHaveLength(1);
  expect(sheet.textContent).toContain("模型啟用、單價與額度只能在本機終端修改");
  unmount();
});
