// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { build } from "vite-plus";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

/**
 * The JS a first visit loads, gzipped, on main before A2UI (m4_design_a2ui.md 7.1: it may grow
 * by less than 5 kB). Measured by this file's own build, which leaves out the Cloudflare and
 * _headers plugins: they do not change the page's chunks.
 */
const FIRST_LOAD_GZIP = 133_933;
const FIRST_LOAD_SLACK = 5_000;

/** Strings only zod 3 has, and only zod 4 has (research/a2ui_proto_result.md, Zod 4 (4)). */
const ZOD3 = "Unrecognized key(s) in object";
const ZOD4 = "_zod";

const out = mkdtempSync(join(tmpdir(), "tars-web-bundle-"));
let html = "";
const js = new Map<string, string>();

beforeAll(async () => {
  // Vitest sets NODE_ENV to test, which would build React's development code.
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  await build({
    configFile: false,
    mode: "production",
    root: import.meta.dirname,
    logLevel: "silent",
    plugins: [react()],
    build: { outDir: out, emptyOutDir: true },
  }).finally(() => {
    process.env.NODE_ENV = env;
  });
  html = readFileSync(join(out, "index.html"), "utf8");
  for (const f of readdirSync(join(out, "assets")))
    if (f.endsWith(".js")) js.set(`/assets/${f}`, readFileSync(join(out, "assets", f), "utf8"));
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
 * are relative to /assets/.
 */
const imports = (src: string, dynamic: boolean) => {
  const code = js.get(src) as string;
  const re = dynamic
    ? /\bimport\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/g
    : /(?:\bfrom|\bimport)\s*["'`]\.\/([^"'`]+\.js)["'`]/g;
  return [...code.matchAll(re)].map((m) => `/assets/${m[1] as string}`);
};

/** Every chunk reachable from the entries, following static imports and, if asked, dynamic. */
const reach = (dynamic: boolean) => {
  const seen = new Set<string>();
  const next = entries();
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
  expect(gzip).toBeLessThan(FIRST_LOAD_GZIP + FIRST_LOAD_SLACK);
});

test("A2UI and its zod 3 come only by import(), and nothing so loaded has zod 4", () => {
  const late = later();
  expect(late.some((src) => js.get(src)?.includes("a2ui-basic"))).toBe(true);
  expect(late.some((src) => js.get(src)?.includes(ZOD3))).toBe(true);
  // A2uiCard and what it imports must not pull @tars/protocol's zod 4 in (m4_design_a2ui.md 6.2),
  // whether into its own chunk or a shared one only it loads.
  for (const src of late) expect(js.get(src), src).not.toContain(ZOD4);
  console.log(
    `later: ${late.map((src) => `${src} = ${gzipSync(js.get(src) as string).length}`).join(", ")} bytes gzip`,
  );
});
