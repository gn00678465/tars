// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import A2uiCard, { buildSurface, type FormSpec } from "./A2uiCard.tsx";
import sample from "./ledger-form.sample.json";

/**
 * The ledger form's example (B2 moves it into tars-skills' reference) against the installed
 * A2UI with strict validation: an upgrade that renames a key or changes a schema fails here
 * (m4_design_a2ui.md 6.3).
 */
const spec = sample as FormSpec;
const CALL = "01a1fd71-be41-71e7-809a-4bb1e56800cc";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Lit renders after React: its updates settle on microtasks. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

test("the example validates strictly with the installed keys", () => {
  const built = buildSurface(CALL, spec, () => undefined);
  expect(built.ok ? "ok" : built.problem).toBe("ok");
});

test("the website's keys are refused: @checks on a component, a binding without @", () => {
  const withKey = (i: number, key: string, value: unknown) => ({
    ...spec,
    components: spec.components.map((c, j) => (j === i ? { ...(c as object), [key]: value } : c)),
  });
  const amount = spec.components.findIndex((c) => (c as { id: string }).id === "amount");
  expect(buildSurface(CALL, withKey(amount, "@checks", []), () => undefined).ok).toBe(false);
  // A binding written path, not @path, validates but would be drawn as [object Object]; only an
  // unknown component is caught by validation, so the rendering test below guards the rest.
  expect(
    buildSurface(
      CALL,
      { ...spec, components: [...spec.components, { id: "x", component: "Icon", name: "add" }] },
      () => undefined,
    ).ok,
  ).toBe(false);
});

test("drawn with the data model's values, none of them [object Object]", async () => {
  const { root } = await render(
    <A2uiCard
      callId={CALL}
      spec={spec}
      onAction={() => undefined}
      frame={(f) => f}
      invalid={<p>bad</p>}
    />,
  );
  await settle();
  const inputs = [...root.querySelectorAll("input")];
  expect(inputs.length).toBeGreaterThan(0);
  for (const i of inputs) expect(i.value).not.toContain("[object Object]");
  expect(root.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe("2026-11-23");
  const checked = inputs.filter((i) => i.type === "radio" && i.checked).map((i) => i.value);
  expect(checked).toEqual(["Assets:Cash:Wallet"]);
  expect(root.textContent).toContain("記一筆帳");
});

test("a form that does not validate draws what it is given instead", async () => {
  const { root } = await render(
    <A2uiCard
      callId={CALL}
      spec={{ components: [{ id: "root", component: "Modalx" }] }}
      onAction={() => undefined}
      frame={(f) => f}
      invalid={<p className="bad">bad</p>}
    />,
  );
  expect(root.querySelector(".bad")?.textContent).toBe("bad");
});

/** A text field by its label: the basic catalog puts the two side by side, unassociated. */
const field = (root: HTMLElement, label: string) => {
  const l = [...root.querySelectorAll("label")].find((x) => x.textContent === label);
  const input = l?.parentElement?.querySelector("input");
  if (input === null || input === undefined) throw new Error(`no field ${label}`);
  return input;
};

/** Types into an input as a person would: the value, then the events Lit listens for. */
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};

test("the button's checks keep it off until the required fields are filled; then it sends", async () => {
  const sent: { name: string; context: unknown }[] = [];
  const { root } = await render(
    <A2uiCard
      callId={CALL}
      spec={spec}
      onAction={(a) => sent.push(a)}
      frame={(f) => f}
      invalid={<p>bad</p>}
    />,
  );
  await settle();
  const submit = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "送出");
  expect(submit?.disabled).toBe(true);
  await type(field(root, "金額"), "190");
  expect(submit?.disabled).toBe(true);
  await type(field(root, "摘要"), "晚餐");
  expect(submit?.disabled).toBe(false);
  await act(async () => submit?.click());
  expect(sent.map((a) => [a.name, a.context])).toEqual([
    [
      "ledger_submit",
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
