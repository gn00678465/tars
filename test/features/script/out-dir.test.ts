import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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

  test("the workspace's .evidence/<name> is allowed, though it is a dot directory", async () => {
    const r = rules();
    expect(await prepareOutDir(".evidence/trip-check", r)).toBe(
      join(r.data, "workspace/.evidence/trip-check"),
    );
  });

  test("a directory under the launch dir is allowed", async () => {
    const r = rules();
    expect(await prepareOutDir(join(r.launchDir, "dl"), r)).toBe(join(r.launchDir, "dl"));
  });

  test.each([".git/hooks", ".vscode", "out/.git", ".evidence/x"])(
    "a dot directory below the launch dir, <launch>/%s, is refused",
    async (path) => {
      const r = rules();
      await expect(prepareOutDir(join(r.launchDir, path), r)).rejects.toThrow("--out");
      expect(existsSync(join(r.launchDir, path))).toBe(false);
    },
  );

  test.each([
    ["the launch dir", (r: OutDirRules) => r.launchDir],
    ["the workspace's out/", (r: OutDirRules) => join(r.data, "workspace/out")],
    ["the workspace's .evidence/", (r: OutDirRules) => join(r.data, "workspace/.evidence")],
  ])("%s itself is refused: a script gets a subdirectory", async (_, path) => {
    const r = rules();
    await expect(prepareOutDir(path(r), r)).rejects.toThrow("must be a subdirectory");
  });

  test("<launch>/out/files is allowed", async () => {
    const r = rules();
    const out = join(r.launchDir, "out/files");
    expect(await prepareOutDir(out, r)).toBe(out);
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

  test.each([".gnupg/x", ".local/share/applications/x"])(
    "launched from the home, ~/%s is refused",
    async (path) => {
      const r = rules();
      const launchedAtHome = { ...r, launchDir: r.realHome };
      await expect(prepareOutDir(join(r.realHome, path), launchedAtHome)).rejects.toThrow(
        "overlaps",
      );
      expect(existsSync(join(r.realHome, path))).toBe(false);
    },
  );

  test("launched from the home, ~/Downloads/x and the workspace's out/ are allowed", async () => {
    const r = rules();
    const launchedAtHome = { ...r, launchDir: r.realHome };
    expect(await prepareOutDir(join(r.realHome, "Downloads/x"), launchedAtHome)).toBe(
      join(r.realHome, "Downloads/x"),
    );
    const out = join(r.data, "workspace/out/files");
    expect(await prepareOutDir(out, launchedAtHome)).toBe(out);
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

  test.each([".ssh", ".config", ".local/share/tars"])(
    "launched from the home, a symlink into ~/%s is refused",
    async (target) => {
      const r = rules();
      mkdirSync(join(r.realHome, target), { recursive: true });
      symlinkSync(join(r.realHome, target), join(r.realHome, "link"));
      const launchedAtHome = { ...r, launchDir: r.realHome };
      await expect(prepareOutDir(join(r.realHome, "link/x"), launchedAtHome)).rejects.toThrow(
        "overlaps",
      );
      expect(existsSync(join(r.realHome, target, "x"))).toBe(false);
    },
  );

  test("a symlink under the launch dir that points into the data dir is refused", async () => {
    const r = rules();
    symlinkSync(r.data, join(r.launchDir, "sneaky"));
    await expect(prepareOutDir(join(r.launchDir, "sneaky/scripts"), r)).rejects.toThrow("--out");
    expect(existsSync(join(r.data, "scripts"))).toBe(false);
  });
});

describe("prepareOutDir with outRootOnly (tars chat's child)", () => {
  const only = () => ({ ...rules(), outRootOnly: true });

  test("a subdirectory of the workspace's out/ is allowed", async () => {
    const r = only();
    expect(await prepareOutDir("out/files", r)).toBe(join(r.data, "workspace/out/files"));
  });

  test.each([
    ["the workspace's .evidence/<name>", (r: OutDirRules) => join(r.data, "workspace/.evidence/x")],
    ["the launch dir", (r: OutDirRules) => join(r.launchDir, "dl")],
    ["a dot directory under out/", (r: OutDirRules) => join(r.data, "workspace/out/.x/y")],
  ])("%s is refused and not created", async (_, path) => {
    const r = only();
    await expect(prepareOutDir(path(r), r)).rejects.toThrow("--out");
    expect(existsSync(path(r))).toBe(false);
  });

  test("a symlink under out/ swapped to point at .evidence is refused", async () => {
    const r = only();
    const evidence = join(r.data, "workspace/.evidence/trip");
    mkdirSync(evidence, { recursive: true });
    mkdirSync(join(r.data, "workspace/out"), { recursive: true });
    symlinkSync(evidence, join(r.data, "workspace/out/files"));
    await expect(prepareOutDir("out/files", r)).rejects.toThrow(
      `must be under ${join(r.data, "workspace/out")}`,
    );
  });
  test("a workspace that is a link elsewhere is refused before anything is created", async () => {
    const r = only();
    const elsewhere = join(r.home, "elsewhere");
    mkdirSync(join(elsewhere, "out"), { recursive: true });
    rmSync(join(r.data, "workspace"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(r.data, "workspace"));
    await expect(prepareOutDir(join(r.data, "workspace/out/x"), r)).rejects.toThrow("not a link");
    expect(existsSync(join(elsewhere, "out/x"))).toBe(false);
    expect(existsSync(join(elsewhere, ".evidence"))).toBe(false);
  });

  test("an approved path that now resolves somewhere else is refused and not created", async () => {
    // Approved as out/a/x; out/a was then made a link to out/b.
    const r = only();
    mkdirSync(join(r.data, "workspace/out/b"), { recursive: true });
    symlinkSync(join(r.data, "workspace/out/b"), join(r.data, "workspace/out/a"));
    await expect(prepareOutDir(join(r.data, "workspace/out/a/x"), r)).rejects.toThrow(
      "not the approved path",
    );
    expect(existsSync(join(r.data, "workspace/out/b/x"))).toBe(false);
  });

  test("out/ itself swapped for a link to .evidence is refused", async () => {
    const r = only();
    const evidence = join(r.data, "workspace/.evidence");
    mkdirSync(join(evidence, "trip"), { recursive: true });
    symlinkSync(evidence, join(r.data, "workspace/out"));
    await expect(prepareOutDir("out/trip/x", r)).rejects.toThrow("not a link");
    expect(existsSync(join(evidence, "trip/x"))).toBe(false);
  });
});
