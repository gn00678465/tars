// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

/**
 * The CSP allows no inline style: neither the copied components nor the files that wrap them
 * (AccountSelect, and M4-P2's overlays) set one. Base UI's own style, set through the CSSOM at
 * run time, is not inline markup and the CSP lets it be; this is about what the source writes.
 */
const dir = import.meta.dirname;
const copied = readdirSync(dir)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => join(dir, f));
const ours = [
  "AccountSelect.tsx",
  "Panel.tsx",
  "StatusBar.tsx",
  "ScreenProbe.tsx",
  "ContextSheet.tsx",
  "ModelSheet.tsx",
  "RunSetup.tsx",
  "ConversationList.tsx",
  "wiki/SourceOverlay.tsx",
  "PullIndicator.tsx",
  "NoticeItem.tsx",
  "Thread.tsx",
  "Composer.tsx",
].map((f) => join(dir, "..", f));

/**
 * Every way the source could set a style: the prop, a style key in an object (spread into an
 * element later), React's style type, the element's style object or attribute. The key's
 * lookbehind leaves Tailwind's class names alone (data-ending-style:opacity-0).
 */
const WRITES = [
  /\bstyle\s*=/,
  /(?<![-\w])style\s*:/,
  /["']style["']/,
  /CSSProperties/,
  /\.style\b/,
  /cssText/,
];

/** The ways `code` writes a style; `pullY` lets through the one call usePullToRefresh.ts makes. */
const writes = (code: string, pullY = false) => {
  const rest = pullY ? code.replace(PULL_Y, "") : code;
  return WRITES.filter((w) => w.test(rest)).map(String);
};
/**
 * The one exception (M4 pull to refresh): the page follows the finger by the pixel, through the
 * CSSOM, one custom property. Only this call, with this property, in this file.
 */
const PULL_FILE = join(dir, "..", "..", "usePullToRefresh.ts");
const PULL_Y = /\.style\.setProperty\("--pull-y", /g;

test("the shadcn components and the files using them write no style", () => {
  expect(copied.length).toBeGreaterThan(10);
  for (const f of [...copied, ...ours]) expect(writes(readFileSync(f, "utf8")), f).toEqual([]);
});

test("usePullToRefresh.ts writes --pull-y by setProperty, once, and no other style", () => {
  const code = readFileSync(PULL_FILE, "utf8");
  expect(code.match(PULL_Y)).toHaveLength(1);
  expect(writes(code, true)).toEqual([]);
  // Without the exception the file fails; with it, any other write still does.
  expect(writes(code)).not.toEqual([]);
  for (const other of [
    'page.style.setProperty("--other", "1px")',
    'page.style.setProperty("transform", "none")',
    "page.style.setProperty('--pull-y', '1px')",
    'page.style.removeProperty("--pull-y")',
    'page.style.transform = "none"',
    "page.style.cssText = ''",
    'page.setAttribute("style", "")',
    "<div style={{ top: 0 }} />",
  ])
    expect(writes(`page.style.setProperty("--pull-y", "1px");\n${other}`, true), other).not.toEqual(
      [],
    );
});

/**
 * What our files spread into an element. Each is an object literal in the same file, which the
 * style key check above covers. The copied components spread their caller's props on to Base UI
 * ({...props}); a style could come only from a caller, and the callers are these files.
 */
const SPREADS = new Set(["modelSeg", "effortSeg"]);

test("our files spread into an element only what is listed", () => {
  for (const f of ours)
    for (const m of readFileSync(f, "utf8").matchAll(/\{\.\.\.([A-Za-z_$][\w$]*)\}/g))
      expect(SPREADS.has(m[1] as string), `${f}: {...${m[1]}}`).toBe(true);
});
