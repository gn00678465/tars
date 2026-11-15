import type { TarsPaths } from "../../../core/paths.ts";
import type { SecretName } from "../../../core/secrets.ts";
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
  /** The keyring value of the adapter's credential; the launcher guarantees it when one is declared. */
  readonly credential: string | undefined;
}

export interface Credential {
  readonly secret: SecretName;
  /** How the user obtains the value, shown in `tars auth <harness> --help`. */
  readonly obtain: string;
}

export interface HarnessAdapter {
  readonly description: string;
  readonly credential?: Credential;
  /** Creates the harness's dirs, symlinks, and generated files; rerunning converges to the same tree. */
  prepare(paths: TarsPaths): Promise<void>;
  plan(ctx: PlanContext): LaunchPlan;
}
