import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../core/fs.ts";
import type { LinkState } from "../agent/log.ts";

/** serve.json: no message text, JWT or key, only what `tars serve status` prints. */
export interface ServeStatus {
  readonly pid: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly version: string;
  readonly link: {
    readonly state: LinkState;
    readonly since: number;
    readonly lastError?: string;
    readonly replacedSince?: number;
    readonly replacedNotified?: boolean;
  };
  readonly browsers: number;
  readonly pendingApprovals: number;
  readonly turnRunning: boolean;
  readonly accessKeys: "ok" | "unavailable";
  readonly notify: "ok" | "not_configured";
}

export const STATUS_EVERY_MS = 5_000;
/** Older than this, nothing is writing it: tars serve is not running. */
export const STATUS_FRESH_MS = 15_000;

export const writeStatus = (file: string, s: ServeStatus) =>
  writeFileAtomic(file, `${JSON.stringify(s)}\n`);

export async function readStatus(file: string): Promise<ServeStatus | undefined> {
  try {
    const s = JSON.parse(await readFile(file, "utf8")) as ServeStatus;
    return typeof s.updatedAt === "number" && typeof s.link?.state === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}
