import { Command, CommanderError } from "commander";
import { EXIT, TarsError } from "./core/exit.ts";
import { processIo, readSecret } from "./core/io.ts";
import { resolvePaths } from "./core/paths.ts";
import { keyringStore, type SecretStore } from "./core/secrets.ts";
import { openTty, type Terminal } from "./core/terminal.ts";
import { registerChat, type ChatContext } from "./features/agent/chat.ts";
import { registerCostCommands } from "./features/agent/cost-command.ts";
import { registerModelsCommands } from "./features/agent/models-command.ts";
import { adapterFor, type AdapterFor } from "./features/agent/provider.ts";
import { registerSetupCommands } from "./features/agent/setup-command.ts";
import { skillsFromBundle } from "./features/install/embedded.ts";
import { registerInstall, type InstallDeps } from "./features/install/install.ts";
import { registerMemoryCommands } from "./features/memory/command.ts";
import { registerScriptCommands } from "./features/script/command.ts";
import { registerSecretCommands } from "./features/script/secret.ts";
import { scriptRuntime } from "./features/script/runtime.ts";
import { launch } from "./features/session/launch.ts";
import { registerSessions, type SessionDeps } from "./features/session/session.ts";

export type Deps = InstallDeps &
  SessionDeps & {
    readonly secrets: SecretStore;
    readSecret(prompt: string): Promise<string>;
    /** Throws a TarsError when the process has no controlling terminal. */
    openTerminal(): Terminal;
    now(): Date;
    /** How to run this tars again as a child: the loop's tars tool spawns it. */
    readonly selfCommand: readonly string[];
    readonly adapterFor: AdapterFor;
    readonly signals: ChatContext["signals"];
  };

/** A compiled tars runs its embedded entry point from /$bunfs; `bun src/main.ts` needs the path. */
const selfCommand = () =>
  Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];

export function defaultDeps(): Deps {
  return {
    io: processIo,
    env: process.env,
    executable: process.execPath,
    cwd: process.cwd(),
    secrets: keyringStore,
    readSecret,
    openTerminal: openTty,
    now: () => new Date(),
    selfCommand: selfCommand(),
    adapterFor,
    signals: process,
    launch,
    embedded: () => skillsFromBundle(Bun.embeddedFiles),
  };
}

export function buildProgram(deps: Deps, exitWith: (code: number) => void): Command {
  // Subcommands inherit exitOverride and configureOutput only if set before they are added.
  const program = new Command("tars").exitOverride().configureOutput({
    writeOut: (s) => deps.io.out(s.trimEnd()),
    writeErr: (s) => deps.io.err(s.trimEnd()),
  });
  program.addHelpText(
    "after",
    `
Examples:
  dist/tars install --soul ./SOUL.md --memory ./MEMORY.md
  tars claude
  tars chat
  tars agy
  tars memory remember --id pref-tone --section 偏好 --text "回覆先講結論。" --source user
  tars script search push notification`,
  );
  registerInstall(program, deps);
  registerSessions(program, deps, exitWith);
  registerMemoryCommands(program, { io: deps.io, memoryPath: () => resolvePaths(deps.env).memory });
  const runtime = scriptRuntime(deps.env, deps.cwd);
  registerScriptCommands(program, {
    io: deps.io,
    scriptsDir: () => resolvePaths(deps.env).scripts,
    playbooksDir: () => resolvePaths(deps.env).playbooks,
    now: () => new Date(),
    secrets: deps.secrets,
    ...runtime,
    terminal: deps.openTerminal,
    exitWith,
  });
  registerSecretCommands(program, {
    io: deps.io,
    secrets: deps.secrets,
    scriptsDir: () => resolvePaths(deps.env).scripts,
    readSecret: deps.readSecret,
    google: runtime.google,
    inSession: runtime.inSession,
    terminal: deps.openTerminal,
  });
  const agent = {
    env: deps.env,
    io: deps.io,
    secrets: deps.secrets,
    openTerminal: deps.openTerminal,
    adapterFor: deps.adapterFor,
    now: deps.now,
  };
  registerSetupCommands(program, agent);
  registerModelsCommands(program, agent);
  registerCostCommands(program, agent);
  registerChat(
    program,
    {
      ...agent,
      selfCommand: deps.selfCommand,
      approveCommand: runtime.approveCommand,
      signals: deps.signals,
    },
    exitWith,
  );
  return program;
}

export async function run(argv: readonly string[], deps: Deps = defaultDeps()): Promise<number> {
  let code: number = EXIT.ok;
  try {
    await buildProgram(deps, (c) => (code = c)).parseAsync(argv, { from: "user" });
    return code;
  } catch (err) {
    // commander reports usage errors with exit code 1; tars reserves 2 for them.
    // --help and --version also arrive here, with exit code 0.
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (err instanceof TarsError) {
      deps.io.err(`error: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
