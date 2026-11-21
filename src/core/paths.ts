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
  readonly scripts: string;
  /** The user's own playbooks; tars install never touches them. */
  readonly playbooks: string;
  /** Directory `tars install` copies the executable into. */
  readonly bin: string;
  /** User settings (r29): config.toml is edited by hand, models.json only by `tars models`. */
  readonly config: string;
  readonly configFile: string;
  readonly modelsFile: string;
  /** `tars chat`'s own state; inside the data dir, so the script sandbox's denyRead covers it. */
  readonly agent: string;
  readonly agentDb: string;
  readonly agentLock: string;
  readonly agentLockInfo: string;
  readonly agentLog: string;
  /** What tars serve is doing, for `tars serve status`. */
  readonly serveStatus: string;
  /** The owner's knowledge base, opened in Obsidian; only `tars wiki sync` writes it. */
  readonly wiki: string;
  readonly wikiIndex: string;
  /** Sync's progress, its own usage and both search indexes; outside wiki/ so file_read cannot reach it. */
  readonly wikiDb: string;
  readonly wikiLock: string;
  readonly wikiLockInfo: string;
  /** Where scripts write what they make for the user. */
  readonly outRoot: string;
}

/** Set by tars for every harness it starts, so `tars` run inside a session finds the same data dir. */
export const DATA_DIR_VAR = "TARS_DATA_DIR";

export const LAUNCH_DIR_VAR = "TARS_LAUNCH_DIR";

/** Set for every harness tars starts; `tars script approve` refuses to run where it is set. */
export const IN_SESSION_VAR = "TARS_IN_SESSION";

export const inSession = (env: Env) => (env[IN_SESSION_VAR] ?? "") !== "";

export function resolvePaths(env: Env): TarsPaths {
  const home = env.HOME;
  if (!home || !isAbsolute(home)) throw new TarsError("HOME must be set to an absolute path");
  // agy runs with a HOME and XDG dirs of its own, so inside it only DATA_DIR_VAR points back here.
  const pinned = env[DATA_DIR_VAR];
  const data =
    pinned && isAbsolute(pinned)
      ? pinned
      : join(xdgDir(env.XDG_DATA_HOME, home, ".local", "share"), "tars");
  const config = join(xdgDir(env.XDG_CONFIG_HOME, home, ".config"), "tars");
  const agent = join(data, "agent");
  return {
    home,
    data,
    soul: join(data, "SOUL.md"),
    memory: join(data, "MEMORY.md"),
    skills: join(data, "skills"),
    workspace: join(data, "workspace"),
    harness: join(data, "harness"),
    scripts: join(data, "scripts"),
    playbooks: join(data, "playbooks"),
    bin: xdgDir(env.XDG_BIN_HOME, home, ".local", "bin"),
    config,
    configFile: join(config, "config.toml"),
    modelsFile: join(config, "models.json"),
    agent,
    agentDb: join(agent, "agent.db"),
    agentLock: join(agent, "lock.db"),
    agentLockInfo: join(agent, "lock.json"),
    agentLog: join(agent, "log.jsonl"),
    serveStatus: join(agent, "serve.json"),
    wiki: join(data, "wiki"),
    wikiIndex: join(data, "wiki", "index.md"),
    wikiDb: join(agent, "wiki.db"),
    wikiLock: join(agent, "wiki-lock.db"),
    wikiLockInfo: join(agent, "wiki-lock.json"),
    outRoot: join(data, "workspace", "out"),
  };
}

/** The XDG Base Directory spec says to ignore a relative path in these variables. */
function xdgDir(value: string | undefined, home: string, ...fallback: string[]): string {
  return value && isAbsolute(value) ? value : join(home, ...fallback);
}
