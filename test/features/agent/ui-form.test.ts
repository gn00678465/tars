import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_TEXT_BYTES } from "@tars/protocol";
import { utf8Bytes } from "../../../src/features/agent/bytes.ts";
import { formMessage, UI_SHOW_DONE, uiShow } from "../../../src/features/agent/ui-form.ts";
import sample from "../../../apps/web/src/components/ledger-form.sample.json";
import { REPO } from "./engine-fixture.ts";

type Form = { components: Record<string, unknown>[]; dataModel: Record<string, unknown> };
const form = (): Form => structuredClone(sample) as Form;

/** The form with its title's text padded so the input serializes to exactly `bytes`. */
function sized(bytes: number): Form {
  const f = form();
  const title = f.components.find((c) => c.id === "title") as { text: string };
  title.text += "x".repeat(bytes - utf8Bytes(JSON.stringify(f)));
  return f;
}

describe("ui_show: what the local end checks before the page draws the form", () => {
  test("the B1 sample is shown, with the result that tells the model to stop the turn", () => {
    expect(uiShow(form(), "remote")).toEqual({
      status: "done",
      text: UI_SHOW_DONE,
      truncated: false,
    });
  });

  test("the terminal cannot show a form: ask in words instead", () => {
    const out = uiShow(form(), "tty");
    expect(out.status).toBe("failed");
    expect(out.text).toContain("這個入口不能顯示表單，改用文字問");
  });

  test("16,384 bytes is taken; one more is refused, since the page would get it cut", () => {
    expect(utf8Bytes(JSON.stringify(sized(TOOL_TEXT_BYTES)))).toBe(TOOL_TEXT_BYTES);
    expect(uiShow(sized(TOOL_TEXT_BYTES), "remote").status).toBe("done");
    const over = uiShow(sized(TOOL_TEXT_BYTES + 1), "remote");
    expect(over.status).toBe("failed");
    expect(over.text).toContain(`${TOOL_TEXT_BYTES + 1} 位元組，超過 ${TOOL_TEXT_BYTES}`);
  });

  test("each refusal says which rule, so the model can fix it and call again", () => {
    const cases: [string, (f: Form) => unknown][] = [
      [
        "component Image is not allowed",
        (f) => f.components.push({ id: "pic", component: "Image" }),
      ],
      [
        "2 buttons, not one",
        (f) =>
          f.components.push({
            ...(f.components.find((c) => c.id === "submit") as object),
            id: "b2",
          }),
      ],
      [
        "the button's action is not the ledger_submit event",
        (f) =>
          ((f.components.find((c) => c.id === "submit") as { action: unknown }).action = {
            event: { name: "pay_now" },
          }),
      ],
      [
        "a functionCall action",
        (f) =>
          ((f.components.find((c) => c.id === "title") as { text: unknown }).text = {
            functionCall: { call: "openUrl", args: { url: "https://example.com" } },
          }),
      ],
    ];
    for (const [why, change] of cases) {
      const f = form();
      change(f);
      const out = uiShow(f, "remote");
      expect(out.status).toBe("failed");
      expect(out.text).toContain(why);
    }
    for (const bad of [
      [],
      { components: [] },
      { ...form(), extra: 1 },
      { ...form(), dataModel: [] },
    ])
      expect(uiShow(bad, "remote").text).toContain(
        "輸入只能有 components（陣列）與 dataModel（物件）",
      );
  });

  test("dataModel is checked as the page checks it: depth, how many values, a refused key", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 17; i++) deep = { a: deep };
    // Under the byte limit, over the count: the components and this list together.
    const many = { list: Array.from({ length: 2000 }, () => 0) };
    const cases: [string, unknown][] = [
      ["nested deeper than 16", deep],
      ["more than 2000 values", many],
      ["key __proto__", JSON.parse('{"date": "", "__proto__": {"polluted": true}}')],
      ["key constructor", { date: "", constructor: "x" }],
    ];
    for (const [why, dataModel] of cases) {
      const out = uiShow({ ...form(), dataModel }, "remote");
      expect([why, out.status]).toEqual([why, "failed"]);
      expect(out.text).toContain(why);
    }
    let fine: unknown = "x";
    for (let i = 0; i < 14; i++) fine = { a: fine };
    expect(
      uiShow({ ...form(), dataModel: { ...form().dataModel, extra: fine } }, "remote").status,
    ).toBe("done");
  });

  test("ledger-form.md's example is B1's sample, byte for byte as JSON", () => {
    const doc = readFileSync(join(REPO, "tars-skills/tars-mode/reference/ledger-form.md"), "utf8");
    const json = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(JSON.parse(json ?? "null")).toEqual(sample);
  });
});

const ok = {
  date: "2026-11-23",
  amount: "190",
  target: ["Expenses:Food:Dinner"],
  source: ["Assets:Cash:Wallet"],
  narration: "晚餐",
  payee: "",
};

describe("ledger_submit: a sent form's values, checked again here", () => {
  test("the message is the fixed template: field names and values, no instruction", () => {
    expect(formMessage(form(), ok)).toEqual({
      ok: true,
      text: [
        "〔表單送出〕記帳",
        "日期：2026-11-23",
        "金額：190",
        "借方帳戶：Expenses:Food:Dinner",
        "貸方帳戶：Assets:Cash:Wallet",
        "摘要：晚餐",
        "付款對象：（空）",
      ].join("\n"),
    });
    const paid = formMessage(form(), { ...ok, payee: "小吃店", amount: "1234.5" });
    expect(paid.ok && paid.text.split("\n").slice(2)).toEqual([
      "金額：1234.5",
      "借方帳戶：Expenses:Food:Dinner",
      "貸方帳戶：Assets:Cash:Wallet",
      "摘要：晚餐",
      "付款對象：小吃店",
    ]);
    // A field the page left unset is empty, as the browser sends no value for it.
    const { payee: _, ...noPayee } = ok;
    expect(formMessage(form(), noPayee).ok).toBe(true);
  });

  test("refused values: each rule of design 2.3", () => {
    const refused: Record<string, unknown>[] = [
      { date: "2026-02-30" },
      { date: "2026/11/23" },
      { amount: "0" },
      { amount: "-5" },
      { amount: "1e3" },
      { amount: "1.23456" },
      { amount: "1234567890123" },
      { target: ["Expenses:Unlisted"] },
      { source: ["Assets:Bank:Other"] },
      { source: ["Expenses:Food:Dinner"], target: ["Expenses:Food:Dinner"] },
      { target: [] },
      { target: ["Expenses:Food:Dinner", "Expenses:Transport"] },
      { target: "Expenses:Food:Dinner" },
      { amount: ["190"] },
      { narration: "" },
      { narration: "字".repeat(201) },
      { payee: "字".repeat(101) },
      { narration: "-rf" },
      { narration: "晚\n餐" },
      { extra: "x" },
    ];
    for (const change of refused)
      expect([change, formMessage(form(), { ...ok, ...change } as never).ok]).toEqual([
        change,
        false,
      ]);
    expect(
      formMessage(form(), { ...ok, narration: "字".repeat(200), payee: "字".repeat(100) }).ok,
    ).toBe(true);
  });

  test("the accounts come from the stored form's pickers, by the path the button sends", () => {
    const f = form();
    const target = f.components.find((c) => c.id === "target") as { options: unknown[] };
    target.options = [{ label: "Income:Salary", value: "Income:Salary" }];
    expect(formMessage(f, ok).ok).toBe(false);
    expect(formMessage(f, { ...ok, target: ["Income:Salary"] }).ok).toBe(true);
    // A form whose button is not ledger_submit has no rules here: refused.
    const other = form();
    (other.components.find((c) => c.id === "submit") as { action: unknown }).action = {
      event: { name: "other" },
    };
    expect(formMessage(other, ok).ok).toBe(false);
  });
});
