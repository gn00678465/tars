import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, type Env } from "../../src/core/paths.ts";
import type { EmbeddedFile } from "../../src/features/install/embedded.ts";
import { run } from "../../src/main.ts";
import { fakeExecutable, tempHome, testDeps } from "../helpers.ts";

const skills: EmbeddedFile[] = [{ path: "a/SKILL.md", bytes: new TextEncoder().encode("a") }];
const SOURCE = '. "$HOME/.local/share/tars/env"';

/** A home with SOUL.md and MEMORY.md already seeded, and a PATH holding only `shells`. */
function setup(env: Env = {}, shells: readonly string[] = []) {
  const home = tempHome();
  const pathDir = join(home, "path");
  mkdirSync(pathDir);
  for (const shell of shells) writeFileSync(join(pathDir, shell), "", { mode: 0o755 });
  const full: Env = { HOME: home, PATH: pathDir, SHELL: "/bin/sh", ...env };
  const paths = resolvePaths(full);
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.soul, "persona");
  writeFileSync(paths.memory, "memories");
  const install = (args: string[] = [], executable = fakeExecutable()) =>
    run(["install", ...args], testDeps({ env: full, executable, embedded: async () => skills }));
  return { home, paths, env: full, install };
}

const read = (path: string) => readFileSync(path, "utf8");
const count = (text: string, line: string) => text.split("\n").filter((l) => l === line).length;

describe("tars install puts tars on PATH", () => {
  test("copies the running executable to ~/.local/bin/tars, keeping it executable", async () => {
    const { home, install } = setup();
    expect(await install([], fakeExecutable("v1"))).toBe(0);
    const target = join(home, ".local/bin/tars");
    expect(read(target)).toContain("v1");
    expect(statSync(target).mode & 0o111).toBe(0o111);
  });

  test("replaces a tars that is running right now", async () => {
    const { home, install } = setup();
    const target = join(home, ".local/bin/tars");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(target, readFileSync("/bin/sleep"), { mode: 0o755 });
    const running = Bun.spawn([target, "5"]);
    try {
      expect(await install([], fakeExecutable("v2"))).toBe(0);
      expect(read(target)).toContain("v2");
      expect(readdirSync(join(home, ".local/bin"))).toEqual(["tars"]);
    } finally {
      running.kill();
    }
  });

  test("uses an absolute XDG_BIN_HOME and ignores a relative one", async () => {
    const bin = join(tempHome(), "mybin");
    const withBin = setup({ XDG_BIN_HOME: bin });
    expect(await withBin.install()).toBe(0);
    expect(existsSync(join(bin, "tars"))).toBe(true);
    const relative = setup({ XDG_BIN_HOME: "mybin" });
    expect(await relative.install()).toBe(0);
    expect(existsSync(join(relative.home, ".local/bin/tars"))).toBe(true);
  });

  test("leaves every startup file alone when the bin dir is already on PATH", async () => {
    const home = tempHome();
    const { install, paths } = setup({ HOME: home, PATH: `/usr/bin:${join(home, ".local/bin")}` });
    expect(await install()).toBe(0);
    expect(existsSync(join(home, ".profile"))).toBe(false);
    expect(existsSync(join(paths.data, "env"))).toBe(false);
  });

  test("--no-modify-path copies tars but writes no startup file", async () => {
    const { home, install } = setup();
    expect(await install(["--no-modify-path"])).toBe(0);
    expect(existsSync(join(home, ".local/bin/tars"))).toBe(true);
    expect(existsSync(join(home, ".profile"))).toBe(false);
  });

  test("sources the env file from .profile, every existing bash file, and .zshenv, once each", async () => {
    const { home, install } = setup({ SHELL: "/usr/bin/zsh" });
    writeFileSync(join(home, ".bashrc"), "alias ll='ls -l'");
    expect(await install()).toBe(0);
    expect(await install()).toBe(0);
    for (const file of [".profile", ".bashrc", ".zshenv"]) {
      expect(count(read(join(home, file)), SOURCE)).toBe(1);
    }
    expect(read(join(home, ".bashrc"))).toBe(`alias ll='ls -l'\n${SOURCE}\n`);
    expect(existsSync(join(home, ".bash_profile"))).toBe(false);
    expect(existsSync(join(home, ".config/fish"))).toBe(false);
  });

  test("writes .zshenv under ZDOTDIR when zsh is on PATH but is not the login shell", async () => {
    const zdot = join(tempHome(), "zdot");
    const { home, install } = setup({ ZDOTDIR: zdot }, ["zsh"]);
    expect(await install()).toBe(0);
    expect(count(read(join(zdot, ".zshenv")), SOURCE)).toBe(1);
    expect(existsSync(join(home, ".zshenv"))).toBe(false);
  });

  const zsh = Bun.which("zsh");
  for (const [where, zshenv, exported] of [
    ["exported by the parent, beside an unrelated $HOME/.zshenv", "setopt no_beep\n", true],
    ["set inside $HOME/.zshenv", 'export ZDOTDIR="$HOME/.config/zsh"\n', false],
  ] as const) {
    test.skipIf(!zsh)(`a new zsh finds tars when ZDOTDIR is ${where}`, async () => {
      const home = tempHome();
      const zdotdir = join(home, ".config/zsh");
      mkdirSync(zdotdir, { recursive: true });
      writeFileSync(join(home, ".zshenv"), zshenv);
      const { install } = setup({ HOME: home, ZDOTDIR: zdotdir, SHELL: "/usr/bin/zsh" });
      expect(await install()).toBe(0);
      const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin" };
      if (exported) env.ZDOTDIR = zdotdir;
      const found = Bun.spawnSync([zsh!, "-c", "command -v tars"], { env });
      expect(found.stdout.toString().trim()).toBe(join(home, ".local/bin/tars"));
    });
  }

  test("adds a source line to fish/conf.d/tars.fish and keeps what is already there", async () => {
    const { home, paths, install } = setup({}, ["fish"]);
    const confd = join(home, ".config/fish/conf.d");
    mkdirSync(confd, { recursive: true });
    writeFileSync(join(confd, "tars.fish"), "set -gx KEEP me\n");
    expect(await install()).toBe(0);
    expect(await install()).toBe(0);
    expect(read(join(confd, "tars.fish"))).toBe(
      'set -gx KEEP me\nsource "$HOME/.local/share/tars/env.fish"\n',
    );
    expect(read(join(paths.data, "env.fish"))).toContain('contains "$HOME/.local/bin" $PATH');
  });

  test("the env file puts the bin dir first on PATH exactly once, however often it is sourced", async () => {
    const { home, paths, install } = setup();
    expect(await install()).toBe(0);
    const sh = Bun.spawnSync(
      ["/bin/sh", "-c", `. "$1"; . "$1"; echo "$PATH"`, "sh", join(paths.data, "env")],
      {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      },
    );
    expect(sh.stdout.toString().trim()).toBe(`${join(home, ".local/bin")}:/usr/bin:/bin`);
  });

  test("refuses a bin dir that a shell would expand, before install writes anything", async () => {
    const bin = join(tempHome(), "$evil");
    const { home, paths, install } = setup({ XDG_BIN_HOME: bin });
    expect(await install()).toBe(1);
    expect(existsSync(bin)).toBe(false);
    expect(readdirSync(paths.data).sort()).toEqual(["MEMORY.md", "SOUL.md"]);
    expect(existsSync(join(home, ".profile"))).toBe(false);
  });
});
