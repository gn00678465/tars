// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

/**
 * The CSP allows no inline style: neither the copied components nor the files that wrap them
 * (AccountSelect, and M4-P2's overlays) set one.
 */
test("the shadcn components and the files using them pass no style prop", () => {
  const dir = import.meta.dirname;
  const files = [
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => join(dir, f)),
    ...[
      "AccountSelect.tsx",
      "Panel.tsx",
      "StatusBar.tsx",
      "ContextSheet.tsx",
      "ModelSheet.tsx",
      "RunSetup.tsx",
      "ConversationList.tsx",
      "wiki/SourceOverlay.tsx",
    ].map((f) => join(dir, "..", f)),
  ];
  expect(files.length).toBeGreaterThan(18);
  for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bstyle\s*=/);
});
