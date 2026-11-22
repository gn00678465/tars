// @vitest-environment jsdom
import type { ServerMessage } from "@tars/protocol";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { button, buttons, render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";
import { LIST, PAGE, REF, SEARCH, STATUS } from "./wiki/fixtures.ts";
import { SEARCH_PAUSE_MS } from "./wiki/requests.ts";

// Scene 15 through the whole page: what the local end is asked, and what shows for its answers.

const CONV = {
  id: "0a1b2c3d-0000-4000-8000-000000000001",
  title: "NAS 備份怎麼排",
  provider: "anthropic",
  model: "model-a",
  updatedAt: 2,
};

const MODELS = [
  { provider: "anthropic", id: "model-a", label: "Model A", window: 200_000, isDefault: true },
];

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function page() {
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  await act(async () => {
    h.last().receive(server("relay.status", { online: true, localSince: 1 }));
    h.last().receive(server("conv.list.result", { convs: [CONV] }));
    const models = h
      .last()
      .messages()
      .findLast((m) => m.kind === "models.get");
    h.last().receive(server("models.result", { models: MODELS }, { re: models?.id ?? "" }));
  });
  const sent = () => h.last().messages();
  const asked = (kind: string) => sent().findLast((m) => m.kind === kind);
  const answer = (kind: ServerMessage["kind"], p: unknown, re = kind.replace(/\.result$/, "")) =>
    act(async () => h.last().receive(server(kind, p, { re: asked(re)?.id ?? "" })));
  const type = (value: string) =>
    act(async () => {
      const area = r.root.querySelector("textarea") as HTMLTextAreaElement;
      // oxlint-disable-next-line typescript/unbound-method
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        area,
        value,
      );
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const enter = () =>
    act(async () => {
      const area = r.root.querySelector("textarea") as HTMLTextAreaElement;
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
  return { h, ...r, sent, asked, answer, type, enter, wait };
}

/** The page with the knowledge base open on its first page. */
async function opened() {
  const p = await page();
  await p.answer("wiki.status.result", STATUS);
  await act(async () => button(p.root, "知識庫 4").click());
  await p.answer("wiki.list.result", LIST);
  await p.answer("wiki.page.result", PAGE);
  return p;
}

test("an older local end answers bad_message: no tab, no button, no /wiki, and no error", async () => {
  const p = await page();
  expect(p.sent().filter((m) => m.kind.startsWith("wiki."))).toMatchObject([
    { kind: "wiki.status" },
  ]);
  await p.answer("nack", { reason: "bad_message" }, "wiki.status");
  expect(p.root.querySelector(".sidebar-mode-tabs")).toBeNull();
  expect(buttons(p.root).some((b) => b.textContent === "個人知識庫")).toBe(false);
  await p.type("/");
  expect(p.root.textContent).not.toContain("/wiki");
  expect(p.root.querySelector("[role=alert]")?.textContent ?? "").toBe("");
  expect(p.root.textContent).not.toContain("訊息格式不對");
  p.unmount();
});

test("before the answer nothing of the knowledge base shows; after it, the tab and the button", async () => {
  const p = await page();
  expect(p.root.querySelector(".sidebar-mode-tabs")).toBeNull();
  await p.answer("wiki.status.result", STATUS);
  expect(p.root.querySelector(".sidebar-mode-tabs")?.textContent).toBe("對話知識庫 4");
  // The page opens on the conversations.
  expect(p.root.querySelector(".sidebar-mode-tab.active")?.textContent).toBe("對話");
  expect(p.root.querySelector(".wiki-workspace")).toBeNull();
  p.unmount();
});

test("the tab opens the list and the first page in place of the thread; 返回對話 goes back", async () => {
  const p = await opened();
  expect(p.sent().map((m) => m.kind)).toEqual(expect.arrayContaining(["wiki.list", "wiki.page"]));
  expect(p.asked("wiki.page")?.p).toEqual({ path: "projects/nas-backup" });
  expect(p.root.querySelector(".wiki-page-title")?.textContent).toBe("NAS 備份腳本");
  expect(p.root.querySelectorAll(".conv-list .wiki-cat-pill")).toHaveLength(7);
  expect(p.root.querySelector(".conv-list .conv-item.active")?.textContent).toContain(
    "NAS 備份腳本",
  );
  await act(async () => button(p.root, "返回對話").click());
  expect(p.root.querySelector(".wiki-workspace")).toBeNull();
  expect(p.root.querySelector(".conv-list")?.textContent).toContain("NAS 備份怎麼排");
  expect(buttons(p.root).some((b) => b.textContent === "個人知識庫")).toBe(true);
  p.unmount();
});

test("/wiki with words opens the knowledge base searching them; a record leads to its conversation", async () => {
  const p = await page();
  await p.answer("wiki.status.result", STATUS);
  await p.type("/wiki 備份");
  await p.enter();
  expect(p.root.querySelector(".wiki-workspace")).not.toBeNull();
  expect((p.root.querySelector("#wiki-search-input") as HTMLInputElement).value).toBe("備份");
  await p.answer("wiki.list.result", LIST);
  await p.answer("wiki.page.result", PAGE);
  await p.wait(SEARCH_PAUSE_MS);
  expect(p.asked("wiki.search")?.p).toEqual({ query: "備份", limit: 20 });
  await p.answer("wiki.search.result", SEARCH);
  const record = p.root.querySelector(".track-panel:nth-child(2) button.track-result-btn");
  await act(async () => (record as HTMLElement).click());
  expect(p.root.querySelector(".wiki-workspace")).toBeNull();
  expect(p.asked("conv.open")?.conv).toBe(CONV.id);
  p.unmount();
});

test("a source mark opens its turn from agent.db; 前往原對話 goes there", async () => {
  const p = await opened();
  await act(async () => button(p.root, `[[source:${REF}]]`).click());
  expect(p.asked("wiki.source")?.p).toEqual({ ref: REF, page: "projects/nas-backup" });
  await p.answer("wiki.source.result", {
    ref: REF,
    found: true,
    conv: CONV.id,
    convTitle: CONV.title,
    turnNo: 2,
    at: 1,
    owner: "備份要每晚跑",
    assistant: "",
    quotes: [],
  });
  expect(p.root.querySelector("[role=dialog] #sheet-title")?.textContent).toBe("原始對話出處對證");
  await act(async () => button(p.root, "前往原對話").click());
  expect(p.root.querySelector("[role=dialog]")).toBeNull();
  expect(p.root.querySelector(".wiki-workspace")).toBeNull();
  expect(p.asked("conv.open")?.conv).toBe(CONV.id);
  p.unmount();
});

test("the local end goes offline: the knowledge base says so instead of showing what it had", async () => {
  const p = await opened();
  await act(async () => p.h.last().receive(server("relay.status", { online: false })));
  expect(p.root.querySelector(".empty-state h2")?.textContent).toBe("本機端離線，無法載入知識庫");
  expect(p.root.querySelector(".wiki-page-title")).toBeNull();
  p.unmount();
});
