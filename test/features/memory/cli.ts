// Runs `tars memory ...` against a given memory file, with the same error handling as main.ts run().
import { Command, CommanderError } from "commander";
import { EXIT, TarsError } from "../../../src/core/exit.ts";
import { processIo } from "../../../src/core/io.ts";
import { registerMemoryCommands } from "../../../src/features/memory/command.ts";

export async function runMemoryCli(memoryPath: string, argv: string[]): Promise<number> {
  const program = new Command("tars").exitOverride().configureOutput({
    writeOut: (s) => processIo.out(s.trimEnd()),
    writeErr: (s) => processIo.err(s.trimEnd()),
  });
  registerMemoryCommands(program, { io: processIo, memoryPath: () => memoryPath });
  try {
    await program.parseAsync(["memory", ...argv], { from: "user" });
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (err instanceof TarsError) {
      processIo.err(`error: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

if (import.meta.main) {
  const [memoryPath = "", ...argv] = process.argv.slice(2);
  process.exitCode = await runMemoryCli(memoryPath, argv);
}
