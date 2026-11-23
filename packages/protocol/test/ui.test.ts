import { describe, expect, test } from "bun:test";
import sample from "../../../apps/web/src/components/ledger-form.sample.json";
import { UI_MAX_DEPTH, UI_MAX_NODES, uiFormProblem } from "../src/ui.ts";

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

describe("uiFormProblem: bounded, whatever the input", () => {
  /** Arrays n deep, as JSON.parse would give them. */
  const nest = (n: number) => JSON.parse("[".repeat(n) + "]".repeat(n)) as unknown;
  /** The components with n more levels inside the title (level 2): n + 2 levels in all. */
  const deeper = (n: number) => replace("title", { extra: nest(n) });
  /** Values as uiFormProblem counts them: every value, containers included. */
  const count = (v: unknown): number =>
    1 +
    (typeof v === "object" && v !== null
      ? Object.values(v).reduce<number>((n, x) => n + count(x), 0)
      : 0);

  test("5,000 levels of arrays is refused, not a stack overflow", () => {
    expect(uiFormProblem([{ id: "x", component: "Column", children: nest(5_000) }])).toBe(
      `nested deeper than ${UI_MAX_DEPTH}`,
    );
  });

  test("the depth limit: at it passes, one past it is refused", () => {
    expect(uiFormProblem(deeper(UI_MAX_DEPTH - 2))).toBeUndefined();
    expect(uiFormProblem(deeper(UI_MAX_DEPTH - 1))).toBe(`nested deeper than ${UI_MAX_DEPTH}`);
  });

  test("the value limit counts components and data together: at it passes, past it refused", () => {
    const base = count(parts) + count(sample.dataModel);
    const pad = (n: number) => ({ ...sample.dataModel, pad: Array.from({ length: n }, () => "") });
    // pad itself is one value, and each of its strings one more.
    expect(uiFormProblem(parts, pad(UI_MAX_NODES - base - 1))).toBeUndefined();
    expect(uiFormProblem(parts, pad(UI_MAX_NODES - base))).toBe(`more than ${UI_MAX_NODES} values`);
    expect(
      uiFormProblem(
        parts,
        Array.from({ length: 100_000 }, () => 0),
      ),
    ).toBe(`more than ${UI_MAX_NODES} values`);
  });

  test("__proto__, constructor and prototype are refused at any level, in data too", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const deep = JSON.parse(`{"a":[{"${key}":{"x":1}}]}`) as unknown;
      expect(uiFormProblem(replace("title", { extra: deep }))).toBe(`key ${key}`);
      expect(uiFormProblem(parts, JSON.parse(`{"${key}":1}`))).toBe(`key ${key}`);
    }
  });

  test("the ledger form with its data passes", () => {
    expect(uiFormProblem(parts, sample.dataModel)).toBeUndefined();
  });
});
