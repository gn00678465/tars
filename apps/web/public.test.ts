// @vitest-environment node
import { expect, test } from "vite-plus/test";
import icon from "./public/apple-touch-icon.png?inline";

// iOS fills a home-screen icon's transparent pixels with white: the icon has no alpha at all.
test("apple-touch-icon.png is 180x180 RGB with no alpha (PNG colour type 2)", () => {
  const png = Uint8Array.from(atob(icon.slice(icon.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  const view = new DataView(png.buffer);
  expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
  expect([view.getUint32(16), view.getUint32(20), png[25]]).toEqual([180, 180, 2]);
});
