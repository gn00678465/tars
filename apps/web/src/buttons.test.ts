// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

// Read from disk: the test runner hands a stylesheet import back empty.
const sheet = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const styles = sheet("./styles.css");
const app = sheet("./app.css");

// What a hovered button's background and border resolve to, by the cascade's own rules over the
// two sheets in the order main.tsx loads them: the most specific selector wins, a later one a tie.
// Rules inside @media and the like are left out; none of the buttons' hovers is in one.
type Rule = { selector: string; decls: Map<string, string>; order: number };

function rules(css: string, from: number): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (depth > 0 && j < text.length) {
      if (text[j] === "{") depth++;
      if (text[j] === "}") depth--;
      j++;
    }
    if (!head.startsWith("@")) {
      const decls = new Map<string, string>();
      for (const d of text.slice(open + 1, j - 1).split(";")) {
        const at = d.indexOf(":");
        if (at > 0) decls.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
      }
      for (const selector of head.split(/,(?![^(]*\))/))
        out.push({ selector: selector.trim(), decls, order: from + out.length });
    }
    i = j;
  }
  return out;
}

const specificity = (s: string) => {
  const flat = s.replace(/:not\(/g, "(");
  const ids = (flat.match(/#[\w-]+/g) ?? []).length;
  const classes = (flat.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):[\w-]+/g) ?? []).length;
  const types = (flat.match(/(^|[\s>+~(])[a-z][\w-]*/g) ?? []).length;
  return ids * 1e6 + classes * 1e3 + types;
};

const ALL = [...rules(styles, 0), ...rules(app, 100_000)];

function hovered(classes: string): Record<string, string | undefined> {
  const el = document.createElement("button");
  el.className = classes;
  document.body.append(el);
  const win: Record<string, [number, number, string]> = {};
  for (const r of ALL) {
    if (!r.selector.includes(":hover")) continue;
    if (!el.matches(r.selector.replaceAll(":hover", ""))) continue;
    const rank = specificity(r.selector);
    for (const [k, v] of r.decls) {
      const prop = k === "background" ? "background" : k;
      const was = win[prop];
      if (was === undefined || rank > was[0] || (rank === was[0] && r.order > was[1]))
        win[prop] = [rank, r.order, v];
    }
  }
  el.remove();
  return { background: win.background?.[2], border: win["border-color"]?.[2] };
}

describe("a button's hover is its own variant's, not the plain glass one", () => {
  test.each([
    ["sg-btn sg-btn-primary", "var(--primary-hover)", "var(--primary-edge)"],
    ["sg-btn sg-btn-primary sg-btn-sm", "var(--primary-hover)", "var(--primary-edge)"],
    ["sg-btn sg-btn-danger", "var(--status-error-hover)", "var(--status-error-border)"],
    ["sg-btn sg-btn-warn-action", "var(--status-error-hover)", "var(--status-warn-border)"],
    ["sg-btn sg-btn-approve", "var(--status-ok-hover)", "var(--status-ok-border)"],
    ["sg-btn sg-btn-ghost", "var(--hover)", "var(--glass-edge)"],
    ["sg-btn", "var(--glass-state)", "var(--glass-control-rim)"],
  ])("%s", (classes, background, border) => {
    expect(hovered(classes)).toEqual({ background, border });
  });

  test("a primary button keeps its dark text and its shadow when hovered", () => {
    const hover = ALL.filter((r) => r.selector.includes("sg-btn-primary:hover"));
    expect(hover.length).toBeGreaterThan(0);
    for (const r of hover) {
      expect(r.decls.has("color")).toBe(false);
      expect(r.decls.has("box-shadow")).toBe(false);
    }
  });
});
