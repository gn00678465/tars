import { describe, expect, test } from "bun:test";
import sample from "../../../apps/web/src/components/ledger-form.sample.json";
import { uiFormProblem } from "../src/ui.ts";

const parts = sample.components as Record<string, unknown>[];
const replace = (id: string, over: Record<string, unknown>) =>
  parts.map((c) => (c.id === id ? { ...c, ...over } : c));

describe("uiFormProblem: what a ui_show form may hold", () => {
  test("the ledger form passes", () => {
    expect(uiFormProblem(parts)).toBeUndefined();
  });

  test("a component outside the list is refused: Modal, Image", () => {
    expect(uiFormProblem([...parts, { id: "m", component: "Modal" }])).toContain("Modal");
    expect(uiFormProblem([...parts, { id: "i", component: "Image", url: "https://x" }])).toContain(
      "Image",
    );
  });

  test("a functionCall action, or openUrl called from any value, is refused", () => {
    const open = { functionCall: { call: "openUrl", args: { url: "https://x" } } };
    expect(uiFormProblem(replace("submit", { action: open }))).toBeDefined();
    expect(
      uiFormProblem(replace("title", { text: { "@call": "openUrl", args: { url: "https://x" } } })),
    ).toContain("openUrl");
  });

  test("exactly one button, sending ledger_submit", () => {
    expect(
      uiFormProblem(replace("submit", { action: { event: { name: "other" } } })),
    ).toBeDefined();
    expect(uiFormProblem(parts.filter((c) => c.id !== "submit"))).toContain("0 buttons");
    expect(
      uiFormProblem([...parts, { ...parts.find((c) => c.id === "submit"), id: "b2" }]),
    ).toContain("2 buttons");
    expect(uiFormProblem(replace("title", { action: { event: { name: "ledger_submit" } } }))).toBe(
      "Text has an action",
    );
  });
});
