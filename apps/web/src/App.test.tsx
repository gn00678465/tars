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
  expect(root.querySelector(".conn-pill")?.textContent).toBe("在線");
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

describe("the sidebar and the open conversation", () => {
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
  const scroll = (root: HTMLElement) => root.querySelector(".thread-scroll") as HTMLElement;
  const entry = (root: HTMLElement, title: string) =>
    [...root.querySelectorAll<HTMLButtonElement>(".conv-item")].find(
      (b) => b.querySelector(".conv-title")?.textContent === title,
    ) as HTMLButtonElement;

  test("before the list arrives it is loading; then 新對話 comes before it", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    await act(async () => h.last().receive(server("relay.status", { online: true })));
    expect(root.querySelector(".conv-skeleton")).not.toBeNull();
    unmount();
    const l = await listed();
    expect(l.root.querySelector(".conv-skeleton")).toBeNull();
    const fresh = l.root.querySelector(".new-chat-btn") as HTMLElement;
    const first = entry(l.root, "對話 0");
    expect(fresh.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(l.root.querySelector(".empty-state h2")?.textContent).toBe("新對話");
    l.unmount();
  });

  test("opening one moves the focus to the thread and marks it in words and shape", async () => {
    const { root, unmount } = await listed();
    await act(async () => entry(root, "對話 30").click());
    expect(document.activeElement).toBe(scroll(root));
    const current = entry(root, "對話 30");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.className).toContain("active");
    expect(current.querySelector(".sg-tag")?.textContent).toBe("目前");
    expect(entry(root, "對話 31").querySelector(".sg-tag")).toBeNull();
    unmount();
  });

  test("新對話 clears the mark and shows the empty state", async () => {
    const { root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => (root.querySelector(".new-chat-btn") as HTMLButtonElement).click());
    expect(root.querySelector(".conv-item[aria-current]")).toBeNull();
    expect(root.querySelector(".empty-state")).not.toBeNull();
    unmount();
  });

  test("the local end offline: the list says why instead of listing", async () => {
    const { h, root, unmount } = await listed();
    await act(async () =>
      h.last().receive(server("relay.status", { online: false, lastSeenAt: 1 })),
    );
    expect(root.querySelector(".conv-offline-box")?.textContent).toContain("本機端離線");
    expect(root.querySelector(".conn-pill")?.textContent).toContain("本機端離線");
    unmount();
  });

  const request = (conv: string) =>
    server("approval.request", {
      approval: {
        approvalId: "approval-00000001",
        conv,
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
    });

  test("a waiting card of this conversation is in the thread", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-1")));
    expect(root.querySelector(".thread-scroll .approval-card")).not.toBeNull();
    expect(root.querySelector(".composer-dock .approval-card")).toBeNull();
    unmount();
  });

  test("one from another conversation is pinned above the composer, says where, and jumps there", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-2")));
    const pinned = root.querySelector(".composer-dock .approval-card") as HTMLElement;
    expect(pinned.querySelector(".approval-origin-bar")?.textContent).toContain("對話 2");
    expect(entry(root, "對話 2").querySelector(".sg-tag.wait")?.textContent).toBe("待核准");
    await act(async () =>
      buttons(pinned)
        .find((b) => b.textContent === "跳至該對話")
        ?.click(),
    );
    expect(entry(root, "對話 2").getAttribute("aria-current")).toBe("true");
    expect(root.querySelector(".thread-scroll .approval-card")).not.toBeNull();
    unmount();
  });
});
