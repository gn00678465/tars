import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Host } from "./sandbox.ts";

/** Strings planted in fixtures; each one appearing in, or missing from, a captured request is a finding. */
export const SENTINEL = {
  soul: "E2E_SENTINEL_SOUL",
  memory: "E2E_SENTINEL_MEMORY",
  userClaudeMd: "E2E_LEAK_USER_CLAUDE_MD",
  userClaudeRule: "E2E_LEAK_USER_CLAUDE_RULE",
  homeClaudeMd: "E2E_LEAK_HOME_CLAUDE_MD",
  homeClaudeLocal: "E2E_LEAK_HOME_CLAUDE_LOCAL_MD",
  userClaudeSkill: "E2E_LEAK_USER_CLAUDE_SKILL",
  userGeminiMd: "E2E_LEAK_USER_GEMINI_MD",
  userGeminiSkill: "E2E_LEAK_USER_GEMINI_SKILL",
  projectClaudeSkill: "E2E_PROJECT_CLAUDE_SKILL",
  projectAgentsMd: "E2E_PROJECT_AGENTS_MD",
  projectAgentsSkill: "E2E_PROJECT_AGENTS_SKILL",
} as const;

/** The user's global config that a tars session must not load, keyed by where it was planted. */
export const CLAUDE_LEAKS = {
  "~/.claude/CLAUDE.md": SENTINEL.userClaudeMd,
  "~/.claude/rules/x.md": SENTINEL.userClaudeRule,
  "~/CLAUDE.md": SENTINEL.homeClaudeMd,
  "~/CLAUDE.local.md": SENTINEL.homeClaudeLocal,
  "~/.claude/skills": SENTINEL.userClaudeSkill,
} as const;

export const GEMINI_LEAKS = {
  "~/.gemini/GEMINI.md": SENTINEL.userGeminiMd,
  "~/.gemini/config/skills": SENTINEL.userGeminiSkill,
} as const;

/** Files a user hook or MCP server touches when the harness starts it. */
export const SIDE_EFFECTS = {
  claudeHook: "claude-hook",
  claudeMcp: "claude-mcp",
  geminiHook: "gemini-hook",
  geminiMcp: "gemini-mcp",
} as const;

/** Where the suite's paths live, as seen inside the sandbox. */
export interface Layout {
  readonly soulFixture: string;
  readonly memoryFixture: string;
  readonly launchDir: string;
  /** An empty dir under $HOME, where the control runs start. */
  readonly scratchDir: string;
  readonly dataDir: string;
  readonly workspace: string;
  readonly side: string;
  readonly logs: string;
}

export const layout = (host: Host): Layout => ({
  soulFixture: join(host.work, "fixtures", "SOUL.md"),
  memoryFixture: join(host.work, "fixtures", "MEMORY.md"),
  launchDir: join(host.home, "code", "repo"),
  scratchDir: join(host.home, "scratch"),
  dataDir: join(host.home, ".local", "share", "tars"),
  workspace: join(host.home, ".local", "share", "tars", "workspace"),
  side: join(host.work, "side"),
  logs: join(host.work, "logs"),
});

/** Host path of a path inside the sandbox's $HOME. */
export const onHost = (host: Host, path: string) =>
  path.startsWith(`${host.home}/`) ? join(host.fakeHome, path.slice(host.home.length)) : path;

export const SOUL = `# SOUL\n\n${SENTINEL.soul}\n你是 tars。\n`;
export const MEMORY = `# 記憶\n\n## 偏好\n\n${SENTINEL.memory}\n\n## 決定\n`;

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skill(dir: string, name: string, sentinel: string) {
  put(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Probe skill ${sentinel}. Use only for probes.\n---\nBody of ${name}.\n`,
  );
}

export function writeFixtures(host: Host): void {
  const at = (path: string) => onHost(host, path);
  const home = (rel: string) => join(host.fakeHome, rel);
  const l = layout(host);
  const touch = (name: string) => `touch ${join(l.side, name)}`;

  put(l.soulFixture, SOUL);
  put(l.memoryFixture, MEMORY);
  mkdirSync(l.side, { recursive: true });
  mkdirSync(l.logs, { recursive: true });
  put(home(".tars-e2e-fake-home"), "fake\n");
  mkdirSync(at(l.scratchDir), { recursive: true });

  put(home(".claude/CLAUDE.md"), `${SENTINEL.userClaudeMd}\n`);
  put(home(".claude/rules/x.md"), `${SENTINEL.userClaudeRule}\n`);
  put(home("CLAUDE.md"), `${SENTINEL.homeClaudeMd}\n`);
  put(home("CLAUDE.local.md"), `${SENTINEL.homeClaudeLocal}\n`);
  skill(home(".claude/skills"), "u-claude-skill", SENTINEL.userClaudeSkill);
  put(
    home(".claude/settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: touch(SIDE_EFFECTS.claudeHook) }] }],
      },
    }),
  );
  put(
    home(".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: {
        "u-mcp": {
          type: "stdio",
          command: "/bin/sh",
          args: ["-c", touch(SIDE_EFFECTS.claudeMcp)],
        },
      },
    }),
  );

  put(home(".gemini/GEMINI.md"), `${SENTINEL.userGeminiMd}\n`);
  skill(home(".gemini/config/skills"), "u-gemini-skill", SENTINEL.userGeminiSkill);
  put(
    home(".gemini/config/hooks.json"),
    JSON.stringify({
      "u-hook": { SessionStart: [{ type: "command", command: touch(SIDE_EFFECTS.geminiHook) }] },
    }),
  );
  put(
    home(".gemini/config/mcp_config.json"),
    JSON.stringify({
      mcpServers: {
        "u-mcp": { command: "/bin/sh", args: ["-c", touch(SIDE_EFFECTS.geminiMcp)] },
      },
    }),
  );

  const repo = at(l.launchDir);
  put(join(repo, "AGENTS.md"), `${SENTINEL.projectAgentsMd}\n`);
  skill(join(repo, ".claude", "skills"), "p-claude-skill", SENTINEL.projectClaudeSkill);
  skill(join(repo, ".agents", "skills"), "p-agents-skill", SENTINEL.projectAgentsSkill);
}

/** The user's global harness config, as path -> content hash or link target. */
export function snapshotUserConfig(host: Host): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (path: string) => {
    if (!existsSync(path) && !isLink(path)) return;
    const stat = lstatSync(path);
    const rel = path.slice(host.fakeHome.length);
    if (stat.isSymbolicLink()) entries.set(rel, `-> ${readlinkSync(path)}`);
    else if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    else entries.set(rel, createHash("sha256").update(readFileSync(path)).digest("hex"));
  };
  for (const rel of [
    ".claude",
    ".claude.json",
    ".gemini",
    ".config",
    ".agents",
    "CLAUDE.md",
    "CLAUDE.local.md",
  ]) {
    walk(join(host.fakeHome, rel));
  }
  return entries;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, value] of after) {
    if (!before.has(path)) changes.push(`added ${path}`);
    else if (before.get(path) !== value) changes.push(`changed ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`removed ${path}`);
  return changes;
}
