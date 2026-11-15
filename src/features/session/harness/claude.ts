import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { TarsError } from "../../../core/exit.ts";
import { ensureSymlink, writeFileAtomic } from "../../../core/fs.ts";
import type { TarsPaths } from "../../../core/paths.ts";
import type { BootContext } from "../boot.ts";
import type { HarnessAdapter } from "./types.ts";

// Linux MAX_ARG_STRLEN caps a single argv string at 32 pages.
const MAX_ARG_BYTES = 128 * 1024;

function dirs(paths: TarsPaths) {
  return { config: join(paths.harness, "claude"), anthropic: join(paths.harness, "anthropic") };
}

export const claude: HarnessAdapter = {
  description: "start a Claude Code session with tars's persona, memory, and skills",
  credential: { secret: "claude-oauth-token", obtain: "claude setup-token" },

  async prepare(paths) {
    const { config, anthropic } = dirs(paths);
    await mkdir(config, { recursive: true });
    await mkdir(anthropic, { recursive: true });
    await ensureSymlink(relative(config, paths.skills), join(config, "skills"));
    // The workspace sits under $HOME, so Claude Code's upward CLAUDE.md search would load these.
    const claudeMdExcludes = [
      join(paths.home, ".claude", "CLAUDE.md"),
      join(paths.home, ".claude", "rules", "**"),
      join(paths.home, "CLAUDE.md"),
      join(paths.home, "CLAUDE.local.md"),
    ];
    await writeFileAtomic(
      join(config, "settings.json"),
      `${JSON.stringify({ claudeMdExcludes }, null, 2)}\n`,
    );
  },

  plan(ctx) {
    if (ctx.credential === undefined) throw new Error("claude plan requires the OAuth token");
    const prompt = composeBootPrompt(ctx.boot);
    if (Buffer.byteLength(prompt) >= MAX_ARG_BYTES) {
      throw new TarsError(
        "SOUL.md and MEMORY.md together exceed the 128 KiB argument limit; shorten MEMORY.md",
      );
    }
    const { config, anthropic } = dirs(ctx.paths);
    return {
      command: "claude",
      args: ["--append-system-prompt", prompt, "--add-dir", ctx.launchDir, ...ctx.userArgs],
      env: {
        ...ctx.env,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_CONFIG_DIR: anthropic,
        CLAUDE_CODE_OAUTH_TOKEN: ctx.credential,
      },
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
