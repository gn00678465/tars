import { randomUUID } from "node:crypto";
import { link, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** A hidden sibling with a fixed name, so the next run recognizes and replaces a crashed run's leftover. */
export function sibling(path: string, suffix: string): string {
  return join(dirname(path), `.${basename(path)}.${suffix}`);
}

// Every session launch runs prepare, so concurrent launches write the same paths; a per-call
// temp name keeps one launch's rename from consuming another's temp file.
export const uniqueTemp = (path: string) => sibling(path, `tmp-${randomUUID()}`);

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = uniqueTemp(path);
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Converges path to a symlink pointing at target, replacing a wrong link or file atomically. */
export async function ensureSymlink(target: string, path: string): Promise<void> {
  if ((await readlink(path).catch(() => undefined)) === target) return;
  const tmp = uniqueTemp(path);
  try {
    await symlink(target, tmp);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Creates path with data unless it exists; returns false when it did. link() fails on an existing
 * target, so this never overwrites, even under a race.
 */
export async function createExclusive(path: string, data: string | Uint8Array): Promise<boolean> {
  const tmp = uniqueTemp(path);
  try {
    await writeFile(tmp, data);
    await link(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}
