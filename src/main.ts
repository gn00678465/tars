import { Command, CommanderError } from "commander";
import { EXIT, TarsError } from "./core/exit.ts";
import { processIo, type Io } from "./core/io.ts";
import type { Env } from "./core/paths.ts";

export interface Deps {
  readonly io: Io;
  readonly env: Env;
}

export function defaultDeps(): Deps {
  return { io: processIo, env: process.env };
}

export function buildProgram(deps: Deps): Command {
  return new Command("tars").exitOverride().configureOutput({
    writeOut: (s) => deps.io.out(s.trimEnd()),
    writeErr: (s) => deps.io.err(s.trimEnd()),
  });
}

export async function run(argv: readonly string[], deps: Deps = defaultDeps()): Promise<number> {
  try {
    await buildProgram(deps).parseAsync(argv, { from: "user" });
    return EXIT.ok;
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
