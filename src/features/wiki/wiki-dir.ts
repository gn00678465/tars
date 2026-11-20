import { constants as C } from "node:fs";
import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import type { TarsPaths } from "../../core/paths.ts";
import { uniqueTemp } from "../../core/fs.ts";

/**
 * <data>/wiki or one of its category directories, held open by descriptor and reached without
 * following a symlink. Every operation goes through /proc/self/fd/<fd>/<name>, which the kernel
 * resolves to the directory the descriptor holds, so a name on the path swapped for a symlink
 * after the open changes nothing. Linux only, as the rest of tars.
 */
export interface WikiDir {
  at(name: string): string;
  close(): Promise<void>;
}

const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;

async function openDir(path: string): Promise<FileHandle | "missing" | "unsafe"> {
  try {
    return await open(path, DIR_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "ELOOP" || code === "ENOTDIR") return "unsafe";
    throw err;
  }
}

const wrap = (h: FileHandle): WikiDir => ({
  at: (name) => `/proc/self/fd/${h.fd}/${name}`,
  close: () => h.close(),
});

/** <data>/wiki, or `category` inside it; `create` makes a missing one first. */
export async function openWikiDir(
  paths: TarsPaths,
  category?: string,
  create = false,
): Promise<WikiDir | "missing" | "unsafe"> {
  if (create) await mkdir(paths.wiki, { recursive: true });
  const root = await openDir(paths.wiki);
  if (typeof root === "string") return root;
  if (category === undefined) return wrap(root);
  try {
    const inRoot = `/proc/self/fd/${root.fd}/${category}`;
    if (create)
      await mkdir(inRoot).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
    const dir = await openDir(inRoot);
    return typeof dir === "string" ? dir : wrap(dir);
  } finally {
    await root.close();
  }
}

/** Runs `use` with the directory open, or says why it could not be opened safely. */
export async function withWikiDir<T>(
  paths: TarsPaths,
  category: string | undefined,
  create: boolean,
  use: (dir: WikiDir) => Promise<T>,
): Promise<{ readonly value: T } | { readonly dir: "missing" | "unsafe" }> {
  const dir = await openWikiDir(paths, category, create);
  if (typeof dir === "string") return { dir };
  try {
    return { value: await use(dir) };
  } finally {
    await dir.close();
  }
}

export const listDir = (dir: WikiDir) => readdir(dir.at("."), { withFileTypes: true });

/** The file's text; undefined only when it does not exist. A symlink is an error (ELOOP). */
export async function readIn(dir: WikiDir, name: string): Promise<string | undefined> {
  let h: FileHandle;
  try {
    h = await open(dir.at(name), C.O_RDONLY | C.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return await h.readFile("utf8");
  } finally {
    await h.close();
  }
}

/** Written to a temp file in the directory, then renamed over `name` there. */
export async function writeIn(dir: WikiDir, name: string, data: string): Promise<void> {
  const tmp = uniqueTemp(name);
  try {
    const h = await open(dir.at(tmp), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o666);
    try {
      await h.writeFile(data);
    } finally {
      await h.close();
    }
    await rename(dir.at(tmp), dir.at(name));
  } finally {
    await rm(dir.at(tmp), { force: true });
  }
}
