import { Command, CommanderError } from "commander";

export function buildProgram(): Command {
  return new Command("tars").exitOverride();
}

export async function run(argv: string[]): Promise<number> {
  try {
    await buildProgram().parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    // commander reports usage errors with exit code 1; tars reserves 2 for them.
    // --help and --version also arrive here, with exit code 0.
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
    throw err;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
