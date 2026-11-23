// @vitest-environment jsdom
import type { UiContext, WireItem } from "@tars/protocol";
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import { initial, type State } from "../state.ts";
import sample from "./ledger-form.sample.json";
import { Thread } from "./Thread.tsx";
import { type FormHooks, toContext } from "./UiForm.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const T = "turn-00000001";
const CALL = "call-form-0001";

function thread(over: { input?: string; truncated?: boolean; status?: string; sent?: boolean }) {
  const items: WireItem[] = [
    {
      seq: 1,
      turn: T,
      kind: "tool_call",
      callId: CALL,
      name: "ui_show",
      input: over.input ?? JSON.stringify(sample),
      truncated: over.truncated ?? false,
    },
    {
      seq: 2,
      turn: T,
      kind: "tool_result",
      callId: CALL,
      status: over.status ?? "done",
      text: "已顯示表單。",
      truncated: false,
    },
  ];
  if (over.sent === true)
    items.push({
      seq: 3,
      turn: "turn-00000002",
      kind: "user",
      text: "〔表單送出〕記帳",
      truncated: false,
      uiCall: CALL,
    });
  return { ...initial, connection: "open", conv: "conv-1", items } satisfies State;
}

const hooks = (over: Partial<FormHooks> = {}) => {
  const sent: [string, UiContext][] = [];
  const h: FormHooks = {
    submit: (callId, context) => sent.push([callId, context]),
    blocked: undefined,
    sending: undefined,
    error: undefined,
    ...over,
  };
  return { h, sent };
};

/**
 * The lazy chunk and Lit both settle after React: wait until the form is drawn (its fields are
 * there) or nothing is loading. The first import is slow when the whole suite runs at once.
 */
async function drawn(root: HTMLElement) {
  const done = () =>
    root.querySelector(".ui-form-loading") === null &&
    (root.querySelector(".ui-form") === null || root.querySelector(".ui-form label") !== null);
  for (let i = 0; i < 400 && !done(); i++)
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const draw = async (state: State, forms?: FormHooks) => {
  const r = await render(
    <Thread
      state={state}
      onOlder={() => undefined}
      after={() => null}
      {...(forms === undefined ? {} : { forms })}
    />,
  );
  await drawn(r.root);
  return r.root;
};

const field = (root: HTMLElement, label: string) => {
  const l = [...root.querySelectorAll("label")].find((x) => x.textContent === label);
  const input = l?.parentElement?.querySelector("input");
  if (input === null || input === undefined) throw new Error(`no field ${label}`);
  return input;
};

const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
};

const submitButton = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLButtonElement>(".ui-form-body button")].find(
    (b) => b.textContent?.trim() === "送出",
  );

test("a ui_show call is a form in the page's frame, which the model cannot write", async () => {
  const { h } = hooks();
  const root = await draw(thread({}), h);
  expect(root.querySelector(".ui-form-head")?.textContent).toBe("表單（由 TARS 產生）");
  expect(root.querySelector(".ui-form-foot")?.textContent).toBe(
    "送出後 TARS 會先預覽，寫入前會再出核准卡。",
  );
  expect(root.querySelector(".ui-form-body")?.hasAttribute("inert")).toBe(false);
  expect(root.querySelector(".tool-step")).toBeNull();
  expect(field(root, "金額").value).toBe("");
});

test("the button sends the form's values as ui.submit's context, for this call", async () => {
  const { h, sent } = hooks();
  const root = await draw(thread({}), h);
  await type(field(root, "金額"), "190");
  await type(field(root, "摘要"), "晚餐");
  await act(async () => submitButton(root)?.click());
  expect(sent).toEqual([
    [
      CALL,
      {
        date: "2026-11-23",
        amount: "190",
        target: [],
        source: ["Assets:Cash:Wallet"],
        narration: "晚餐",
        payee: "",
      },
    ],
  ]);
});

test("nothing is sent while the page cannot send; the reason is under the form", async () => {
  const { h, sent } = hooks({ blocked: "回合進行中" });
  const root = await draw(thread({}), h);
  await type(field(root, "金額"), "190");
  await type(field(root, "摘要"), "晚餐");
  await act(async () => submitButton(root)?.click());
  expect(sent).toEqual([]);
  expect(root.querySelector(".ui-form-note")?.textContent).toBe("回合進行中");
});

test("sent (a user item names the call): locked and said so, after a reload too", async () => {
  const { h } = hooks();
  const root = await draw(thread({ sent: true }), h);
  expect(root.querySelector(".ui-form-body")?.hasAttribute("inert")).toBe(true);
  expect(root.querySelector(".ui-form.state-sent .ui-form-note")?.textContent).toBe("已送出");
});

test("on its way: locked; refused: the reason under it, open again", async () => {
  const sending = await draw(thread({}), hooks({ sending: CALL }).h);
  expect(sending.querySelector(".ui-form-body")?.hasAttribute("inert")).toBe(true);
  expect(sending.querySelector(".ui-form-note")?.textContent).toBe("送出中…");
  document.body.innerHTML = "";
  const refused = await draw(
    thread({}),
    hooks({ error: { callId: CALL, text: "本機端不接受這些值，請檢查後再送出" } }).h,
  );
  expect(refused.querySelector(".ui-form-body")?.hasAttribute("inert")).toBe(false);
  expect(refused.querySelector(".ui-form-note.error")?.textContent).toBe(
    "本機端不接受這些值，請檢查後再送出",
  );
});

test("what cannot be drawn is a line and the plain tool step, with no frame", async () => {
  for (const [over, line] of [
    [{ truncated: true }, "表單內容不完整，無法顯示。"],
    [{ input: "{not json" }, "表單內容不完整，無法顯示。"],
    [
      { input: JSON.stringify({ components: [{ id: "root", component: "Modal" }] }) },
      "表單的格式不對，無法顯示。",
    ],
  ] as const) {
    const root = await draw(thread(over), hooks().h);
    expect(root.querySelector(".ui-form-fallback")?.textContent).toBe(line);
    expect(root.querySelector(".tool-step")).not.toBeNull();
    expect(root.querySelector(".ui-form")).toBeNull();
    document.body.innerHTML = "";
  }
});

test("a ui_show the local end failed is only a tool step", async () => {
  const root = await draw(thread({ status: "failed" }), hooks().h);
  expect(root.querySelector(".ui-form")).toBeNull();
  expect(root.querySelector(".tool-step")).not.toBeNull();
});

test("toContext: strings and lists go; numbers as text; unbound left out; too long refused", () => {
  expect(toContext({ a: "x", b: ["y"], c: 3, d: undefined, e: null })).toEqual({
    a: "x",
    b: ["y"],
    c: "3",
  });
  expect(toContext({ a: "x".repeat(201) })).toBeUndefined();
  expect(toContext({ a: { nested: 1 } })).toBeUndefined();
});
