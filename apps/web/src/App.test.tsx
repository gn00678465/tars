// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { App } from "./App.tsx";
import { render } from "./render.ts";
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
