// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { App } from "./App.tsx";
import { buttons, render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

test("connects, asks for the list after hello, and shows what the relay says", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  expect(root.textContent).toContain("連線中");
  await act(async () => h.last().ready());
  expect(
    h
      .last()
      .messages()
      .map((m) => m.kind),
  ).toEqual(["hello", "conv.list"]);
  await act(async () =>
    h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 })),
  );
  expect(root.textContent).toContain("本機端在線");
  expect(root.textContent).toContain("本機端這一次連上");
  unmount();
});

test("a turn message missed across a reconnect: the resend's ack with the turn finishes the send", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  await act(async () =>
    h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 })),
  );
  const textarea = () => root.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => void h.socket.submit("你好"));
  expect(textarea().disabled).toBe(true);
  expect(root.querySelector(".composer .reason")?.textContent).toBe("送出中");
  await act(async () => {
    h.last().end(4000);
    await h.advance(0);
  });
  await act(async () => h.last().ready());
  const resend = h
    .last()
    .messages()
    .find((m) => m.kind === "turn.submit");
  await act(async () =>
    h.last().receive(server("ack", { turn: "turn-9" }, { re: resend?.id, conv: "conv-9" })),
  );
  expect(textarea().disabled).toBe(false);
  expect(root.querySelector(".composer .reason")).toBeNull();
  expect(
    h
      .last()
      .messages()
      .filter((m) => m.kind === "conv.open")
      .map((m) => m.conv),
  ).toEqual(["conv-9"]);
  unmount();
});

describe("an ack with the turn after a reconnect, in a conversation already open", () => {
  const convs = [
    { id: "conv-a", title: "對話甲", provider: "anthropic", model: "m", updatedAt: 1 },
    { id: "conv-b", title: "對話乙", provider: "anthropic", model: "m", updatedAt: 2 },
  ];

  const conv = (root: HTMLElement, title: string) =>
    buttons(root).find((b) => b.textContent?.includes(title) === true) as HTMLButtonElement;

  async function sentInA(h: ReturnType<typeof socketHarness>, root: HTMLElement) {
    await act(async () => h.last().ready());
    await act(async () => {
      h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 }));
      h.last().receive(server("conv.list.result", { convs }));
    });
    await act(async () => conv(root, "對話甲").click());
    await act(async () => void h.socket.submit("你好", "conv-a"));
  }

  async function reconnectAndAck(h: ReturnType<typeof socketHarness>) {
    await act(async () => {
      h.last().end(4000);
      await h.advance(0);
    });
    await act(async () => h.last().ready());
    const before = h
      .last()
      .messages()
      .filter((m) => m.kind === "conv.open")
      .map((m) => m.conv);
    const resend = h
      .last()
      .messages()
      .find((m) => m.kind === "turn.submit");
    await act(async () =>
      h.last().receive(server("ack", { turn: "turn-a" }, { re: resend?.id, conv: "conv-a" })),
    );
    const after = h
      .last()
      .messages()
      .filter((m) => m.kind === "conv.open")
      .map((m) => m.conv);
    return { before, after };
  }

  test("still on it: its snapshot is asked for again, after the ack", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await sentInA(h, root);
    const { before, after } = await reconnectAndAck(h);
    expect(before).toEqual(["conv-a"]);
    expect(after).toEqual(["conv-a", "conv-a"]);
    unmount();
  });

  test("moved to another conversation: no jump and no load of the first", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await sentInA(h, root);
    await act(async () => conv(root, "對話乙").click());
    const { before, after } = await reconnectAndAck(h);
    expect(before).toEqual(["conv-b"]);
    expect(after).toEqual(["conv-b"]);
    expect(conv(root, "對話乙").getAttribute("aria-current")).toBe("true");
    unmount();
  });
});

describe("the conversation list and the open conversation", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `conv-${i}`,
    title: `對話 ${i}`,
    provider: "anthropic",
    model: "m",
    updatedAt: 1000 - i,
  }));

  async function listed() {
    const h = socketHarness();
    const r = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    await act(async () => {
      h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 }));
      h.last().receive(server("conv.list.result", { convs: many }));
    });
    return { h, ...r };
  }
  const list = (root: HTMLElement) => root.querySelector(".convs details") as HTMLDetailsElement;
  const thread = (root: HTMLElement) => root.querySelector(".thread") as HTMLElement;
  const entry = (root: HTMLElement, title: string) =>
    [...root.querySelectorAll<HTMLButtonElement>(".convs li button")].find(
      (b) => b.querySelector(".title")?.textContent === title,
    ) as HTMLButtonElement;

  test("no conversation open: the list is unfolded, 新對話 above it", async () => {
    const { root, unmount } = await listed();
    expect(list(root).open).toBe(true);
    const first = buttons(root).find((b) => b.textContent === "新對話");
    expect(first?.closest(".convs")).not.toBeNull();
    expect(first?.compareDocumentPosition(list(root)) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    unmount();
  });

  test("opening one folds the list, moves the focus to the thread and marks it in words", async () => {
    const { root, unmount } = await listed();
    await act(async () => entry(root, "對話 30").click());
    expect(list(root).open).toBe(false);
    expect(document.activeElement).toBe(thread(root));
    const current = entry(root, "對話 30");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.textContent?.startsWith("目前：")).toBe(true);
    expect(entry(root, "對話 31").textContent?.includes("目前")).toBe(false);
    // The folded list names what is open, so it shows without unfolding.
    expect(list(root).querySelector("summary")?.textContent).toContain("對話 30");
    unmount();
  });

  test("unfolded by hand while one is open, it folds again when another is opened", async () => {
    const { root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => {
      list(root).open = true;
    });
    await act(async () => entry(root, "對話 2").click());
    expect(list(root).open).toBe(false);
    expect(document.activeElement).toBe(thread(root));
    unmount();
  });

  test("新對話 unfolds the list again", async () => {
    const { root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () =>
      buttons(root)
        .find((b) => b.textContent === "新對話")
        ?.click(),
    );
    expect(list(root).open).toBe(true);
    expect(root.querySelector(".convs [aria-current]")).toBeNull();
    unmount();
  });

  test("pending approvals stay above the list and the thread", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () =>
      h.last().receive(
        server("approval.request", {
          approval: {
            approvalId: "approval-00000001",
            conv: "conv-1",
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
      ),
    );
    const card = root.querySelector(".approval") as HTMLElement;
    expect(
      card.compareDocumentPosition(list(root)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      card.compareDocumentPosition(thread(root)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();
  });
});
