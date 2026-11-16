import { isAbsolute, join } from "node:path";
import { accountHome } from "../../core/account.ts";
import { TarsError } from "../../core/exit.ts";
import { LAUNCH_DIR_VAR, resolvePaths, type Env } from "../../core/paths.ts";
import type { OutDirRules } from "./out-dir.ts";
import type { SandboxHost } from "./sandbox.ts";
import { seccompHelper } from "./seccomp.ts";

export function scriptRuntime(env: Env, cwd: string) {
  let home: string | undefined;
  const realHome = () => (home ??= accountHome());
  const bins = () => [...new Set([resolvePaths(env).bin, join(realHome(), ".local", "bin")])];
  return {
    sandboxHost: async (): Promise<SandboxHost> => {
      const { data } = resolvePaths(env);
      return {
        realHome: realHome(),
        data,
        bins: bins(),
        seccomp: await seccompHelper(data, Bun.embeddedFiles),
      };
    },
    outDirRules: (): OutDirRules => {
      const launch = env[LAUNCH_DIR_VAR];
      return {
        cwd,
        launchDir: launch && isAbsolute(launch) ? launch : cwd,
        realHome: realHome(),
        data: resolvePaths(env).data,
        bins: bins(),
      };
    },
    pythonVersion: (): string => {
      const proc = Bun.spawnSync([
        "python3",
        "-c",
        "import sys; print('%d.%d' % sys.version_info[:2])",
      ]);
      const version = proc.stdout.toString().trim();
      if (proc.exitCode !== 0 || !/^\d+\.\d+$/.test(version))
        throw new TarsError("python3 is not on PATH; scripts need it");
      return version;
    },
  };
}
