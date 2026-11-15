import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { sibling } from "../../core/fs.ts";
import { parseMemory, renderMemory } from "./document.ts";
import { applyMemoryOp, type EditOutcome, type MemoryOp } from "./edit.ts";

export class MemoryFileMissingError extends TarsError {
  constructor(path: string) {
    super(`memory file not found: ${path}. Run \`tars install\` first.`);
  }
}

export class LockTimeoutError extends TarsError {
  constructor(lockPath: string, timeoutMs: number) {
    super(
      `waited ${timeoutMs} ms for ${lockPath}, still held by pid ${readPid(lockPath) ?? "?"}. ` +
        "Retry later; if no tars memory command is running, delete the lock file.",
    );
  }
}

/** Lock, read, apply, write back. A no-op leaves the file untouched. */
export async function updateMemoryFile(
  memoryPath: string,
  op: MemoryOp,
  lockTimeoutMs = 5000,
): Promise<EditOutcome> {
  if (!existsSync(memoryPath)) throw new MemoryFileMissingError(memoryPath);
  return withFileLock(sibling(memoryPath, "lock"), lockTimeoutMs, () => {
    const outcome = applyMemoryOp(parseMemory(readFileSync(memoryPath, "utf8")), op);
    if (outcome.ok && outcome.result !== "unchanged")
      writeAtomic(memoryPath, renderMemory(outcome.doc));
    return outcome;
  });
}

function writeAtomic(path: string, content: string): void {
  const tmp = sibling(path, "tmp");
  const fd = openSync(tmp, "w");
  try {
    fchmodSync(fd, statSync(path).mode & 0o777);
    // writeFileSync loops until every byte is written; a bare writeSync may stop short.
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

// A lock file holds its owner's pid. It is created by link(2) from a filled temp file, so it is
// never observed empty, and a lock whose pid is dead was left by a crash and can be removed.
// Removal goes through a second lock (`.break`) so two waiters cannot both clear the stale lock
// and then delete each other's fresh one.
export async function withFileLock<T>(
  lockPath: string,
  timeoutMs: number,
  critical: () => T,
): Promise<T> {
  const breakPath = `${lockPath}.break`;
  const deadline = Date.now() + timeoutMs;
  while (!tryClaim(lockPath)) {
    if (holderIsDead(lockPath)) {
      if (tryClaim(breakPath)) {
        try {
          if (holderIsDead(lockPath)) removeIfPresent(lockPath);
        } finally {
          removeIfPresent(breakPath);
        }
        continue;
      }
      if (holderIsDead(breakPath)) removeIfPresent(breakPath);
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
    await Bun.sleep(10 + Math.random() * 20);
  }
  try {
    return critical();
  } finally {
    removeIfPresent(lockPath);
  }
}

function tryClaim(path: string): boolean {
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, `${process.pid}\n`);
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  } finally {
    removeIfPresent(tmp);
  }
}

function holderIsDead(path: string): boolean {
  const pid = readPid(path);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return errorCode(err) === "ESRCH";
  }
}

function readPid(path: string): number | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
  const pid = Number.parseInt(content, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
}

function errorCode(err: unknown): unknown {
  return err instanceof Error && "code" in err ? err.code : undefined;
}
