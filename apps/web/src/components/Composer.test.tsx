// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { button, render } from "../render.ts";
import { composerBlocked, initial, type State } from "../state.ts";
import { Composer } from "./Composer.tsx";
import { skillInvocationText } from "@tars/protocol";
import type { Skill } from "./slash.ts";

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
      skills={undefined}
      onSend={() => undefined}
      onAbort={() => undefined}
      onCommand={() => undefined}
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
      skills={undefined}
      onSend={(t) => sent.push(t)}
      onAbort={() => undefined}
      onCommand={() => undefined}
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

const SKILLS: Skill[] = [
  { name: "tars-mode", description: "依路由表執行入庫腳本", localOnly: false },
  { name: "socratic-tutor", description: "蘇格拉底提問", localOnly: false },
  { name: "memory", description: "寫入記憶", localOnly: true },
];

async function composer(skills: readonly Skill[] | undefined) {
  const sent: string[] = [];
  const commands: string[] = [];
  const r = await render(
    <Composer
      blocked={undefined}
      canAbort={false}
      error={undefined}
      skills={skills}
      onSend={(t) => sent.push(t)}
      onAbort={() => undefined}
      onCommand={(c) => commands.push(c)}
    />,
  );
  const area = r.root.querySelector("textarea") as HTMLTextAreaElement;
  const type = (value: string) =>
    act(async () => {
      // oxlint-disable-next-line typescript/unbound-method
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(area, value);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (k: string) =>
    act(async () => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    });
  const options = () =>
    [...r.root.querySelectorAll<HTMLElement>("[role=option]")].map((o) => ({
      name: o.querySelector(".slash-cmd")?.textContent,
      selected: o.getAttribute("aria-selected") === "true",
      disabled: o.getAttribute("aria-disabled") === "true",
    }));
  return { ...r, sent, commands, area, type, key, options };
}

test("/ opens the menu: built-ins, the skills, local-only ones marked and not choosable", async () => {
  const c = await composer(SKILLS);
  await c.type("/");
  expect(c.area.getAttribute("aria-expanded")).toBe("true");
  expect(c.options()).toEqual([
    { name: "/new", selected: true, disabled: false },
    { name: "/cost", selected: false, disabled: false },
    { name: "/help", selected: false, disabled: false },
    { name: "/tars-mode", selected: false, disabled: false },
    { name: "/socratic-tutor", selected: false, disabled: false },
    { name: "/memory", selected: false, disabled: true },
  ]);
  expect(c.root.textContent).toContain("僅限本機");
  // No fake items: the terminal's /model, /effort, /compact, /wiki are not offered.
  expect(c.root.textContent).not.toMatch(/\/(model|effort|compact|wiki)/);
});

test("arrows skip the local-only one; Enter on a skill puts it in the box, then sends the terminal's wording", async () => {
  const c = await composer(SKILLS);
  await c.type("/");
  await c.key("ArrowUp");
  // Wrapped to the last choosable one, not /memory.
  expect(c.options().find((o) => o.selected)?.name).toBe("/socratic-tutor");
  await c.key("ArrowUp");
  await c.key("Enter");
  expect(c.area.value).toBe("/tars-mode ");
  expect(c.sent).toEqual([]);
  await c.type("/tars-mode 記一筆午餐 120");
  await c.key("Enter");
  expect(c.sent).toEqual([skillInvocationText("tars-mode", "記一筆午餐 120")]);
});

test("typing filters; Esc closes; Tab on a built-in runs it", async () => {
  const c = await composer(SKILLS);
  await c.type("/cos");
  expect(c.options().map((o) => o.name)).toEqual(["/cost"]);
  await c.key("Escape");
  expect(c.area.getAttribute("aria-expanded")).toBe("false");
  // Typing again opens it again.
  await c.type("/cost");
  await c.key("Tab");
  expect(c.commands).toEqual(["cost"]);
  expect(c.area.value).toBe("");
  // /help lists everything: the menu opens on a bare /.
  await c.type("/help");
  await c.key("Enter");
  expect(c.area.value).toBe("/");
  expect(c.options()).toHaveLength(6);
});

test("a local-only skill or an unknown name sends nothing and says why; // sends one slash", async () => {
  const c = await composer(SKILLS);
  await c.type("/memory 記住這個");
  await c.key("Enter");
  expect(c.sent).toEqual([]);
  expect(c.root.querySelector("[role=alert]")?.textContent).toBe(
    "memory 要在 tars claude 裡用，這裡不送出",
  );
  await c.type("/nope x");
  await c.key("Enter");
  expect(c.root.querySelector("[role=alert]")?.textContent).toContain("不認得的指令 /nope");
  await c.type("//etc/hosts 是什麼");
  await c.key("Enter");
  expect(c.sent).toEqual(["/etc/hosts 是什麼"]);
});

test("a local end that sends no skill list: a slash line is a plain message", async () => {
  const c = await composer(undefined);
  await c.type("/whatever x");
  await c.key("Enter");
  expect(c.sent).toEqual(["/whatever x"]);
});
