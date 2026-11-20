import { TarsError } from "../../core/exit.ts";
import { EFFORTS, type Effort } from "./types.ts";

export { EFFORTS };

export const isEffort = (value: string): value is Effort => EFFORTS.includes(value as Effort);

export function parseEffort(value: string): Effort | undefined {
  return isEffort(value) ? value : undefined;
}

/** The levels a model accepts; a model that does not say supports none. */
const supported = (entry: { readonly effortLevels?: readonly Effort[] }) =>
  EFFORTS.filter((level) => entry.effortLevels?.includes(level) === true);

export type EffortChoice =
  | { readonly effort: Effort; readonly notice?: undefined }
  | { readonly effort: undefined; readonly notice: "effort_unsupported" }
  | { readonly effort: Effort; readonly notice: "effort_clamped" };

/**
 * What a turn sends for a level nobody chose just now (the config default, or a model whose
 * abilities changed after a refresh): the nearest supported level below, else the lowest one.
 * The conversation keeps its own level.
 */
export function effectiveEffort(
  entry: { readonly effortLevels?: readonly Effort[] },
  wanted: Effort,
): EffortChoice {
  const levels = supported(entry);
  if (levels.length === 0) return { effort: undefined, notice: "effort_unsupported" };
  if (levels.includes(wanted)) return { effort: wanted };
  const below = levels.filter((l) => EFFORTS.indexOf(l) < EFFORTS.indexOf(wanted));
  return { effort: below.at(-1) ?? (levels[0] as Effort), notice: "effort_clamped" };
}

/** A level the owner picks (--effort, /effort) must be one the model supports. */
export function assertSelectable(
  entry: { readonly id: string; readonly effortLevels?: readonly Effort[] },
  wanted: Effort,
): void {
  const levels = supported(entry);
  if (levels.includes(wanted)) return;
  throw new TarsError(
    levels.length === 0
      ? `${entry.id} 不支援推理強度`
      : `${entry.id} 不支援推理強度 ${wanted}；可選：${levels.join(", ")}`,
  );
}
