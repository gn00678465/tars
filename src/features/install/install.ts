import type { Command } from "commander";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { createExclusive, uniqueTemp } from "../../core/fs.ts";
import type { Io } from "../../core/io.ts";
import { resolvePaths, type Env, type TarsPaths } from "../../core/paths.ts";
import { harnessEntries } from "../session/harness/registry.ts";
import { applyPath, installExecutable, planPath, type PathPlan } from "./bin.ts";
import type { EmbeddedFile } from "./embedded.ts";

export interface InstallDeps {
  readonly io: Io;
  readonly env: Env;
  /** The running tars binary, copied into the bin dir. */
  readonly executable: string;
  embedded(): Promise<readonly EmbeddedFile[]>;
}

export interface InstallOptions {
  readonly soul?: string;
  readonly memory?: string;
  /** commander turns --no-modify-path into modifyPath: false. */
  readonly modifyPath: boolean;
}

const SEEDS = [
  { key: "soul", label: "SOUL.md", flag: "--soul" },
  { key: "memory", label: "MEMORY.md", flag: "--memory" },
] as const;

export function registerInstall(program: Command, deps: InstallDeps): void {
  program
    .command("install")
    .description(
      "install skills, seed SOUL.md and MEMORY.md, prepare every harness, and put tars on PATH",
    )
    .option("--soul <file>", "copy this file to SOUL.md if SOUL.md does not exist")
    .option("--memory <file>", "copy this file to MEMORY.md if MEMORY.md does not exist")
    .option("--no-modify-path", "copy tars into the bin dir but leave shell startup files alone")
    .addHelpText(
      "after",
      `
Shipped skills are replaced on every run; a skill dir you added to <data>/skills is kept.
SOUL.md and MEMORY.md are never overwritten.

tars is copied to $XDG_BIN_HOME/tars, else ~/.local/bin/tars. When that dir is not on
PATH, install writes <data>/env and sources it from ~/.profile, each existing
~/.bash_profile, ~/.bash_login, ~/.bashrc, and, when zsh or fish is present, from
\${ZDOTDIR:-$HOME}/.zshenv or fish/conf.d/tars.fish. Rerunning adds nothing twice.

Examples:
  dist/tars install --soul ./SOUL.md --memory ./MEMORY.md
  tars install
  tars install --no-modify-path`,
    )
    .action(async (options: InstallOptions) => {
      const paths = resolvePaths(deps.env);
      // Planned first: a bin dir no shell can quote fails before install writes anything.
      const plan = options.modifyPath ? await planPath(paths, deps.env) : undefined;
      await install(paths, await deps.embedded(), options, deps.io);
      await installOnPath(paths, deps, plan);
    });
}

export async function install(
  paths: TarsPaths,
  skills: readonly EmbeddedFile[],
  sources: Omit<InstallOptions, "modifyPath">,
  io: Io,
): Promise<void> {
  if (skills.length === 0) {
    throw new TarsError(
      "this tars has no embedded skills; run the built binary: bun run build && dist/tars install",
    );
  }
  const seeds = await Promise.all(
    SEEDS.map((seed) => readSeed(paths[seed.key], sources[seed.key], seed, io)),
  );

  await mkdir(paths.data, { recursive: true });
  await replaceSkills(paths.skills, skills, io);
  for (const seed of seeds) {
    if (seed.bytes && !(await createExclusive(seed.target, seed.bytes))) {
      throw concurrentInstall(seed.target);
    }
  }
  await mkdir(paths.workspace, { recursive: true });
  for (const [, adapter] of harnessEntries) await adapter.prepare(paths);

  io.out(`data: ${paths.data}`);
  io.out(`skills: ${skills.length} files`);
  for (const seed of seeds) io.out(`${seed.label}: ${seed.bytes ? "created" : "kept"}`);
  io.out(`harnesses: ${harnessEntries.map(([name]) => name).join(", ")}`);
}

async function installOnPath(paths: TarsPaths, deps: InstallDeps, plan: PathPlan | undefined) {
  deps.io.out(`bin: ${await installExecutable(deps.executable, paths.bin)}`);
  if (!plan) return deps.io.out(`path: left alone (--no-modify-path)`);
  if (plan.kind === "on-path") return deps.io.out(`path: ${paths.bin} is already on PATH`);
  await applyPath(plan.edits);
  deps.io.out(`path: ${plan.edits.map((edit) => edit.file).join(", ")}`);
  deps.io.err(`open a new shell, or run: . "${plan.envFile}"`);
}

async function readSeed(
  target: string,
  source: string | undefined,
  { label, flag }: (typeof SEEDS)[number],
  io: Io,
): Promise<{ label: string; target: string; bytes?: Uint8Array }> {
  if (await exists(target)) {
    if (source) io.err(`${label} exists; kept it and ignored ${flag}`);
    return { label, target };
  }
  if (!source)
    throw new TarsError(`${label} does not exist; seed it with: tars install ${flag} <file>`);
  try {
    return { label, target, bytes: await readFile(source) };
  } catch (err) {
    throw new TarsError(
      `cannot read ${flag} ${source}: ${(err as NodeJS.ErrnoException).code ?? err}`,
    );
  }
}

/** Names the top-level dirs the last install wrote, so the next one can tell them from the user's. */
export const SHIPPED_LIST = "shipped.json";

/**
 * Writes files into a sibling temp dir, then swaps it in, so stale skill files never survive.
 * Top-level dirs the user added (absent from the last shipped list) are copied into the temp dir
 * first; a dir that shares a shipped name is replaced by the shipped one.
 */
export async function replaceSkills(
  dir: string,
  files: readonly EmbeddedFile[],
  io: Io,
): Promise<void> {
  const tmp = uniqueTemp(dir);
  const old = uniqueTemp(dir);
  const shipped = [
    ...new Set(files.flatMap((f) => (f.path.includes("/") ? [f.path.split("/")[0]!] : []))),
  ].sort();
  try {
    for (const file of files) {
      const path = join(tmp, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }
    for (const name of await userSkills(dir)) {
      if (shipped.includes(name)) {
        io.err(`skills/${name} is not one tars shipped; replaced it with the shipped ${name}`);
        continue;
      }
      // verbatimSymlinks: a link is copied as a link, never the file outside the skill it points to.
      await cp(join(dir, name), join(tmp, name), { recursive: true, verbatimSymlinks: true }).catch(
        (err: NodeJS.ErrnoException) => {
          throw new TarsError(
            `cannot keep skills/${name}: ${err.code ?? err} at ${err.path ?? join(dir, name)}; skills are unchanged`,
          );
        },
      );
    }
    await writeFile(join(tmp, SHIPPED_LIST), `${JSON.stringify(shipped, null, 2)}\n`);
    // rename() cannot replace a non-empty directory, so the old tree moves aside first.
    await rename(dir, old).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    await rename(tmp, dir).catch((err: NodeJS.ErrnoException) => {
      throw err.code === "ENOTEMPTY" || err.code === "EEXIST" ? concurrentInstall(dir) : err;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
}

/** Top-level dirs the last install did not ship. Without a list, every dir counts as shipped. */
async function userSkills(dir: string): Promise<string[]> {
  const text = await readFile(join(dir, SHIPPED_LIST), "utf8").catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    },
  );
  if (text === undefined) return [];
  let last: unknown;
  try {
    last = JSON.parse(text);
  } catch {}
  if (!Array.isArray(last)) {
    throw new TarsError(
      `${join(dir, SHIPPED_LIST)} is not a JSON array; delete it and run tars install again`,
    );
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !last.includes(e.name)).map((e) => e.name);
}

/** The target appeared between our check and our rename or link: another install got there first. */
function concurrentInstall(path: string): TarsError {
  return new TarsError(
    `another tars install wrote ${path} at the same time; run tars install again`,
  );
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
