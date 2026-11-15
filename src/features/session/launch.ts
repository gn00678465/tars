import { TarsError } from "../../core/exit.ts";
import type { LaunchPlan } from "./harness/types.ts";

/** Runs the harness on the terminal and resolves with its exit code (128 + signal if killed). */
export async function launch(plan: LaunchPlan): Promise<number> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([plan.command, ...plan.args], {
      cwd: plan.cwd,
      env: { ...plan.env },
      stdio: ["inherit", "inherit", "inherit"],
    });
  } catch (err) {
    throw new TarsError(`cannot start ${plan.command}: ${(err as Error).message}`);
  }
  // Ctrl-C reaches the child through the terminal's process group; tars must outlive it to
  // report its exit code. A SIGTERM aimed at tars alone is passed on so the child is not orphaned.
  const ignore = () => {};
  const forward = () => child.kill("SIGTERM");
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", forward);
  }
}
