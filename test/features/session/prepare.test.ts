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

  const claudeSkills = join(paths.harness, "claude/skills");
  rmSync(claudeSkills);
  symlinkSync(home, claudeSkills);
  writeFileSync(join(paths.harness, "claude/settings.json"), "{}");
  rmSync(join(paths.harness, "agy-home/.gemini/GEMINI.md"));
  for (const [, adapter] of harnessEntries) await adapter.prepare(paths);
  expect(tree(paths.harness)).toEqual(before);
});

test("the skills symlinks resolve to the data dir's skills, and settings.json excludes the user's CLAUDE.md files", async () => {
  const { paths } = await installedHome();
  const skills = realpathSync(paths.skills);
  expect(readlinkSync(join(paths.harness, "claude/skills"))).toBe("../../skills");
  expect(realpathSync(join(paths.harness, "claude/skills"))).toBe(skills);
  expect(readlinkSync(join(paths.harness, "agy-home/.gemini/config/skills"))).toBe(paths.skills);
  expect(
    readFileSync(join(paths.harness, "agy-home/.gemini/config/skills/alpha/SKILL.md"), "utf8"),
  ).toBe("alpha");
  expect(lstatSync(join(paths.harness, "anthropic")).isDirectory()).toBe(true);
  expect(JSON.parse(readFileSync(join(paths.harness, "claude/settings.json"), "utf8"))).toEqual({
    claudeMdExcludes: [
      `${paths.home}/.claude/CLAUDE.md`,
      `${paths.home}/.claude/rules/**`,
      `${paths.home}/CLAUDE.md`,
      `${paths.home}/CLAUDE.local.md`,
    ],
  });
});

test("seeds .claude.json so interactive claude skips its first-run login, and never touches an existing one", async () => {
  const { paths } = await installedHome();
  const state = join(paths.harness, "claude/.claude.json");
  expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({ hasCompletedOnboarding: true });

  const written =
    '{"hasCompletedOnboarding":true,"projects":{"/w":{"hasTrustDialogAccepted":true}}}';
  writeFileSync(state, written);
  for (const [, adapter] of harnessEntries) await adapter.prepare(paths);
  expect(readFileSync(state, "utf8")).toBe(written);

  rmSync(state);
  for (const [, adapter] of harnessEntries) await adapter.prepare(paths);
  expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({ hasCompletedOnboarding: true });
});
