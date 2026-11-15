import { agy } from "./agy.ts";
import { claude } from "./claude.ts";
import type { HarnessAdapter } from "./types.ts";

/** Adding a harness is one adapter file plus one entry here; commands are registered from this table. */
export const harnesses = { claude, agy } satisfies Record<string, HarnessAdapter>;

export type HarnessName = keyof typeof harnesses;

export const harnessEntries = Object.entries(harnesses) as [HarnessName, HarnessAdapter][];
