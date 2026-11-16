import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { prepareOutDir, type OutDirRules } from "../../../src/features/script/out-dir.ts";
import { tempHome } from "../../helpers.ts";

function rules(): OutDirRules & { home: string } {
  const home = tempHome();
  const data = join(home, ".local/share/tars");
  mkdirSync(join(data, "workspace"), { recursive: true });
  mkdirSync(join(home, "projects/app"), { recursive: true });
  return {
    home,
    cwd: join(data, "workspace"),
    launchDir: join(home, "projects/app"),
    realHome: home,
    data,
    bins: [join(home, ".local/bin")],
  };
}

describe("prepareOutDir", () => {
  test("a relative path lands under the workspace's out/ and is created", async () => {
    const r = rules();
    const dir = await prepareOutDir("out/files", r);
    expect(dir).toBe(join(r.data, "workspace/out/files"));
    expect(existsSync(dir)).toBe(true);
  });

  test("a directory under the launch dir is allowed", async () => {
    const r = rules();
    expect(await prepareOutDir(join(r.launchDir, "dl"), r)).toBe(join(r.launchDir, "dl"));
  });

  test.each([
    ["the home itself", (r: OutDirRules) => r.realHome],
    ["the data dir", (r: OutDirRules) => r.data],
    ["elsewhere in the workspace", (r: OutDirRules) => join(r.data, "workspace/drafts")],
    ["the bin dir", (r: OutDirRules) => join(r.realHome, ".local/bin")],
    ["/etc", () => "/etc/tars"],
  ])("%s is refused", async (_, path) => {
    const r = rules();
    await expect(prepareOutDir(path(r), r)).rejects.toThrow("--out");
  });

  test("a launch dir that contains ~/.ssh cannot hand it out", async () => {
    const r = { ...rules() };
    const launchedAtHome = { ...r, launchDir: r.realHome };
    await expect(prepareOutDir(r.realHome, launchedAtHome)).rejects.toThrow("overlaps");
    await expect(prepareOutDir(join(r.realHome, ".ssh/x"), launchedAtHome)).rejects.toThrow(
      "overlaps",
    );
    expect(await prepareOutDir(join(r.realHome, "Downloads"), launchedAtHome)).toBe(
      join(r.realHome, "Downloads"),
    );
  });

  test("a symlink under the launch dir that points into the data dir is refused", async () => {
    const r = rules();
    symlinkSync(r.data, join(r.launchDir, "sneaky"));
    await expect(prepareOutDir(join(r.launchDir, "sneaky/scripts"), r)).rejects.toThrow("--out");
    expect(existsSync(join(r.data, "scripts"))).toBe(false);
  });
});
