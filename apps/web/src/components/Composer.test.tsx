// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { button, render } from "../render.ts";
import { composerBlocked, initial, type State } from "../state.ts";
import { Composer } from "./Composer.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const ready: State = { ...initial, connection: "open", relay: { online: true } };

test.each<[string, State, string]>([
  ["offline", { ...ready, relay: { online: false } }, "本機端離線"],
  ["busy", { ...ready, turn: { state: "started" } }, "回合進行中"],
  ["login expired", { ...ready, connection: "auth_expired" }, "登入已過期，請重新整理"],
  ["the page's connection down", { ...ready, connection: "offline" }, "連線中斷，正在重新連線"],
])("%s: off, with the reason", async (_, state, reason) => {
  const { root } = await render(
    <Composer
      blocked={composerBlocked(state)}
      canAbort={false}
      error={undefined}
      onSend={() => undefined}
      onAbort={() => undefined}
    />,
  );
  expect(root.querySelector("textarea")?.disabled).toBe(true);
  expect(button(root, "送出").disabled).toBe(true);
  expect(root.textContent).toContain(reason);
});

test("ready: sends the text and clears it", async () => {
  const sent: string[] = [];
  const { root } = await render(
    <Composer
      blocked={composerBlocked(ready)}
      canAbort={false}
      error={undefined}
      onSend={(t) => sent.push(t)}
      onAbort={() => undefined}
    />,
  );
  const area = root.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    // Through the prototype's setter, as typing does: React ignores a value set on the element.
    // oxlint-disable-next-line typescript/unbound-method
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(area, "嗨");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(root, "送出").click());
  expect(sent).toEqual(["嗨"]);
  expect(area.value).toBe("");
});
