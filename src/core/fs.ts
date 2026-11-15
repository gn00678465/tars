import { readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** A hidden sibling with a fixed name, so the next run recognizes and replaces a crashed run's leftover. */
export function sibling(path: string, suffix: string): string {
  return join(dirname(path), `.${basename(path)}.${suffix}`);
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = sibling(path, "tmp");
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Converges path to a symlink pointing at target, replacing a wrong link or file atomically. */
export async function ensureSymlink(target: string, path: string): Promise<void> {
  if ((await readlink(path).catch(() => undefined)) === target) return;
  const tmp = sibling(path, "tmp");
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, path);
}
