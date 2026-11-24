// @vitest-environment jsdom
import type { ServerMessage } from "@tars/protocol";
import { act } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { button, render } from "./render.ts";
import { frame, layout, observers, server, socketHarness } from "./testing.ts";
import { PAGE, LIST, STATUS } from "./wiki/fixtures.ts";

// The thread's scrolling (M4-P3a), through the whole page: @shadcn/react's Message Scroller under
// jsdom's stand-in layout (testing.ts layout), each row as tall as its text.

const A = "conv-a";
const B = "conv-b";
const T = "turn-00000001";
const VIEW = 300;
const rowPx = (r: HTMLElement) => 60 + (r.textContent?.length ?? 0) * 4;

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** Groups `from`..`to`: the owner's message and its reply, two seqs each. */
const groups = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => {
    const g = from + k;
    return [
      { seq: g * 2 + 1, turn: `turn-${g}`, kind: "user", text: `問題 ${g}`, truncated: false },
      {
        seq: g * 2 + 2,
        turn: `turn-${g}`,
        kind: "assistant",
        text: `回答 ${g}`,
        truncated: false,
        state: "complete",
      },
    ];
  }).flat();

async function page() {
  const o = observers();
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  cleanup.push(o.restore, r.unmount);
  await act(async () => h.last().ready());
  await act(async () => {
    h.last().receive(server("relay.status", { online: true, localSince: 1 }));
    h.last().receive(
      server("conv.list.result", {
        convs: [A, B].map((id, i) => ({
          id,
          title: `對話 ${id}`,
          provider: "anthropic",
          model: "m",
          updatedAt: 10 - i,
        })),
      }),
    );
  });
  const el = r.root.querySelector(".thread-scroll") as HTMLElement;
  cleanup.push(layout(el, VIEW, rowPx));
  const receive = (m: ServerMessage) => act(async () => h.last().receive(m));
  const end = () => el.scrollHeight - el.clientHeight;
  const rows = () => [...el.querySelectorAll<HTMLElement>(".thread [data-message-id]")];
  const toEnd = () => r.root.querySelector(".thread-to-end") as HTMLButtonElement;
  async function open(conv: string, items: object[], more = false) {
    const entry = [...r.root.querySelectorAll<HTMLButtonElement>(".conv-item")].find(
      (b) => b.querySelector(".conv-title")?.textContent === `對話 ${conv}`,
    );
    await act(async () => entry?.click());
    await receive(server("conv.snapshot", { epoch: "epoch-1", more, items }, { conv }));
    await frame();
  }
  /**
   * Up by `px` with only the scroll event, as dragging the scrollbar, find in page or a tap on the
   * status bar make: no wheel, touch or key. Right after the scroller's own scroll to the end, so
   * within the 180 ms it ignores scrolls in.
   */
  async function up(px: number) {
    await act(async () => {
      el.scrollTop -= px;
      el.dispatchEvent(new Event("scroll"));
    });
    await frame();
  }
  const delta = async (text: string, conv = A) => {
    await receive(server("delta", { turn: T, text }, { conv }));
    await o.resize();
  };
  return { h, root: r.root, el, end, rows, toEnd, open, up, delta, receive, resize: o.resize };
}

test("opening lands at the end; at the end the streaming reply is followed, in one row that keeps its id", async () => {
  const p = await page();
  await p.open(A, [
    ...groups(0, 9),
    { seq: 21, turn: T, kind: "user", text: "再一題", truncated: false },
  ]);
  expect(p.end()).toBeGreaterThan(VIEW);
  expect(p.el.scrollTop).toBe(p.end());
  const last = p.rows().at(-1) as HTMLElement;
  expect(last.dataset.messageId).toBe("g21");
  for (const text of ["第一段", "，第二段", "，第三段，越來越長"]) {
    const before = p.end();
    await p.delta(text);
    expect(p.end()).toBeGreaterThan(before);
    expect(p.el.scrollTop).toBe(p.end());
  }
  // The streaming text has no seq: it is in its group's row, which stays the same element.
  expect(p.rows().at(-1)).toBe(last);
  await p.receive(
    server(
      "item",
      {
        item: {
          seq: 22,
          turn: T,
          kind: "assistant",
          text: "第一段，第二段，第三段，越來越長",
          truncated: false,
          state: "complete",
        },
      },
      { conv: A },
    ),
  );
  await p.resize();
  expect(p.rows().at(-1)).toBe(last);
  expect(last.dataset.messageId).toBe("g21");
  expect(p.el.scrollTop).toBe(p.end());
});

test("scrolled up by the scrollbar while a reply streams, nothing pulls it back; 捲到最新訊息 shows then, takes it down and follows again", async () => {
  const p = await page();
  await p.open(A, [
    ...groups(0, 9),
    { seq: 21, turn: T, kind: "user", text: "再一題", truncated: false },
  ]);
  expect(p.toEnd().getAttribute("data-active")).toBe("false");
  expect(p.toEnd().getAttribute("aria-label")).toBe("捲到最新訊息");
  await p.up(200);
  const kept = p.el.scrollTop;
  expect(kept).toBe(p.end() - 200);
  expect(p.toEnd().getAttribute("data-active")).toBe("true");
  await p.delta("串流中的字");
  await p.delta("，還在來");
  expect(p.el.scrollTop).toBe(kept);
  // A new group too (sent from another device).
  await p.receive(
    server(
      "item",
      { item: { seq: 40, turn: "turn-x", kind: "user", text: "另一台", truncated: false } },
      { conv: A },
    ),
  );
  await frame();
  expect(p.el.scrollTop).toBe(kept);
  await act(async () => p.toEnd().click());
  await frame();
  expect(p.el.scrollTop).toBe(p.end());
  expect(p.toEnd().getAttribute("data-active")).toBe("false");
  // The button goes inert: the focus is left in the thread, not dropped to the page.
  expect(document.activeElement).toBe(p.el);
  await p.delta("，回到底之後");
  expect(p.el.scrollTop).toBe(p.end());
  // Up again mid-stream, right after the scroller's own scroll to the end: still let go.
  await p.up(150);
  const held = p.el.scrollTop;
  expect(held).toBe(p.end() - 150);
  await p.delta("，再一段");
  await p.delta("，還有");
  expect(p.el.scrollTop).toBe(held);
  // Back within 24 px of the end by the scrollbar: followed again.
  await act(async () => {
    p.el.scrollTop = p.end() - 10;
    p.el.dispatchEvent(new Event("scroll"));
  });
  await frame();
  await p.delta("，到底了");
  expect(p.el.scrollTop).toBe(p.end());
});

test("older groups come in above: the rows there keep their ids and elements, and what is read does not move", async () => {
  const p = await page();
  await p.open(A, groups(10, 19), true);
  await p.up(250);
  const before = p.rows();
  const ids = before.map((r) => r.dataset.messageId);
  // The first row in view and where it is.
  const seen = before.find((r) => r.getBoundingClientRect().bottom > 0) as HTMLElement;
  const top = seen.getBoundingClientRect().top;
  await act(async () => button(p.root, "載入更早的訊息").click());
  const asked = p.h
    .last()
    .messages()
    .findLast((m) => m.kind === "conv.open");
  expect(asked?.p).toEqual({ before: 21 });
  await p.receive(
    server("conv.snapshot", { epoch: "epoch-1", more: false, items: groups(4, 9) }, { conv: A }),
  );
  await frame();
  const after = p.rows();
  expect(after.slice(-ids.length).map((r) => r.dataset.messageId)).toEqual(ids);
  expect(after.slice(-before.length)).toEqual(before);
  expect(after.slice(0, 6).map((r) => r.dataset.messageId)).toEqual(
    [4, 5, 6, 7, 8, 9].map((g) => `g${g * 2 + 1}`),
  );
  expect(seen.getBoundingClientRect().top).toBe(top);
  expect(p.el.scrollTop).toBeGreaterThan(0);
  expect(p.root.textContent).not.toContain("載入更早的訊息");
});

test("a page cut inside a group: when the group's first half comes, its row keeps its id and element, and what is read does not move", async () => {
  const p = await page();
  // Group 10's reply without its message (seq 21), as the local end cuts a page by count.
  await p.open(A, groups(10, 19).slice(1), true);
  await p.up(250);
  const before = p.rows();
  const ids = before.map((r) => r.dataset.messageId);
  expect(ids[0]).toBe("g22");
  const seen = before.find((r) => r.getBoundingClientRect().bottom > 0) as HTMLElement;
  const top = seen.getBoundingClientRect().top;
  await act(async () => button(p.root, "載入更早的訊息").click());
  await p.receive(
    server(
      "conv.snapshot",
      { epoch: "epoch-1", more: false, items: [...groups(4, 9), groups(10, 10)[0] as object] },
      { conv: A },
    ),
  );
  await frame();
  const after = p.rows();
  expect(after.slice(-ids.length).map((r) => r.dataset.messageId)).toEqual(ids);
  expect(after.slice(-before.length)).toEqual(before);
  // Group 10 now has its message, in the same row.
  expect(before[0]?.textContent).toContain("問題 10");
  expect(after).toHaveLength(before.length + 6);
  expect(seen.getBoundingClientRect().top).toBe(top);
  expect(p.el.scrollTop).toBeGreaterThan(0);
});

test("another conversation opened while scrolled up goes to its end; so does a message the owner sends", async () => {
  const p = await page();
  await p.open(A, groups(0, 9));
  await p.up(300);
  expect(p.el.scrollTop).toBeLessThan(p.end());
  await p.open(B, groups(0, 12));
  expect(p.el.scrollTop).toBe(p.end());
  await p.up(300);
  const area = p.root.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    // oxlint-disable-next-line typescript/unbound-method
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      area,
      "下一題",
    );
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(p.root, "送出").click());
  await frame();
  expect(
    p.h
      .last()
      .messages()
      .findLast((m) => m.kind === "turn.submit"),
  ).toBeDefined();
  expect(p.el.scrollTop).toBe(p.end());
  // What comes after is followed.
  await p.receive(
    server(
      "item",
      { item: { seq: 90, turn: T, kind: "user", text: "下一題", truncated: false } },
      { conv: B },
    ),
  );
  await p.delta("回覆來了", B);
  expect(p.el.scrollTop).toBe(p.end());
});

test("a card that comes while scrolled up: announced, its deny takes the focus and is scrolled to, the thread is not pulled down", async () => {
  const focused: [Element, FocusOptions | undefined][] = [];
  // Called with .call(this) below.
  // oxlint-disable-next-line typescript/unbound-method
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    o?: FocusOptions,
  ) {
    focused.push([this, o]);
    focus.call(this, o);
  });
  const p = await page();
  const call = {
    seq: 30,
    turn: T,
    kind: "tool_call",
    callId: "call-00000001",
    name: "run_script",
    input: "{}",
    truncated: false,
  };
  await p.open(A, [
    ...groups(0, 9),
    { seq: 29, turn: T, kind: "user", text: "跑腳本", truncated: false },
    call,
  ]);
  await p.up(400);
  const kept = p.el.scrollTop;
  await p.receive(
    server("approval.request", {
      approval: {
        approvalId: "approval-00000001",
        conv: A,
        callId: "call-00000001",
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
  await frame();
  const alert = document.querySelector('[role="alert"][aria-live="assertive"]');
  expect(alert?.textContent).toContain("需要核准");
  const card = p.el.querySelector(".approval-card") as HTMLElement;
  const deny = card.querySelector(".sg-btn-danger") as HTMLButtonElement;
  expect(document.activeElement).toBe(deny);
  // Focused without preventScroll: the browser scrolls it into view (tools/visual/scroll.ts
  // measures that in Chromium).
  expect(focused.filter(([e]) => e === deny).map(([, o]) => o?.preventScroll)).toEqual([undefined]);
  expect(p.el.scrollTop).toBe(kept);
  // P2's: the workspace stays exposed and announces nothing of its own.
  expect(p.el.closest(".workspace")?.getAttribute("aria-live")).toBe("off");
});

test("the rows are not a live log and not busy (the finished reply is spoken once, by the page; a turn's status and a card's alert are not held back)", async () => {
  const p = await page();
  await p.open(A, [
    ...groups(0, 2),
    { seq: 21, turn: T, kind: "user", text: "再一題", truncated: false },
  ]);
  const content = p.el.querySelector('[data-slot="message-scroller-content"]') as HTMLElement;
  expect(content.getAttribute("role")).toBe("presentation");
  expect(p.root.querySelector('[role="log"]')).toBeNull();
  expect(p.el.getAttribute("role")).toBe("main");
  expect(p.el.getAttribute("aria-label")).toBe("訊息");
  expect(content.hasAttribute("aria-busy")).toBe(false);
  await p.delta("一段");
  expect(content.hasAttribute("aria-busy")).toBe(false);
  expect(p.root.querySelector("[aria-busy]")).toBeNull();
  const polite = p.root.querySelector(".sr-only[aria-live=polite]") as HTMLElement;
  expect(polite.textContent).toBe("");
  await p.receive(
    server(
      "item",
      {
        item: {
          seq: 22,
          turn: T,
          kind: "assistant",
          text: "一段",
          truncated: false,
          state: "complete",
        },
      },
      { conv: A },
    ),
  );
  expect(content.hasAttribute("aria-busy")).toBe(false);
  expect(polite.textContent).toContain("一段");
});

test("the knowledge base open: a reply streaming in its conversation does not scroll it", async () => {
  const p = await page();
  await p.open(A, [
    ...groups(0, 9),
    { seq: 21, turn: T, kind: "user", text: "再一題", truncated: false },
  ]);
  const asked = (kind: string) =>
    p.h
      .last()
      .messages()
      .findLast((m) => m.kind === kind)?.id ?? "";
  await p.receive(server("wiki.status.result", STATUS, { re: asked("wiki.status") }));
  await act(async () => button(p.root, "知識庫 4").click());
  await p.receive(server("wiki.list.result", LIST, { re: asked("wiki.list") }));
  await p.receive(server("wiki.page.result", PAGE, { re: asked("wiki.page") }));
  await frame();
  expect(p.el.getAttribute("aria-label")).toBe("個人知識庫");
  p.el.scrollTop = 0;
  await act(async () => p.el.dispatchEvent(new Event("scroll")));
  await frame();
  expect(p.end()).toBeGreaterThan(0);
  await p.delta("背景裡的回覆");
  await p.delta("，又一段");
  expect(p.el.scrollTop).toBe(0);
});
