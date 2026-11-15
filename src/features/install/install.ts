import type { Command } from "commander";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import type { Io } from "../../core/io.ts";
import { resolvePaths, type Env, type TarsPaths } from "../../core/paths.ts";
import type { EmbeddedFile } from "./embedded.ts";

export interface InstallDeps {
  readonly io: Io;
  readonly env: Env;
  embedded(): Promise<readonly EmbeddedFile[]>;
}

export interface InstallSources {
  readonly soul?: string;
  readonly memory?: string;
}

const SEEDS = [
  { key: "soul", label: "SOUL.md", flag: "--soul" },
  { key: "memory", label: "MEMORY.md", flag: "--memory" },
] as const;

export function registerInstall(program: Command, deps: InstallDeps): void {
  program
    .command("install")
    .description("install tars's skills and seed SOUL.md and MEMORY.md into the data dir")
    .option("--soul <file>", "copy this file to SOUL.md if SOUL.md does not exist")
    .option("--memory <file>", "copy this file to MEMORY.md if MEMORY.md does not exist")
    .addHelpText(
      "after",
      `
Skills are replaced on every run. SOUL.md and MEMORY.md are never overwritten.

Examples:
  tars install --soul ./SOUL.md --memory ./MEMORY.md
  tars install`,
    )
    .action(async (sources: InstallSources) => {
      await install(resolvePaths(deps.env), await deps.embedded(), sources, deps.io);
    });
}

export async function install(
  paths: TarsPaths,
  skills: readonly EmbeddedFile[],
  sources: InstallSources,
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
  await replaceSkills(paths.skills, skills);
  for (const seed of seeds) if (seed.bytes) await createExclusive(seed.target, seed.bytes);
  await mkdir(paths.workspace, { recursive: true });

  io.out(`data: ${paths.data}`);
  io.out(`skills: ${skills.length} files`);
  for (const seed of seeds) io.out(`${seed.label}: ${seed.bytes ? "created" : "kept"}`);
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

/** Writes files into a sibling temp dir, then swaps it in, so stale skill files never survive. */
export async function replaceSkills(dir: string, files: readonly EmbeddedFile[]): Promise<void> {
  const tmp = join(dirname(dir), `.${basename(dir)}.tmp`);
  const old = join(dirname(dir), `.${basename(dir)}.old`);
  await rm(tmp, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });
  for (const file of files) {
    const path = join(tmp, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
  // rename() cannot replace a non-empty directory, so the old tree moves aside first.
  await rename(dir, old).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await rename(tmp, dir);
  await rm(old, { recursive: true, force: true });
}

/** link() fails if the target exists, so a seed never overwrites memory, even under a race. */
async function createExclusive(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.tmp`);
  await writeFile(tmp, bytes);
  try {
    await link(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
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
