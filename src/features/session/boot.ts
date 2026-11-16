import { readFile } from "node:fs/promises";
import { TarsError } from "../../core/exit.ts";
import { sha256 } from "../../core/hash.ts";
import type { TarsPaths } from "../../core/paths.ts";

export type BootLabel = "SOUL.md" | "MEMORY.md";

export interface BootFile {
  readonly label: BootLabel;
  readonly content: string;
  /** sha256 of the file's bytes on disk, in hex. */
  readonly sha256: string;
}

/** The allowlisted files every session boots with, in manifest order. */
export interface BootContext {
  readonly files: readonly BootFile[];
}

export async function loadBoot(paths: TarsPaths): Promise<BootContext> {
  const manifest: readonly (readonly [BootLabel, string])[] = [
    ["SOUL.md", paths.soul],
    ["MEMORY.md", paths.memory],
  ];
  return { files: await Promise.all(manifest.map(([label, path]) => readBootFile(label, path))) };
}

async function readBootFile(label: BootLabel, path: string): Promise<BootFile> {
  const bytes = await readFile(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  const content = bytes ? new TextDecoder().decode(bytes) : "";
  if (!bytes || content.trim() === "") {
    throw new TarsError(`${label} is missing or empty at ${path}; run tars install`);
  }
  return { label, content, sha256: sha256(bytes) };
}
