import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  listDir,
  openWikiDir,
  readIn,
  writeIn,
  type WikiDir,
} from "../../../src/features/wiki/wiki-dir.ts";
import { isolatedPaths } from "../agent/db-fixture.ts";

/** <data>/wiki/people opened, then swapped for a symlink to a directory outside the wiki. */
async function swappedAfterOpen() {
  const paths = isolatedPaths();
  const people = join(paths.wiki, "people");
  const outside = join(paths.data, "outside");
  mkdirSync(people, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(people, "a.md"), "inside\n");
  writeFileSync(join(outside, "a.md"), "outside\n");
  const dir = (await openWikiDir(paths, "people")) as WikiDir;
  const moved = join(paths.wiki, "people-moved");
  renameSync(people, moved);
  symlinkSync(outside, people);
  return { paths, dir, moved, outside };
}

describe("a category directory swapped for a symlink after the last check", () => {
  test("a write lands in the directory that was checked, never outside", async () => {
    const { dir, moved, outside } = await swappedAfterOpen();
    await writeIn(dir, "b.md", "new page\n");
    await dir.close();
    expect(readFileSync(join(moved, "b.md"), "utf8")).toBe("new page\n");
    expect(readdirSync(outside)).toEqual(["a.md"]);
    expect(readdirSync(moved).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("listing and reading see the checked directory", async () => {
    const { dir } = await swappedAfterOpen();
    expect((await listDir(dir)).map((e) => e.name)).toEqual(["a.md"]);
    expect(await readIn(dir, "a.md")).toBe("inside\n");
    await dir.close();
  });

  test("opened after the swap, it is unsafe", async () => {
    const { paths, dir } = await swappedAfterOpen();
    await dir.close();
    expect(await openWikiDir(paths, "people")).toBe("unsafe");
    expect(await openWikiDir(paths, "people", true)).toBe("unsafe");
  });
});

describe("files inside", () => {
  test("a page that is a symlink is not read through; a missing one is undefined", async () => {
    const paths = isolatedPaths();
    mkdirSync(join(paths.wiki, "people"), { recursive: true });
    writeFileSync(join(paths.data, "secret.md"), "secret\n");
    symlinkSync(join(paths.data, "secret.md"), join(paths.wiki, "people", "link.md"));
    const dir = (await openWikiDir(paths, "people")) as WikiDir;
    await expect(readIn(dir, "link.md")).rejects.toThrow();
    expect(await readIn(dir, "none.md")).toBeUndefined();
    await dir.close();
  });

  test("<data>/wiki as a symlink is unsafe; missing is missing until created", async () => {
    const paths = isolatedPaths();
    expect(await openWikiDir(paths, "people")).toBe("missing");
    const dir = (await openWikiDir(paths, "people", true)) as WikiDir;
    await dir.close();
    const other = isolatedPaths();
    mkdirSync(other.data, { recursive: true });
    symlinkSync(paths.wiki, other.wiki);
    expect(await openWikiDir(other)).toBe("unsafe");
  });
});
