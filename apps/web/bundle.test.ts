// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite-plus";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { assetsInlineLimit } from "./headers.ts";

/**
 * Under this much JS a first visit loads, gzipped: main's 237,680 bytes at M4-P3c (ae89269) plus
 * 4 kB for the composer on Input Group and Textarea; P3c measured 240,440. M4-P3b's step was
 * main's 232,977 (8de1362) plus 8 kB for Trace, Code Block, Item and lucide. M4-P3a's step was main's 224,351 (82467ac) plus 9 kB for the Message Scroller.
 * main's count has the screen readout in the status sheet, about 1 kB: it is for finding the
 * iPhone's bottom gap, and goes when that is found.
 * P2 put Base UI's overlays on the first load (main was 138,115): the design's estimate was about
 * 210 kB; the phone's Drawer is 11.8 kB of it and the one tooltip 4 kB
 * (m4_web_stack_design.md 7 raises it phase by phase).
 * Measured by this file's own build, which leaves out the Cloudflare and _headers plugins: they
 * do not change the page's chunks.
 */
const FIRST_LOAD_LIMIT = 237_680 + 4_000;

/** Strings only zod 3 has, and only zod 4 has (research/a2ui_proto_result.md, Zod 4 (4)). */
const ZOD3 = "Unrecognized key(s) in object";
const ZOD4 = "_zod";
/** A string only A2UI's basic catalog has: the prefix of its elements. */
const A2UI = "a2ui-basic";

const out = mkdtempSync(join(tmpdir(), "tars-web-bundle-"));
let html = "";
const js = new Map<string, string>();
const css = new Map<string, string>();
const fonts: string[] = [];

beforeAll(async () => {
  // Vitest sets NODE_ENV to test, which would build React's development code.
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  await build({
    configFile: false,
    mode: "production",
    root: import.meta.dirname,
    logLevel: "silent",
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": join(import.meta.dirname, "src") } },
    build: { outDir: out, emptyOutDir: true, assetsInlineLimit },
  }).finally(() => {
    process.env.NODE_ENV = env;
  });
  html = readFileSync(join(out, "index.html"), "utf8");
  for (const f of readdirSync(join(out, "assets")))
    for (const [ext, map] of [
      [".js", js],
      [".css", css],
    ] as const)
      if (f.endsWith(ext)) map.set(`/assets/${f}`, readFileSync(join(out, "assets", f), "utf8"));
  fonts.push(...readdirSync(join(out, "assets")).filter((f) => f.endsWith(".woff2")));
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

/** The scripts index.html loads or preloads. */
const entries = () =>
  [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((src) => js.has(src));

/**
 * A chunk's imports, as paths like the HTML's: static ones are `import"./x.js"` and
 * `from"./x.js"`, dynamic ones `import(`./x.js`)` (vite's minified output). A chunk's imports
 * are relative to /assets/. Known limit: only literal paths are read; an import() of a variable
 * or a built string is missed. The test below that every chunk is reached catches a chunk only
 * such an import loads.
 */
const imports = (src: string, dynamic: boolean) => {
  const code = js.get(src) as string;
  const re = dynamic
    ? /\bimport\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/g
    : /(?:\bfrom|\bimport)\s*["'`]\.\/([^"'`]+\.js)["'`]/g;
  return [...code.matchAll(re)].map((m) => `/assets/${m[1] as string}`);
};

/** Every chunk reachable from the starts, following static imports and, if asked, dynamic. */
const reach = (dynamic: boolean, starts = entries()) => {
  const seen = new Set<string>();
  const next = [...starts];
  for (let src = next.pop(); src !== undefined; src = next.pop()) {
    if (seen.has(src)) continue;
    seen.add(src);
    next.push(...imports(src, false), ...(dynamic ? imports(src, true) : []));
  }
  return seen;
};

/** What a first visit fetches before any import(): the entries and what they import, transitively. */
const firstLoad = () => [...reach(false)];

/** Chunks only an import() reaches: fetched when a form is first drawn. */
const later = () => {
  const first = reach(false);
  return [...reach(true)].filter((src) => !first.has(src));
};

test("every chunk is reached from index.html, so none escapes the checks below", () => {
  expect([...reach(true)].sort()).toEqual([...js.keys()].sort());
});

test("a first visit loads no zod 3 and about as much JS as before A2UI", () => {
  const first = firstLoad();
  expect(first.length).toBeGreaterThan(0);
  for (const src of first) expect(js.get(src), src).not.toContain(ZOD3);
  // The marker is real: @tars/protocol's zod 4 is on the first load.
  expect(first.some((src) => js.get(src)?.includes(ZOD4))).toBe(true);
  const gzip = first.reduce((n, src) => n + gzipSync(js.get(src) as string).length, 0);
  console.log(`first load: ${first.join(", ")} = ${gzip} bytes gzip`);
  expect(gzip).toBeLessThan(FIRST_LOAD_LIMIT);
  // The stylesheets, to compare phase by phase; no limit yet (m4_web_stack_design.md 7).
  const styles = [...css.values()];
  console.log(
    `first load CSS: ${styles.reduce((n, c) => n + c.length, 0)} bytes, ${styles.reduce((n, c) => n + gzipSync(c).length, 0)} gzip`,
  );
});

test("A2UI and its zod 3 come only by import(), and nothing so loaded has zod 4", () => {
  const late = later();
  expect(late.some((src) => js.get(src)?.includes(A2UI))).toBe(true);
  expect(late.some((src) => js.get(src)?.includes(ZOD3))).toBe(true);
  // A2uiCard and what it imports must not pull @tars/protocol's zod 4 in (m4_design_a2ui.md 6.2),
  // whether into its own chunk or a shared one only it loads.
  for (const src of late) expect(js.get(src), src).not.toContain(ZOD4);
  console.log(
    `later: ${late.map((src) => `${src} = ${gzipSync(js.get(src) as string).length}`).join(", ")} bytes gzip`,
  );
});

test("a chunk A2UI shares with the first load holds neither A2UI nor its zod 3", () => {
  const first = reach(false);
  const late = later();
  // What the late chunks import statically and the first load has too: react and the like.
  const shared = [...reach(false, late)].filter((src) => first.has(src));
  const list = `shared chunks: ${shared.join(", ") || "none"}`;
  for (const src of shared) {
    const code = js.get(src) as string;
    expect(code.includes(ZOD3), `${src} has zod 3; ${list}`).toBe(false);
    expect(code.includes(A2UI), `${src} has A2UI; ${list}`).toBe(false);
  }
});

test("Noto Sans TC is 108 font files under /assets/, none inlined, nothing from another host", () => {
  const styles = [...css.values()].join("\n");
  const urls = [...styles.matchAll(/url\(([^)]+\.woff2)\)/g)].map((m) => m[1] as string);
  expect(fonts.length).toBe(108);
  expect(urls.sort()).toEqual(fonts.map((f) => `/assets/${f}`).sort());
  expect(styles).not.toContain("data:font");
  expect(styles).not.toMatch(/https?:\/\//);
  expect(styles).toMatch(/font-family:"?Noto Sans TC Variable/);
});
