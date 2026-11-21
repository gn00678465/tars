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
    buttons(root).find((b) => b.textContent?.startsWith(title) === true) as HTMLButtonElement;

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
