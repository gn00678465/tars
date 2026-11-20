import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { loadScript, scriptsLayout, type LibraryScript } from "./library.ts";
import { pendingState } from "./pending.ts";

/**
 * The approved script `name`. One that is only under review must not read as missing, or the
 * agent writes another: the error says what it waits for and who approves it.
 */
export async function loadApprovedScript(
  scriptsDir: string,
  name: string,
  approveCommand: (name: string) => string,
): Promise<LibraryScript> {
  const layout = scriptsLayout(scriptsDir);
  try {
    return await loadScript(layout, name);
  } catch (err) {
    const inLibrary = await lstat(join(layout.library, name)).then(
      () => true,
      () => false,
    );
    if (!(err instanceof TarsError) || inLibrary) throw err;
    const state = await pendingState(scriptsDir, name);
    if (state === undefined) throw err;
    throw new TarsError(
      state === "awaiting-approve"
        ? `${name} is not approved yet (awaiting-approve). Only the user approves it, in their own terminal: ${approveCommand(name)}`
        : `${name} is not approved yet (awaiting-review): its adversarial review is not attached. Attach one with: tars script review ${name} --report <file>; then the user approves it`,
    );
  }
}
