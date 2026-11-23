import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  test("without a shipped list, every old dir counts as shipped, so a skill removed from the binary disappears", async () => {
    const { deps, paths, seedArgs } = setup();
    mkdirSync(join(paths.skills, "removed"), { recursive: true });
    writeFileSync(join(paths.skills, "removed/SKILL.md"), "old");
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    expect(readdirSync(paths.skills).sort()).toEqual(["alpha", "beta", "shipped.json"]);
    expect(readdirSync(paths.data).sort()).toEqual([
      "MEMORY.md",
      "SOUL.md",
      "env",
      "harness",
      "skills",
      "workspace",
    ]);
  });

  test("writes the shipped list next to the skills and keeps a shipped top-level file", async () => {
    const { deps, paths, seedArgs } = setup([
      ...fixture,
      { path: "upstream.json", bytes: bytes("{}") },
    ]);
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(paths.skills, "shipped.json"), "utf8"))).toEqual([
      "alpha",
      "beta",
    ]);
    expect(readFileSync(join(paths.skills, "upstream.json"), "utf8")).toBe("{}");
  });

  test("keeps a skill the user added, byte for byte, and drops a shipped skill no longer shipped", async () => {
    const { deps, paths, seedArgs } = setup([
      ...fixture,
      { path: "gamma/SKILL.md", bytes: bytes("g") },
    ]);
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    mkdirSync(join(paths.skills, "mine/reference"), { recursive: true });
    writeFileSync(join(paths.skills, "mine/SKILL.md"), "my skill");
    writeFileSync(join(paths.skills, "mine/reference/a.bin"), new Uint8Array([0, 255, 10]));

    const next = testDeps({ env: { HOME: paths.home }, embedded: async () => fixture });
    expect(await run(["install"], next)).toBe(0);
    expect(readdirSync(paths.skills).sort()).toEqual(["alpha", "beta", "mine", "shipped.json"]);
    expect(readFileSync(join(paths.skills, "mine/SKILL.md"), "utf8")).toBe("my skill");
    expect([...readFileSync(join(paths.skills, "mine/reference/a.bin"))]).toEqual([0, 255, 10]);
    expect(next.io.stderr.join("\n")).not.toContain("skills/");
  });

  test("copies a link inside a user skill as a link, not the file it points to", async () => {
    const { home, deps, paths, seedArgs } = setup();
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    writeFileSync(join(home, "outside.txt"), "outside");
    mkdirSync(join(paths.skills, "mine"));
    symlinkSync(join(home, "outside.txt"), join(paths.skills, "mine/abs"));
    symlinkSync("SKILL.md", join(paths.skills, "mine/rel"));
    writeFileSync(join(paths.skills, "mine/SKILL.md"), "my skill");

    expect(await run(["install"], deps)).toBe(0);
    expect(lstatSync(join(paths.skills, "mine/abs")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(paths.skills, "mine/abs"))).toBe(join(home, "outside.txt"));
    expect(readlinkSync(join(paths.skills, "mine/rel"))).toBe("SKILL.md");
  });

  test("a user skill sharing a shipped name loses to the shipped one, with a warning naming it", async () => {
    const { deps, paths, seedArgs } = setup([{ path: "alpha/SKILL.md", bytes: bytes("alpha v2") }]);
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    mkdirSync(join(paths.skills, "beta"));
    writeFileSync(join(paths.skills, "beta/SKILL.md"), "user beta");

    const next = testDeps({ env: { HOME: paths.home }, embedded: async () => fixture });
    expect(await run(["install"], next)).toBe(0);
    expect(readdirSync(join(paths.skills, "beta"))).toEqual(["LICENSE"]);
    expect(next.io.stderr.join("\n")).toContain("skills/beta");
  });

  test("a failed copy of a user skill leaves the old skills dir as it was and no temp dir", async () => {
    const { deps, paths, seedArgs } = setup();
    expect(await run(["install", ...seedArgs], deps)).toBe(0);
    mkdirSync(join(paths.skills, "mine"));
    writeFileSync(join(paths.skills, "mine/SKILL.md"), "my skill");
    chmodSync(join(paths.skills, "mine/SKILL.md"), 0o000);
    const before = readdirSync(paths.skills).sort();
    const dataBefore = readdirSync(paths.data).sort();

    try {
      expect(await run(["install"], deps)).toBe(1);
    } finally {
      chmodSync(join(paths.skills, "mine/SKILL.md"), 0o644);
    }
    expect(deps.io.stderr.join("\n")).toContain("cannot keep skills/mine");
    expect(readdirSync(paths.skills).sort()).toEqual(before);
    expect(readFileSync(join(paths.skills, "mine/SKILL.md"), "utf8")).toBe("my skill");
    expect(readdirSync(paths.data).sort()).toEqual(dataBefore);
  });

  test("concurrent installs never leave the data dir without skills, a mixed seed, or temp files", async () => {
    const { home, paths, seedArgs } = setup();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(
          ["install", ...seedArgs],
          testDeps({ env: { HOME: home }, embedded: async () => fixture }),
        ),
      ),
    );
    expect(results).toContain(0);
    expect(results.every((code) => code === 0 || code === 1)).toBe(true);
    expect(readFileSync(join(paths.skills, "alpha/SKILL.md"), "utf8")).toBe("alpha v2");
    expect(readFileSync(paths.memory, "utf8")).toBe("memories");
    expect(readdirSync(paths.data).sort()).toEqual([
      "MEMORY.md",
      "SOUL.md",
      "env",
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
