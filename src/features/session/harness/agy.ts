import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureSymlink, writeFileAtomic } from "../../../core/fs.ts";
import type { TarsPaths } from "../../../core/paths.ts";
import type { HarnessAdapter } from "./types.ts";

// agy has no config-dir variable, so tars isolates it with a HOME of its own.
const agyHome = (paths: TarsPaths) => join(paths.harness, "agy-home");

export const agy: HarnessAdapter = {
  description:
    "start an agy (Google Antigravity CLI) session with tars's persona, memory, and skills",

  async prepare(paths) {
    const home = agyHome(paths);
    const gemini = join(home, ".gemini");
    await mkdir(join(home, ".config"), { recursive: true });
    await mkdir(join(gemini, "config"), { recursive: true });
    await writeFileAtomic(
      join(gemini, "GEMINI.md"),
      `@[persona](${paths.soul})\n@[memory](${paths.memory})\n`,
    );
    await ensureSymlink(paths.skills, join(gemini, "config", "skills"));
  },

  plan(ctx) {
    const home = agyHome(ctx.paths);
    return {
      command: "agy",
      args: ["--add-dir", ctx.launchDir, ...ctx.userArgs],
      // DBUS_SESSION_BUS_ADDRESS stays inherited: agy reads the user's Google login from the keyring.
      env: { ...ctx.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      cwd: ctx.paths.workspace,
    };
  },
};
