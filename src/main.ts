import { Command, CommanderError } from "commander";
import { EXIT, TarsError } from "./core/exit.ts";
import { processIo, readSecret } from "./core/io.ts";
import { keyringStore } from "./core/secrets.ts";
import { registerAuth, type AuthDeps } from "./features/auth/auth.ts";
import { skillsFromBundle } from "./features/install/embedded.ts";
import { registerInstall, type InstallDeps } from "./features/install/install.ts";
import { launch } from "./features/session/launch.ts";
import { registerSessions, type SessionDeps } from "./features/session/session.ts";

export type Deps = InstallDeps & SessionDeps & AuthDeps;

export function defaultDeps(): Deps {
  return {
    io: processIo,
    env: process.env,
    cwd: process.cwd(),
    secrets: keyringStore,
    readSecret,
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
  tars install --soul ./SOUL.md --memory ./MEMORY.md
  tars auth claude
  tars claude
  tars agy`,
  );
  registerInstall(program, deps);
  registerAuth(program, deps);
  registerSessions(program, deps, exitWith);
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
