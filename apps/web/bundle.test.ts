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

/** The scripts index.html loads or preloads: what a first visit fetches before any import(). */
const firstLoad = () =>
  [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((src) => js.has(src));

test("a first visit loads no zod 3 and about as much JS as before A2UI", () => {
  const first = firstLoad();
  expect(first.length).toBeGreaterThan(0);
  for (const src of first) expect(js.get(src)).not.toContain(ZOD3);
  const gzip = first.reduce((n, src) => n + gzipSync(js.get(src) as string).length, 0);
  console.log(`first load: ${first.join(", ")} = ${gzip} bytes gzip`);
  expect(gzip).toBeLessThan(FIRST_LOAD_GZIP + FIRST_LOAD_SLACK);
});

test("A2UI comes in a chunk of its own, loaded later, with zod 3 and no zod 4", () => {
  const first = new Set(firstLoad());
  const a2ui = [...js].filter(([, code]) => code.includes("a2ui-basic"));
  expect(a2ui.length).toBe(1);
  const [src, code] = a2ui[0] as [string, string];
  expect(first.has(src)).toBe(false);
  expect(code).toContain(ZOD3);
  // A2uiCard and what it imports must not pull @tars/protocol's zod 4 in (m4_design_a2ui.md 6.2).
  expect(code).not.toContain(ZOD4);
  console.log(`a2ui chunk: ${src} = ${gzipSync(code).length} bytes gzip`);
});
