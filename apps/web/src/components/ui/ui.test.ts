// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

/** The CSP allows no inline style: neither the copied components nor AccountSelect set one. */
test("the shadcn components and AccountSelect pass no style prop", () => {
  const dir = import.meta.dirname;
  const files = [
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => join(dir, f)),
    join(dir, "..", "AccountSelect.tsx"),
  ];
  expect(files.length).toBeGreaterThan(4);
  for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bstyle\s*=/);
});
