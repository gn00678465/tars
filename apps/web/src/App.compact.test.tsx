// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { App } from "./App.tsx";
import { button, render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const CONTEXT = {
  contextUsed: 48_200,
  contextLimit: 200_000,
  cacheHitPct: 92,
  warnRatio: 0.6,
  compactRatio: 0.75,
  stopRatio: 0.85,
  autoCompact: true,
};

/** The page on conv-1, the local end having sent its context when `context` is given. */
async function opened(context?: object) {
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  await act(async () => {
    h.last().receive(server("relay.status", { online: true }));
    h.last().receive(
      server("conv.list.result", {
        convs: [{ id: "conv-1", title: "甲", provider: "anthropic", model: "m", updatedAt: 1 }],
      }),
    );
  });
  await act(async () => (r.root.querySelector(".conv-item") as HTMLButtonElement).click());
  await act(async () => {
    h.last().receive(
      server("conv.snapshot", { epoch: "epoch-1", more: false, items: [] }, { conv: "conv-1" }),
    );
    if (context !== undefined)
      h.last().receive(server("conv.context", context, { conv: "conv-1" }));
  });
  const area = r.root.querySelector("textarea") as HTMLTextAreaElement;
  const type = (value: string) =>
    act(async () => {
      // oxlint-disable-next-line typescript/unbound-method
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(area, value);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (k: string) =>
    act(
      async () => void area.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })),
    );
  const sent = (kind: string) =>
    h
      .last()
      .messages()
      .filter((m) => m.kind === kind);
  const receive = (m: unknown) => act(async () => h.last().receive(m));
  return { h, ...r, type, key, sent, receive };
}

test("an older local end (no conv.context): no ring, no /compact", async () => {
  const { root, type, unmount } = await opened();
  expect(root.querySelector(".context-trigger")).toBeNull();
  await type("/");
  expect([...root.querySelectorAll(".slash-cmd")].map((e) => e.textContent)).not.toContain(
    "/compact",
  );
  unmount();
});

test("E1, E3: the ring; /compact with what to keep sends conv.compact; 壓縮中 can be stopped", async () => {
  const { root, type, key, sent, receive, unmount } = await opened(CONTEXT);
  const ring = root.querySelector(".context-trigger") as HTMLElement;
  expect(ring.textContent).toBe("24%快取 92%");
  expect(ring.querySelector(".context-ring-fill")?.getAttribute("class")).toBe(
    "context-ring-fill ",
  );
  await type("/");
  expect(root.querySelector(".slash-cmd")?.textContent).toBe("/compact");
  await type("/compact 保留快照日期");
  await key("Enter");
  const [compact] = sent("conv.compact");
  expect([compact?.conv, compact?.p]).toEqual(["conv-1", { focus: "保留快照日期" }]);
  expect(sent("turn.submit")).toHaveLength(0);
  await receive(server("ack", {}, { re: compact?.id }));
  await receive(server("compact", { state: "started" }, { conv: "conv-1" }));
  expect(root.querySelector(".turn-status")?.textContent).toBe("壓縮中…");
  await act(async () => button(root, "停止").click());
  expect(sent("turn.abort").map((m) => m.conv)).toEqual(["conv-1"]);
  await receive(server("compact", { state: "aborted" }, { conv: "conv-1" }));
  expect(root.querySelector(".turn-status")).toBeNull();
  expect(root.querySelector(".task-notice-title")?.textContent).toBe("壓縮已取消");
  unmount();
});

test("E2, E3: the sheet says the local end's figures and starts a compaction; busy is a failure card", async () => {
  const { root, sent, receive, unmount } = await opened({ ...CONTEXT, lastCompactedAt: 1 });
  await act(async () => (root.querySelector(".context-trigger") as HTMLButtonElement).click());
  const sheet = root.querySelector(".sheet-panel") as HTMLElement;
  const values = [...sheet.querySelectorAll("dd")].map((d) => d.textContent);
  expect(values[0]).toBe("48,200 / 200,000 tokens（24%）");
  expect(values[1]).toBe("92%");
  expect(values[3]).toBe("75% 自動 · 85% 硬停");
  expect(sheet.textContent).toContain("壓縮會送出一次模型請求");
  await act(async () => button(root, "立即壓縮").click());
  expect(root.querySelector(".sheet-panel")).toBeNull();
  const [compact] = sent("conv.compact");
  expect(compact?.p).toEqual({});
  await receive(server("nack", { reason: "busy" }, { re: compact?.id }));
  expect(root.querySelector(".task-notice.error .task-notice-title")?.textContent).toBe(
    "壓縮失敗：本機端正在跑另一個回合",
  );
  unmount();
});

test("E5: past the stop line the send is off with the reason, and /compact still goes", async () => {
  const { root, type, key, sent, unmount } = await opened({ ...CONTEXT, contextUsed: 174_000 });
  expect(root.querySelector(".composer-disabled-reason")?.textContent).toBe(
    "這個對話太長（87%），超過硬停門檻。請先執行 /compact，或開新對話接續",
  );
  expect(root.querySelector(".task-notice.warn .task-notice-title")?.textContent).toBe(
    "這個對話太長（87%），請先壓縮或開新對話接續",
  );
  await type("你好");
  await key("Enter");
  expect(sent("turn.submit")).toHaveLength(0);
  // From the menu it stays in the box for what to keep, as /wiki; the next Enter sends it.
  await type("/compact");
  await key("Enter");
  expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("/compact ");
  expect(sent("conv.compact")).toHaveLength(0);
  await key("Enter");
  expect(sent("conv.compact")).toHaveLength(1);
  unmount();
});
