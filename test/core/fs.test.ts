import { expect, test } from "bun:test";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureSymlink, writeFileAtomic } from "../../src/core/fs.ts";
import { tempHome } from "../helpers.ts";

test("concurrent atomic writes and symlink swaps of one path all succeed and leave no temp files", async () => {
  const dir = tempHome();
  const file = join(dir, "settings.json");
  const link = join(dir, "skills");
  await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      Promise.all([writeFileAtomic(file, `v${i}`), ensureSymlink(`target-${i % 2}`, link)]),
    ),
  );
  expect(readFileSync(file, "utf8")).toMatch(/^v\d+$/);
  expect(readlinkSync(link)).toMatch(/^target-[01]$/);
  expect(readdirSync(dir).toSorted()).toEqual(["settings.json", "skills"]);
});
