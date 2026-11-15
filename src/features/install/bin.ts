import { appendFile, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { uniqueTemp, writeFileAtomic } from "../../core/fs.ts";
import type { Env, TarsPaths } from "../../core/paths.ts";

/**
 * Linux refuses to write into a running executable (ETXTBSY), and rerunning `tars install` from
 * the installed copy is exactly that. A rename in the same dir swaps the name instead, and running
 * processes keep the old inode.
 */
export async function installExecutable(source: string, bin: string): Promise<string> {
  const target = join(bin, "tars");
  await mkdir(bin, { recursive: true });
  const tmp = uniqueTemp(target);
  try {
    await copyFile(source, tmp);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  return target;
}

/** One file tars writes to put the bin dir on PATH: owned whole, or one line appended. */
type ShellEdit =
  | { readonly kind: "own"; readonly file: string; readonly content: string }
  | { readonly kind: "append"; readonly file: string; readonly line: string };

export type PathPlan =
  | { readonly kind: "on-path" }
  | { readonly kind: "edits"; readonly envFile: string; readonly edits: readonly ShellEdit[] };

/**
 * Follows rustup's rules (src/cli/self_update/shell.rs): an env file that prepends the bin dir
 * once, sourced from every startup file that login, interactive, and non-interactive shells read.
 */
export async function planPath(paths: TarsPaths, env: Env): Promise<PathPlan> {
  if ((env.PATH ?? "").split(":").includes(paths.bin)) return { kind: "on-path" };
  return { kind: "edits", envFile: join(paths.data, "env"), edits: await shellEdits(paths, env) };
}

export async function applyPath(edits: readonly ShellEdit[]): Promise<void> {
  for (const edit of edits) {
    if (edit.kind === "own") await writeOwned(edit.file, edit.content);
    else await appendLine(edit.file, edit.line);
  }
}

async function shellEdits(paths: TarsPaths, env: Env): Promise<ShellEdit[]> {
  const bin = quoted(paths.bin, paths.home);
  const envSh = join(paths.data, "env");
  const envFish = join(paths.data, "env.fish");
  const source: (file: string) => ShellEdit = (file) => ({
    kind: "append",
    file,
    line: `. ${quoted(envSh, paths.home)}`,
  });
  const has = (shell: string) =>
    basename(env.SHELL ?? "") === shell || Bun.which(shell, { PATH: env.PATH ?? "" }) !== null;

  const edits: ShellEdit[] = [
    {
      kind: "own",
      file: envSh,
      content: `#!/bin/sh
# Written by tars install: puts the tars bin dir first on PATH, once.
case ":\${PATH}:" in
    *:${bin}:*) ;;
    *) export PATH=${bin}:"$PATH" ;;
esac
`,
    },
    source(join(paths.home, ".profile")),
  ];
  for (const name of [".bash_profile", ".bash_login", ".bashrc"]) {
    const file = join(paths.home, name);
    if (await exists(file)) edits.push(source(file));
  }
  if (has("zsh")) edits.push(source(await zshenv(paths.home, env.ZDOTDIR)));
  if (has("fish")) {
    const config = env.XDG_CONFIG_HOME;
    const dir = config && isAbsolute(config) ? config : join(paths.home, ".config");
    edits.push(
      {
        kind: "own",
        file: envFish,
        content: `# Written by tars install: puts the tars bin dir first on PATH, once.
if not contains ${bin} $PATH
    set -x PATH ${bin} $PATH
end
`,
      },
      {
        kind: "own",
        file: join(dir, "fish", "conf.d", "tars.fish"),
        content: `source ${quoted(envFish, paths.home)}\n`,
      },
    );
  }
  return edits;
}

/** zsh reads .zshenv for every shell, interactive or not; ZDOTDIR moves it. */
async function zshenv(home: string, zdotdir: string | undefined): Promise<string> {
  const candidates = [zdotdir && isAbsolute(zdotdir) ? zdotdir : undefined, home]
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => join(dir, ".zshenv"));
  for (const file of candidates) if (await exists(file)) return file;
  return candidates[0]!;
}

/** A double-quoted path that sh, bash, zsh, and fish all read the same way, with $HOME kept symbolic. */
function quoted(path: string, home: string): string {
  if (/["$`\\\n]/.test(path)) {
    throw new TarsError(`cannot write ${path} into a shell startup file: it contains " $ \` or \\`);
  }
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `"$HOME/${rel}"` : `"${path}"`;
}

async function writeOwned(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, content);
}

/** Appends, not rewrites, so a concurrent edit by the user is never lost. */
async function appendLine(file: string, line: string): Promise<void> {
  const text = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  if (text.split("\n").includes(line)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    },
  );
}
