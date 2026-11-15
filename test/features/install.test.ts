import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../../src/core/paths.ts";
import { skillsFromBundle, type EmbeddedFile } from "../../src/features/install/embedded.ts";
import { run } from "../../src/main.ts";
import { tempHome, testDeps } from "../helpers.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const fixture: EmbeddedFile[] = [
  { path: "alpha/SKILL.md", bytes: bytes("alpha v2") },
  { path: "alpha/reference/notes.md", bytes: bytes("notes") },
  { path: "beta/LICENSE", bytes: bytes("MIT") },
];

function setup(skills: readonly EmbeddedFile[] = fixture) {
  const home = tempHome();
  writeFileSync(join(home, "soul.src"), "persona");
  writeFileSync(join(home, "memory.src"), "memories");
  const deps = testDeps({ env: { HOME: home }, embedded: async () => skills });
  const seedArgs = ["--soul", join(home, "soul.src"), "--memory", join(home, "memory.src")];
  return { home, deps, paths: resolvePaths({ HOME: home }), seedArgs };
}

describe("tars install", () => {
  test("writes the embedded skills, seeds SOUL.md and MEMORY.md, and creates the workspace", async () => {
    const { deps, paths, seedArgs } = setup();
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    expect(readFileSync(join(paths.skills, "alpha/SKILL.md"), "utf8")).toBe("alpha v2");
    expect(readFileSync(join(paths.skills, "alpha/reference/notes.md"), "utf8")).toBe("notes");
    expect(readFileSync(join(paths.skills, "beta/LICENSE"), "utf8")).toBe("MIT");
    expect(readFileSync(paths.soul, "utf8")).toBe("persona");
    expect(readFileSync(paths.memory, "utf8")).toBe("memories");
    expect(existsSync(paths.workspace)).toBe(true);
  });

  test("replaces the whole skills dir, so a skill removed from the binary disappears", async () => {
    const { deps, paths, seedArgs } = setup();
    mkdirSync(join(paths.skills, "removed"), { recursive: true });
    writeFileSync(join(paths.skills, "removed/SKILL.md"), "old");
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    expect(readdirSync(paths.skills).sort()).toEqual(["alpha", "beta"]);
    expect(readdirSync(paths.data).sort()).toEqual([
      "MEMORY.md",
      "SOUL.md",
      "harness",
      "skills",
      "workspace",
    ]);
  });

  test("never overwrites an existing MEMORY.md or SOUL.md", async () => {
    const { deps, paths, seedArgs } = setup();
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    writeFileSync(paths.memory, "learned since install");
    writeFileSync(paths.soul, "edited persona");
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    expect(readFileSync(paths.memory, "utf8")).toBe("learned since install");
    expect(readFileSync(paths.soul, "utf8")).toBe("edited persona");
    expect(deps.io.stdout).toContain("MEMORY.md: kept");
  });

  test("is idempotent without seed flags once seeded", async () => {
    const { deps, seedArgs } = setup();
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    expect(await run(["install"], deps)).toBe(0);
  });

  test("a missing MEMORY.md without --memory exits 1, names the flag, and writes nothing", async () => {
    const { home, deps, paths } = setup();
    expect(await run(["install", "--soul", join(home, "soul.src")], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("--memory");
    expect(existsSync(paths.data)).toBe(false);
  });

  test("fails with exit 1 and writes nothing when the binary has no embedded skills", async () => {
    const { deps, paths, seedArgs } = setup([]);
    expect(await run(["install", ...seedArgs], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("run the built binary");
    expect(existsSync(paths.data)).toBe(false);
  });

  test("running from source fails instead of reading the repo's tars-skills", () => {
    const home = tempHome();
    writeFileSync(join(home, "s"), "x");
    const proc = Bun.spawnSync(
      ["bun", "src/main.ts", "install", "--soul", join(home, "s"), "--memory", join(home, "s")],
      { env: { PATH: process.env.PATH, HOME: home }, stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("run the built binary");
    expect(existsSync(join(home, ".local/share/tars"))).toBe(false);
  });

  test("an unknown option exits 2", async () => {
    expect(await run(["install", "--bogus"], setup().deps)).toBe(2);
  });
});

describe("skillsFromBundle", () => {
  test("keeps only tars-skills files, relative to tars-skills/, and restores extension-less names", async () => {
    const files = await skillsFromBundle([
      new File(["skill"], "tars-skills/alpha/SKILL.md"),
      new File(["MIT"], "tars-skills/alpha/LICENSE."),
      new File(["x"], "other/thing.md"),
    ]);
    expect(files.map((f) => f.path)).toEqual(["alpha/SKILL.md", "alpha/LICENSE"]);
    expect(new TextDecoder().decode(files[1]?.bytes)).toBe("MIT");
  });
});
