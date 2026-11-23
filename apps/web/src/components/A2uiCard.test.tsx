// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import { choose, listed, press, typeInto } from "../testing.ts";
import A2uiCard, { buildSurface, type FormSpec } from "./A2uiCard.tsx";
import sample from "./ledger-form.sample.json";

/**
 * The ledger form's example (B2 moves it into tars-skills' reference) against the installed
 * A2UI with strict validation: an upgrade that renames a key or changes a schema fails here
 * (m4_design_a2ui.md 6.3).
 */
const spec = sample as FormSpec;
const CALL = "01a1fd71-be41-71e7-809a-4bb1e56800cc";

/** Unmounted before the body is cleared: an open combobox's popup is a portal under body. */
const mounted: (() => void)[] = [];
const mount: typeof render = async (el) => {
  const r = await render(el);
  mounted.push(r.unmount);
  return r;
};

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
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
  const { root } = await mount(
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
  // The preset account shows its label; the one not preset is empty.
  expect(account(root, "貸方帳戶（錢從哪來）").value).toBe("錢包（Assets:Cash:Wallet）");
  expect(account(root, "借方帳戶（錢去哪）").value).toBe("");
  expect(root.textContent).toContain("記一筆帳");
});

test("a form that does not validate draws what it is given instead", async () => {
  const { root } = await mount(
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

/** An account field by its label, which names it (htmlFor). */
const account = (root: HTMLElement, label: string) => {
  const l = [...root.querySelectorAll("label")].find((x) => x.textContent === label);
  const input = document.getElementById(l?.htmlFor ?? "");
  if (!(input instanceof HTMLInputElement)) throw new Error(`no account field ${label}`);
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
  const { root } = await mount(
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
  // Both accounts are required too: the target is not preset.
  expect(submit?.disabled).toBe(true);
  await typeInto(account(root, "借方帳戶（錢去哪）"), "晚餐");
  await choose("晚餐（Expenses:Food:Dinner）");
  expect(submit?.disabled).toBe(false);
  await act(async () => submit?.click());
  expect(sent.map((a) => [a.name, a.context])).toEqual([
    [
      "ledger_submit",
      {
        date: "2026-11-23",
        amount: "190",
        target: "Expenses:Food:Dinner",
        source: "Assets:Cash:Wallet",
        narration: "晚餐",
        payee: "",
      },
    ],
  ]);
});

const card = async (
  onAction: (a: { name: string; context: unknown }) => void = () => undefined,
) => {
  const { root } = await mount(
    <A2uiCard
      callId={CALL}
      spec={spec}
      onAction={onAction}
      frame={(f) => f}
      invalid={<p>bad</p>}
    />,
  );
  await settle();
  return root;
};

test("an account field lists every option, narrowed by typing Chinese or English", async () => {
  const root = await card();
  const target = account(root, "借方帳戶（錢去哪）");
  expect(target.getAttribute("role")).toBe("combobox");
  await press(target);
  expect(listed()).toEqual(["晚餐（Expenses:Food:Dinner）", "Expenses:Transport"]);
  // Each row shows the value that is sent, under a label that is not just the value.
  expect(
    [...document.querySelectorAll('[role="option"]')].map(
      (o) => o.querySelector('[data-part="value"]')?.textContent ?? null,
    ),
  ).toEqual(["Expenses:Food:Dinner", null]);
  await typeInto(target, "晚餐");
  expect(listed()).toEqual(["晚餐（Expenses:Food:Dinner）"]);
  await typeInto(target, "transport");
  expect(listed()).toEqual(["Expenses:Transport"]);
  await typeInto(target, "沒有這個");
  expect(listed()).toEqual([]);
  expect(document.body.textContent).toContain("沒有符合的帳戶");
});

test("a picked account is written as its English name, and the field shows its label", async () => {
  const sent: { name: string; context: unknown }[] = [];
  const root = await card((a) => sent.push(a));
  const source = account(root, "貸方帳戶（錢從哪來）");
  await typeInto(source, "信用卡");
  await choose("信用卡（Liabilities:CreditCard）");
  expect(source.value).toBe("信用卡（Liabilities:CreditCard）");
  await typeInto(account(root, "借方帳戶（錢去哪）"), "Transport");
  await choose("Expenses:Transport");
  await type(field(root, "金額"), "35");
  await type(field(root, "摘要"), "公車");
  const submit = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "送出");
  await act(async () => submit?.click());
  expect(sent.map((a) => a.context)).toMatchObject([
    { target: "Expenses:Transport", source: "Liabilities:CreditCard" },
  ]);
});

test("the account field writes no style; the styles there are Base UI's and A2UI's own", async () => {
  const root = await card();
  await press(account(root, "借方帳戶（錢去哪）"));
  expect(listed()).toHaveLength(2);
  // Set by script (CSSOM), which the CSP allows, unlike a style attribute in markup: A2UI's host
  // element, and Base UI's hidden form input, dismiss button, popup and its positioner.
  const theirs = (e: Element) =>
    e.tagName.startsWith("A2UI-") ||
    e.id.endsWith("-hidden-input") ||
    e.getAttribute("aria-label") === "Dismiss" ||
    e.getAttribute("data-slot") === "combobox-content" ||
    e.firstElementChild?.getAttribute("data-slot") === "combobox-content";
  const styled = [...document.querySelectorAll("[style]")];
  expect(styled.length).toBeGreaterThan(0);
  expect(styled.filter((e) => !theirs(e)).map((e) => e.outerHTML)).toEqual([]);
});

test("the page names every component's catalog, over any catalogId the form holds", () => {
  // uiFormProblem refuses a model's catalogId first; this is the page's own guard behind it.
  const wrong = {
    ...spec,
    components: spec.components.map((c) => {
      const id = (c as { id: string }).id;
      if (id === "title") return { ...(c as object), catalogId: "urn:tars:a2ui:catalog:v1" };
      if (id === "target") return { ...(c as object), catalogId: "urn:other" };
      return c;
    }),
  };
  const built = buildSurface(CALL, wrong, () => undefined);
  expect(built.ok ? "ok" : built.problem).toBe("ok");
});
