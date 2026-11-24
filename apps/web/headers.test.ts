// @vitest-environment node
import { expect, test } from "vite-plus/test";
import { assetsInlineLimit, headersFile, headersPlugin } from "./headers.ts";

test("connect-src has 'self' and wss:// with the host given", () => {
  const file = headersFile("app.example.test");
  expect(file.startsWith("/*\n")).toBe(true);
  expect(file).toContain("connect-src 'self' wss://app.example.test;");
  expect(file).toContain("default-src 'none'");
  expect(file).toContain("script-src 'self'");
  expect(file).toContain("frame-ancestors 'none'");
});

test("manifest-src 'self' for the PWA manifest; nothing inline is allowed", () => {
  const file = headersFile("app.example.test");
  expect(file).toContain("manifest-src 'self'");
  expect(file).not.toContain("unsafe-inline");
});

test("font-src 'self' for the served fonts, and no other host or wildcard", () => {
  // The policy alone: the file's first line is the path pattern /*.
  const csp = /Content-Security-Policy: (.+)/.exec(headersFile("app.example.test"))?.[1] ?? "";
  expect(csp.split("; ")).toContain("font-src 'self'");
  expect(csp.split("; ")).toContain("default-src 'none'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("https://");
  expect(csp).not.toContain("*");
  expect(csp).not.toMatch(/font-src[^;]*data:/);
});

test("a font is never inlined; other assets keep Vite's limit", () => {
  expect(assetsInlineLimit("/x/noto-sans-tc-101-wght-normal.woff2")).toBe(false);
  expect(assetsInlineLimit("/x/tars-sprite-idle.svg")).toBeUndefined();
});

test.each([
  undefined,
  "",
  "<APP_HOST>",
  "https://app.example.test",
  "app.example.test/x",
  "app.example.test:8443",
])("APP_HOST %j: no file, the build fails", (host) => {
  expect(() => headersFile(host)).toThrow("APP_HOST");
});

test("the plugin emits _headers for the client build only", () => {
  const plugin = headersPlugin("app.example.test");
  const emitted: { fileName: string; source: string }[] = [];
  const hook = plugin.generateBundle as (this: unknown) => void;
  hook.call({ emitFile: (f: { fileName: string; source: string }) => emitted.push(f) });
  expect(emitted).toEqual([
    { type: "asset", fileName: "_headers", source: headersFile("app.example.test") },
  ]);
  const apply = plugin.applyToEnvironment as (env: { name: string }) => boolean;
  expect(apply({ name: "client" })).toBe(true);
  expect(apply({ name: "tars_web" })).toBe(false);
  expect(plugin.apply).toBe("build");
  const missing = headersPlugin(undefined).generateBundle as (this: unknown) => void;
  expect(() => missing.call({ emitFile: () => undefined })).toThrow("APP_HOST");
});
