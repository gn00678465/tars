import { expect, test } from "bun:test";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { harnessEntries } from "../../../src/features/session/harness/registry.ts";
import { installedHome } from "./fixture.ts";

/** Every entry under dir: type plus file content or link target. */
function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      const rel = `${prefix}${name}`;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return [`${rel} -> ${readlinkSync(path)}`];
      if (st.isDirectory()) return [`${rel}/`, ...tree(path, `${rel}/`)];
      return [`${rel} = ${readFileSync(path, "utf8")}`];
    });
}

test("prepare converges: rerunning, even after tampering, yields the same tree", async () => {
  const { paths, home } = await installedHome();
  const before = tree(paths.harness);

  for (const [, adapter] of harnessEntries) await adapter.prepare(paths);
  expect(tree(paths.harness)).toEqual(before);

  const claudeSkills = join(paths.harness, "claude/plugin/skills");
  rmSync(claudeSkills);
  symlinkSync(home, claudeSkills);
  writeFileSync(join(paths.harness, "claude/plugin/.claude-plugin/plugin.json"), "{}");
  rmSync(join(paths.harness, "agy-home/.gemini/GEMINI.md"));
  for (const [, adapter] of harnessEntries) await adapter.prepare(paths);
  expect(tree(paths.harness)).toEqual(before);
});

test("the skills symlinks resolve to the data dir's skills", async () => {
  const { paths } = await installedHome();
  const skills = realpathSync(paths.skills);
  expect(readlinkSync(join(paths.harness, "claude/plugin/skills"))).toBe("../../../skills");
  expect(realpathSync(join(paths.harness, "claude/plugin/skills"))).toBe(skills);
  expect(readlinkSync(join(paths.harness, "agy-home/.gemini/config/skills"))).toBe(paths.skills);
  expect(
    readFileSync(join(paths.harness, "agy-home/.gemini/config/skills/alpha/SKILL.md"), "utf8"),
  ).toBe("alpha");
});
