// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});
beforeEach(() => vi.useFakeTimers());

const STATUS = {
  now: 1,
  providers: [],
  pricesWarn: false,
  pendingApprovals: 0,
  turnRunning: false,
  notify: "ok",
};
const conv = (id: string, title: string) => ({
  id,
  title,
  provider: "anthropic",
  model: "m",
  updatedAt: 1,
});

/** The page with two conversations, conv-1 open, the local end saying it takes conv.archive. */
async function opened(archive = true) {
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  const receive = (m: unknown) => act(async () => h.last().receive(m));
  await receive(server("relay.status", { online: true }));
  await receive(server("status", archive ? { ...STATUS, archive: true } : STATUS));
  await receive(
    server("conv.list.result", { convs: [conv("conv-1", "甲"), conv("conv-2", "乙")] }),
  );
  await act(async () => (r.root.querySelector(".conv-item") as HTMLButtonElement).click());
  await receive(
    server("conv.snapshot", { epoch: "epoch-1", more: false, items: [] }, { conv: "conv-1" }),
  );
  const sent = (kind: string) =>
    h
      .last()
      .messages()
      .filter((m) => m.kind === kind);
  const archiveBtn = (title: string) =>
    r.root.querySelector(`.conv-archive-btn[aria-label="封存「${title}」"]`) as HTMLButtonElement;
  return { h, ...r, receive, sent, archiveBtn };
}

test("a local end that does not say archive: no action on a conversation", async () => {
  const { root, unmount } = await opened(false);
  expect(root.querySelectorAll(".conv-archive-btn")).toHaveLength(0);
  unmount();
});

test("the action sends conv.archive for that conversation; the ack shows 已封存 · 復原 for 8 seconds", async () => {
  const { root, receive, sent, archiveBtn, unmount } = await opened();
  await act(async () => archiveBtn("乙").click());
  const [req] = sent("conv.archive");
  expect([req?.conv, req?.p]).toEqual(["conv-2", { archived: true }]);
  await receive(server("ack", {}, { re: req?.id }));
  await receive(server("conv.list.result", { convs: [conv("conv-1", "甲")] }));
  expect([...root.querySelectorAll(".conv-title")].map((e) => e.textContent)).toEqual(["甲"]);
  const toast = root.querySelector(".archive-toast") as HTMLElement;
  expect(toast.textContent).toBe("已封存·復原");
  await act(async () => void vi.advanceTimersByTime(7_900));
  expect(root.querySelector(".archive-toast")).not.toBeNull();
  await act(async () => void vi.advanceTimersByTime(200));
  expect(root.querySelector(".archive-toast")).toBeNull();
  unmount();
});

test("復原 sends conv.archive false for the same conversation and closes the toast", async () => {
  const { root, receive, sent, archiveBtn, unmount } = await opened();
  await act(async () => archiveBtn("乙").click());
  await receive(server("ack", {}, { re: sent("conv.archive")[0]?.id }));
  await act(async () => (root.querySelector(".archive-toast-undo") as HTMLButtonElement).click());
  const undo = sent("conv.archive")[1];
  expect([undo?.conv, undo?.p]).toEqual(["conv-2", { archived: false }]);
  await receive(server("ack", {}, { re: undo?.id }));
  expect(root.querySelector(".archive-toast")).toBeNull();
  unmount();
});

test("archiving the open conversation returns to a new one: an empty thread, the toast up", async () => {
  const { root, receive, sent, archiveBtn, unmount } = await opened();
  expect(root.querySelector(".conv-item.active")).not.toBeNull();
  await act(async () => archiveBtn("甲").click());
  await receive(server("ack", {}, { re: sent("conv.archive")[0]?.id }));
  expect(root.querySelector(".conv-item.active")).toBeNull();
  expect(root.querySelector(".empty-state")).not.toBeNull();
  expect(root.querySelector(".archive-toast")?.textContent).toBe("已封存·復原");
  unmount();
});

test("a conversation waiting on an approval has the action off, saying why", async () => {
  const { receive, sent, archiveBtn, unmount } = await opened();
  await receive(
    server("approval.request", {
      approval: {
        approvalId: "approval-00000001",
        conv: "conv-2",
        hash: "a".repeat(64),
        action: "run_script",
        script: "push",
        version: "v1",
        summary: "推播",
        effects: "external-write",
        domains: [],
        secret: null,
        argv: [],
        expiresAt: 600_000,
      },
    }),
  );
  const btn = archiveBtn("乙");
  expect(btn.disabled).toBe(true);
  expect(btn.title).toBe("有待核准項目，不能封存");
  await act(async () => btn.click());
  expect(sent("conv.archive")).toHaveLength(0);
  expect(archiveBtn("甲").disabled).toBe(false);
  unmount();
});

test("a refusal shows its reason in the toast, closable, and the list stays", async () => {
  const { root, receive, sent, archiveBtn, unmount } = await opened();
  await act(async () => archiveBtn("乙").click());
  await receive(server("nack", { reason: "conv_active" }, { re: sent("conv.archive")[0]?.id }));
  const toast = root.querySelector(".archive-toast") as HTMLElement;
  expect(toast.textContent).toContain("還有進行中的回合或待核准項目，不能封存");
  expect(toast.querySelector(".archive-toast-undo")).toBeNull();
  await act(async () => (toast.querySelector("button") as HTMLButtonElement).click());
  expect(root.querySelector(".archive-toast")).toBeNull();
  expect(root.querySelectorAll(".conv-item")).toHaveLength(2);
  unmount();
});

test("archived on another tab: this one leaves the conversation and says so", async () => {
  const { root, receive, unmount } = await opened();
  await receive(
    server("notice", { code: "conv_archived", data: { conv: "conv-1" } }, { conv: "conv-1" }),
  );
  await receive(server("conv.list.result", { convs: [conv("conv-2", "乙")] }));
  expect(root.querySelector(".empty-state")).not.toBeNull();
  expect(root.querySelector(".archive-toast")?.textContent).toContain("tars chat --unarchive");
  expect(root.querySelector(".archive-toast-undo")).toBeNull();
  unmount();
});

test("a message refused as archived shows the sentence and asks for the list again", async () => {
  const { root, h, receive, sent, unmount } = await opened();
  const area = root.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    // oxlint-disable-next-line typescript/unbound-method
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, "嗨");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(
    async () =>
      void area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  const lists = sent("conv.list").length;
  await receive(server("nack", { reason: "conv_archived" }, { re: sent("turn.submit")[0]?.id }));
  expect(root.textContent).toContain("這個對話已封存，不能繼續");
  expect(sent("conv.list").length).toBeGreaterThan(lists);
  void h;
  unmount();
});
