// @vitest-environment jsdom
import type { ServerMessage } from "@tars/protocol";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { button, render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";
import { LIST, PAGE, STATUS } from "./wiki/fixtures.ts";

// A reload (the pull to refresh) comes back where the tab was (kept.ts): unmounted and mounted
// again, with the same sessionStorage, is the reload here.

const A = "0a1b2c3d-0000-4000-8000-00000000000a";
const B = "0a1b2c3d-0000-4000-8000-00000000000b";
const conv = (id: string, title: string) => ({
  id,
  title,
  provider: "anthropic",
  model: "m",
  updatedAt: 1,
});
const KEY = "tars.page";
const kept = () => JSON.parse(sessionStorage.getItem(KEY) ?? "null") as unknown;

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** The page loaded: hello, the relay online, two conversations listed. */
async function load() {
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  const receive = (m: ServerMessage) => act(async () => h.last().receive(m));
  await receive(server("relay.status", { online: true, localSince: 1 }));
  await receive(server("conv.list.result", { convs: [conv(A, "甲"), conv(B, "乙")] }));
  const sent = () => h.last().messages();
  const asked = (kind: string) => sent().findLast((m) => m.kind === kind);
  const answer = (kind: ServerMessage["kind"], p: unknown, re = kind.replace(/\.result$/, "")) =>
    receive(server(kind, p, { re: asked(re)?.id ?? "" }));
  const click = (title: string) =>
    act(async () =>
      [...r.root.querySelectorAll<HTMLButtonElement>(".conv-item")]
        .find((b) => b.querySelector(".conv-title")?.textContent === title)
        ?.click(),
    );
  const snapshot = (c: string, text: string) =>
    receive(
      server(
        "conv.snapshot",
        {
          epoch: "epoch-1",
          more: false,
          items: [{ seq: 1, turn: "turn-1", kind: "user", text, truncated: false }],
        },
        { conv: c },
      ),
    );
  const here = () => r.root.querySelector(".conv-item.active .conv-title")?.textContent;
  return { h, ...r, receive, sent, asked, answer, click, snapshot, here };
}

test("in a conversation, a reload comes back to it: conv.open goes after the hello", async () => {
  const first = await load();
  await first.click("甲");
  await first.snapshot(A, "甲的問題");
  expect(kept()).toEqual({ v: 1, conv: A });
  first.unmount();

  const p = await load();
  const open = p.sent().filter((m) => m.kind === "conv.open");
  expect(open.map((m) => [m.conv, m.p])).toEqual([[A, {}]]);
  await p.snapshot(A, "甲的問題");
  expect(p.here()).toBe("甲");
  expect(p.root.textContent).toContain("甲的問題");
  p.unmount();
});

test("A, then B, then a reload: B", async () => {
  const first = await load();
  await first.click("甲");
  await first.snapshot(A, "甲");
  await first.click("乙");
  await first.snapshot(B, "乙");
  first.unmount();
  const p = await load();
  expect(p.asked("conv.open")?.conv).toBe(B);
  p.unmount();
});

test("back home, then a reload: home, and no conv.open", async () => {
  const first = await load();
  await first.click("甲");
  await first.snapshot(A, "甲");
  await act(async () => button(first.root, "新對話").click());
  expect(sessionStorage.getItem(KEY)).toBeNull();
  first.unmount();
  const p = await load();
  expect(p.asked("conv.open")).toBeUndefined();
  expect(p.root.querySelector(".empty-state")).not.toBeNull();
  p.unmount();
});

test("storage that throws (a private window, blocked): the page works, starting at home", async () => {
  for (const f of ["getItem", "setItem", "removeItem"] as const)
    vi.spyOn(Storage.prototype, f).mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
  const p = await load();
  expect(p.asked("conv.open")).toBeUndefined();
  await p.click("甲");
  await p.snapshot(A, "甲的問題");
  expect(p.here()).toBe("甲");
  await act(async () => button(p.root, "新對話").click());
  expect(p.root.querySelector(".empty-state")).not.toBeNull();
  p.unmount();
});

test("what is kept but does not read (another version, not JSON, a bad id) is nothing", async () => {
  for (const raw of ['{"v":2,"conv":"x"}', "{", '{"v":1,"conv":""}', "null"]) {
    sessionStorage.setItem(KEY, raw);
    const p = await load();
    expect(p.asked("conv.open"), raw).toBeUndefined();
    expect(p.root.querySelector(".empty-state"), raw).not.toBeNull();
    p.unmount();
  }
});

test("the phone's track comes back too, shown once something is searched", async () => {
  sessionStorage.setItem(
    KEY,
    JSON.stringify({ v: 1, wiki: { view: "wiki", category: "all", track: "raw" } }),
  );
  const p = await load();
  await p.answer("wiki.status.result", STATUS);
  await act(async () => {
    const box = p.root.querySelector("#wiki-search-input") as HTMLInputElement;
    // oxlint-disable-next-line typescript/unbound-method
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(box, "備份");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(p.root.querySelector(".mobile-track-tab.active")?.textContent).toContain("原始對話");
  p.unmount();
});

for (const [why, reason] of [
  ["gone", "not_found"],
  ["archived", "conv_archived"],
] as const)
  test(`the kept conversation is ${why} (${reason}): home, nothing kept, not asked again`, async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ v: 1, conv: A }));
    const p = await load();
    const open = p.asked("conv.open");
    expect(open?.conv).toBe(A);
    await p.receive(server("nack", { reason }, { re: open?.id ?? "" }));
    expect(p.root.querySelector(".empty-state")).not.toBeNull();
    expect(p.here()).toBeUndefined();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(p.sent().filter((m) => m.kind === "conv.open")).toHaveLength(1);
    p.unmount();
  });

/** The knowledge base open on the list's first page. */
async function wikiOpen(p: Awaited<ReturnType<typeof load>>) {
  await p.answer("wiki.status.result", STATUS);
  await act(async () => button(p.root, "知識庫 4").click());
  await p.answer("wiki.list.result", LIST);
  await p.answer("wiki.page.result", PAGE);
}

test("on a knowledge base page, a reload comes back to it once wiki.status answers, and asks for the page again", async () => {
  const first = await load();
  await wikiOpen(first);
  await act(async () =>
    [...first.root.querySelectorAll<HTMLButtonElement>(".conv-list .conv-item")]
      .find((b) => b.textContent?.includes("王小明"))
      ?.click(),
  );
  const place = kept() as { wiki: { selected: string; category: string; track: string } };
  expect(place.wiki.selected).toBe("people/wang-xiaoming");
  first.unmount();

  const p = await load();
  // Until the local end says it has one, the conversations.
  expect(p.root.querySelector(".wiki-workspace")).toBeNull();
  await p.answer("wiki.status.result", STATUS);
  expect(p.root.querySelector(".wiki-workspace")).not.toBeNull();
  expect(p.asked("wiki.page")?.p).toEqual({ path: "people/wang-xiaoming" });
  await p.answer("wiki.list.result", LIST);
  await p.answer("wiki.page.result", {
    ...PAGE,
    path: "people/wang-xiaoming",
    title: "王小明",
  });
  expect(p.root.querySelector(".wiki-page-title")?.textContent).toBe("王小明");
  expect(kept()).toEqual({ v: 1, wiki: place.wiki });
  // The search is not kept.
  expect((p.root.querySelector("#wiki-search-input") as HTMLInputElement).value).toBe("");
  p.unmount();
});

test("an older local end (wiki.status bad_message) after a reload on the knowledge base: the conversations, and the place let go", async () => {
  sessionStorage.setItem(
    KEY,
    JSON.stringify({
      v: 1,
      wiki: { view: "wiki", category: "all", selected: "projects/nas-backup", track: "wiki" },
    }),
  );
  const p = await load();
  await p.answer("nack", { reason: "bad_message" }, "wiki.status");
  expect(p.root.querySelector(".wiki-workspace")).toBeNull();
  expect(p.root.querySelector(".sidebar-mode-tabs")).toBeNull();
  expect(p.asked("wiki.page")).toBeUndefined();
  expect(sessionStorage.getItem(KEY)).toBeNull();
  p.unmount();
});

test("the kept page is missing now: 這一頁讀不到, asked once, and not kept for the next reload", async () => {
  sessionStorage.setItem(
    KEY,
    JSON.stringify({
      v: 1,
      wiki: { view: "wiki", category: "people", selected: "learning/gone", track: "wiki" },
    }),
  );
  const p = await load();
  await p.answer("wiki.status.result", STATUS);
  // The page says its category: learning, not the people kept with it.
  expect(p.root.querySelector(".wiki-cat-pill.active")?.textContent).toContain("學習");
  await p.answer("wiki.list.result", LIST);
  await p.answer("wiki.page.result", { state: "missing", path: "learning/gone" });
  expect(p.root.textContent).toContain("這一頁讀不到");
  await act(async () => void vi.advanceTimersByTime(30_000));
  expect(p.sent().filter((m) => m.kind === "wiki.page")).toHaveLength(1);
  expect(kept()).toEqual({ v: 1, wiki: { view: "wiki", category: "learning", track: "wiki" } });
  p.unmount();
});

test("back on the conversations tab, a reload opens the conversations", async () => {
  const first = await load();
  await wikiOpen(first);
  // The sidebar's tab: with no conversation open the top bar has no 返回對話.
  await act(async () => button(first.root, "對話").click());
  expect(first.root.querySelector(".wiki-workspace")).toBeNull();
  expect(sessionStorage.getItem(KEY)).toBeNull();
  first.unmount();
  const p = await load();
  await p.answer("wiki.status.result", STATUS);
  expect(p.root.querySelector(".wiki-workspace")).toBeNull();
  p.unmount();
});

test("a conversation open under the knowledge base: both come back", async () => {
  const first = await load();
  await first.click("甲");
  await first.snapshot(A, "甲的問題");
  await wikiOpen(first);
  expect(kept()).toMatchObject({ v: 1, conv: A, wiki: { view: "wiki" } });
  first.unmount();
  const p = await load();
  expect(p.asked("conv.open")?.conv).toBe(A);
  await p.snapshot(A, "甲的問題");
  await p.answer("wiki.status.result", STATUS);
  expect(p.root.querySelector(".wiki-workspace")).not.toBeNull();
  await act(async () => button(p.root, "返回對話").click());
  expect(p.here()).toBe("甲");
  expect(p.root.textContent).toContain("甲的問題");
  p.unmount();
});
