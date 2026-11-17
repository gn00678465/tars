import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { TarsError } from "../../../core/exit.ts";
import { ensureSymlink, writeFileAtomic } from "../../../core/fs.ts";
import type { TarsPaths } from "../../../core/paths.ts";
import type { BootContext } from "../boot.ts";
import type { HarnessAdapter } from "./types.ts";

// Linux MAX_ARG_STRLEN caps a single argv string at 32 pages.
const MAX_ARG_BYTES = 128 * 1024;

function pluginDir(paths: TarsPaths): string {
  return join(paths.harness, "claude", "plugin");
}

// Claude Code runs on the user's own config dir and login, so Remote Control and every login
// renewal work as in the user's own claude (r55). Isolation comes from flags instead of a config
// dir: --setting-sources skips the user's settings, hooks and skills; --strict-mcp-config with an
// empty --mcp-config skips user- and local-scope MCP servers; claudeMdExcludes stops the upward
// search from the workspace, which sits under $HOME, at ~/.claude/CLAUDE.md and its neighbours.
function isolation(paths: TarsPaths): string[] {
  const claudeMdExcludes = [
    join(paths.home, ".claude", "CLAUDE.md"),
    join(paths.home, ".claude", "rules", "**"),
    join(paths.home, "CLAUDE.md"),
    join(paths.home, "CLAUDE.local.md"),
  ];
  return [
    "--setting-sources",
    "project,local",
    "--settings",
    JSON.stringify({ claudeMdExcludes }),
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--plugin-dir",
    pluginDir(paths),
  ];
}

export const claude: HarnessAdapter = {
  description: "start a Claude Code session with tars's persona, memory, and skills",

  async prepare(paths) {
    const plugin = pluginDir(paths);
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await writeFileAtomic(
      join(plugin, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "tars", version: "0.0.1" })}\n`,
    );
    await ensureSymlink(relative(plugin, paths.skills), join(plugin, "skills"));
  },

  plan(ctx) {
    const prompt = composeBootPrompt(ctx.boot);
    if (Buffer.byteLength(prompt) >= MAX_ARG_BYTES) {
      throw new TarsError(
        "SOUL.md and MEMORY.md together exceed the 128 KiB argument limit; shorten MEMORY.md",
      );
    }
    return {
      command: "claude",
      args: [
        "--append-system-prompt",
        prompt,
        "--add-dir",
        ctx.launchDir,
        ...isolation(ctx.paths),
        ...ctx.userArgs,
      ],
      env: ctx.env,
      cwd: ctx.paths.workspace,
    };
  },
};

const BLOCK_TAG = /<(\s*\/?\s*tars-file)/gi;

export function composeBootPrompt(boot: BootContext): string {
  return boot.files
    .map(({ label, sha256, content }) => {
      // Escaping "<" keeps file content from closing its block or opening a forged one.
      const body = content.replace(BLOCK_TAG, "&lt;$1");
      return `<tars-file label="${label}" sha256="${sha256}">\n${body}${body.endsWith("\n") ? "" : "\n"}</tars-file>\n`;
    })
    .join("");
}
