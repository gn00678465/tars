import type { TarsPaths } from "../../../core/paths.ts";
import type { BootContext } from "../boot.ts";

export interface LaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface PlanContext {
  readonly paths: TarsPaths;
  /** The parent environment tars was started with. */
  readonly env: Readonly<Record<string, string>>;
  /** The directory tars was started in, handed to the agent with --add-dir. */
  readonly launchDir: string;
  readonly userArgs: readonly string[];
  readonly boot: BootContext;
}

export interface HarnessAdapter {
  readonly description: string;
  /** Creates the harness's dirs, symlinks, and generated files; rerunning converges to the same tree. */
  prepare(paths: TarsPaths): Promise<void>;
  plan(ctx: PlanContext): LaunchPlan;
}
