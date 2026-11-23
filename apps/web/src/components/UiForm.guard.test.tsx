// @vitest-environment jsdom
import type { WireItem } from "@tars/protocol";
import { act } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { render } from "../render.ts";
import { initial, type State } from "../state.ts";
import sample from "./ledger-form.sample.json";
import { Thread } from "./Thread.tsx";

/** What to make throw: the form check, or A2UI while drawing. */
const fail = vi.hoisted(() => ({ check: false, card: false }));

vi.mock("@tars/protocol", async (real) => {
  const m = await real<typeof import("@tars/protocol")>();
  return {
    ...m,
    uiFormProblem: (...a: Parameters<typeof m.uiFormProblem>) => {
      if (fail.check) throw new RangeError("Maximum call stack size exceeded");
      return m.uiFormProblem(...a);
    },
  };
});

vi.mock("./A2uiCard.tsx", async (real) => {
  const m = await real<typeof import("./A2uiCard.tsx")>();
  return {
    ...m,
    default: (p: Parameters<typeof m.default>[0]) => {
      if (fail.card) throw new TypeError("A2UI broke");
      return m.default(p);
    },
  };
});

/**
 * The form's lazy chunk (A2UI, Base UI) loads here once, with time to spare: its first import()
 * takes seconds on a busy machine, more than a test's 5 s.
 */
beforeAll(async () => {
  await import("./A2uiCard.tsx");
}, 60_000);

afterEach(() => {
  document.body.innerHTML = "";
  fail.check = false;
  fail.card = false;
});

const T = "turn-00000001";

/** A message, the form, and a message after it. */
const state: State = {
  ...initial,
  connection: "open",
  conv: "conv-1",
  items: [
    { seq: 1, turn: T, kind: "user", text: "幫我記帳", truncated: false },
    {
      seq: 2,
      turn: T,
      kind: "tool_call",
      callId: "call-form-0001",
      name: "ui_show",
      input: JSON.stringify(sample),
      truncated: false,
    },
    {
      seq: 3,
      turn: T,
      kind: "tool_result",
      callId: "call-form-0001",
      status: "done",
      text: "已顯示表單。",
      truncated: false,
    },
    { seq: 4, turn: T, kind: "assistant", text: "請填表單", truncated: false, state: "complete" },
  ] satisfies WireItem[],
};

async function draw() {
  const { root } = await render(
    <Thread
      state={state}
      onOlder={() => undefined}
      after={() => null}
      forms={{ submit: () => undefined, blocked: undefined, sending: undefined, error: undefined }}
    />,
  );
  for (let i = 0; i < 400 && root.querySelector(".ui-form-fallback, .ui-form label") === null; i++)
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  return root;
}

test("A2UI throwing while drawing: only the card says so, the messages stay", async () => {
  fail.card = true;
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const root = await draw();
  quiet.mockRestore();
  expect(root.querySelector(".ui-form-fallback")?.textContent).toBe("這張表單出錯了，無法顯示。");
  expect(root.querySelector(".tool-step")).not.toBeNull();
  expect(root.querySelector(".ui-form")).toBeNull();
  expect(root.textContent).toContain("幫我記帳");
  expect(root.textContent).toContain("請填表單");
});

test("the form check throwing: the form is refused, not thrown on", async () => {
  fail.check = true;
  const root = await draw();
  expect(root.querySelector(".ui-form-fallback")?.textContent).toBe(
    "表單含有不允許的元件或動作，不顯示。",
  );
  expect(root.textContent).toContain("請填表單");
});

test("unmocked, the same thread draws the form", async () => {
  const root = await draw();
  expect(root.querySelector(".ui-form label")).not.toBeNull();
});
