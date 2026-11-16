import type { Command } from "commander";
import { TarsError } from "../../core/exit.ts";
import type { Io } from "../../core/io.ts";
import { DATA_DIR_VAR, LAUNCH_DIR_VAR, resolvePaths, type Env } from "../../core/paths.ts";
import type { SecretStore } from "../../core/secrets.ts";
import { loadBoot } from "./boot.ts";
import { harnessEntries, type HarnessName } from "./harness/registry.ts";
import type { HarnessAdapter, LaunchPlan } from "./harness/types.ts";

export interface SessionDeps {
  readonly io: Io;
  readonly env: Env;
  /** The directory tars was started in. */
  readonly cwd: string;
  readonly secrets: SecretStore;
  launch(plan: LaunchPlan): Promise<number>;
}

export function registerSessions(
  program: Command,
  deps: SessionDeps,
  exitWith: (code: number) => void,
): void {
  for (const [name, adapter] of harnessEntries) {
    program
      .command(name)
      .description(adapter.description)
      .argument("[args...]", `arguments for ${name}, after --`)
      .showHelpAfterError(`pass ${name} options after --: tars ${name} -- <options>`)
      .addHelpText(
        "after",
        `
Runs in tars's workspace with the current directory added via --add-dir.
Logs the sha256 of SOUL.md and MEMORY.md to stderr before starting.
Exit code: ${name}'s own exit code once it starts; 1 if tars cannot start it.

Examples:
  tars ${name}
  tars ${name} -- <${name} options>`,
      )
      .action(async (args: string[]) => exitWith(await startSession(name, adapter, args, deps)));
  }
}

async function startSession(
  name: HarnessName,
  adapter: HarnessAdapter,
  userArgs: readonly string[],
  deps: SessionDeps,
): Promise<number> {
  const paths = resolvePaths(deps.env);
  const boot = await loadBoot(paths);
  // Re-converge before every launch: a missing settings.json would let ~/.claude/CLAUDE.md load.
  await adapter.prepare(paths);
  for (const file of boot.files) deps.io.err(`${file.sha256}  ${file.label}`);
  let credential: string | undefined;
  if (adapter.credential) {
    credential = (await deps.secrets.get(adapter.credential.secret)) ?? undefined;
    if (!credential)
      throw new TarsError(`no ${adapter.credential.secret} in the keyring; run: tars auth ${name}`);
  }
  const env = Object.fromEntries(
    Object.entries(deps.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env[DATA_DIR_VAR] = paths.data;
  // The session runs in the workspace; `tars script run --out` may also write where the user started.
  env[LAUNCH_DIR_VAR] = deps.cwd;
  return deps.launch(adapter.plan({ paths, env, launchDir: deps.cwd, userArgs, boot, credential }));
}
