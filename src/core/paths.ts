import { isAbsolute, join } from "node:path";
import { TarsError } from "./exit.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** Every location tars reads or writes. Only resolvePaths reads the environment for paths. */
export interface TarsPaths {
  readonly home: string;
  readonly data: string;
  readonly soul: string;
  readonly memory: string;
  readonly skills: string;
  readonly workspace: string;
  readonly harness: string;
}

/** Set by tars for every harness it starts, so `tars` run inside a session finds the same data dir. */
export const DATA_DIR_VAR = "TARS_DATA_DIR";

export function resolvePaths(env: Env): TarsPaths {
  const home = env.HOME;
  if (!home || !isAbsolute(home)) throw new TarsError("HOME must be set to an absolute path");
  // agy runs with a HOME and XDG dirs of its own, so inside it only DATA_DIR_VAR points back here.
  const pinned = env[DATA_DIR_VAR];
  // The XDG Base Directory spec says to ignore a relative XDG_DATA_HOME.
  const xdg = env.XDG_DATA_HOME;
  const data =
    pinned && isAbsolute(pinned)
      ? pinned
      : join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "tars");
  return {
    home,
    data,
    soul: join(data, "SOUL.md"),
    memory: join(data, "MEMORY.md"),
    skills: join(data, "skills"),
    workspace: join(data, "workspace"),
    harness: join(data, "harness"),
  };
}
