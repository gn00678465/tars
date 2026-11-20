import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { approveSample } from "../features/script/sample.ts";
import {
  binaryDirsFor,
  EXIT_SKIP,
  namespacesWork,
  reexecInNetns,
  resolveTool,
  runStep,
  type Host,
  type StepResult,
} from "./sandbox.ts";

const TARS_BIN = join(import.meta.dir, "..", "..", "dist", "tars");
const TOOLS = [
  "bwrap",
  "unshare",
  "ip",
  "dbus-daemon",
  "dbus-send",
  "gnome-keyring-daemon",
  "socat",
  "python3",
  "rg",
  "uv",
];

/** Re-runs `path` in a loopback-only netns with `innerVar` set, or skips when a prerequisite is missing. */
export function enterScriptNetns(path: string, innerVar: string, suite: string): number {
  const missing = TOOLS.filter((t) => !Bun.which(t));
  if (missing.length > 0) {
    console.error(`${suite} SKIP, missing: ${missing.join(", ")}`);
    return EXIT_SKIP;
  }
  if (!namespacesWork()) {
    console.error(`${suite} SKIP, user or network namespaces are disabled`);
    return EXIT_SKIP;
  }
  return reexecInNetns(path, { ...process.env, [innerVar]: "1" }) ?? 1;
}

export interface ScriptHost {
  readonly host: Host;
  readonly uv: string;
  /** major.minor of /usr/bin/python3, the suffix of every venv directory. */
  readonly python: string;
  /** Runs `script` with sh in the e2e sandbox, from the fake home. */
  step(
    name: string,
    script: string,
    env?: Record<string, string>,
    stdin?: string,
  ): Promise<StepResult>;
  /** Writes `source` as a draft in the workspace and returns the path to pass to submit. */
  draft(name: string, source: string): string;
}

/** A fake home with dist/tars and uv on PATH, for suites that run tars script inside the e2e sandbox. */
export function scriptHost(prefix: string): ScriptHost {
  const home = userInfo().homedir;
  const work = mkdtempSync(join(tmpdir(), prefix));
  const uv = resolveTool("uv", process.env);
  if (!uv) throw new Error("uv is on PATH but its binary could not be resolved");
  const host: Host = {
    uid: process.getuid?.() ?? 0,
    user: userInfo().username,
    home,
    work,
    fakeHome: join(work, "home"),
    bin: join(work, "bin"),
    binaryDirs: binaryDirsFor([uv]),
    apiUrl: "",
  };
  mkdirSync(host.fakeHome, { recursive: true });
  mkdirSync(host.bin, { recursive: true });
  copyFileSync(TARS_BIN, join(host.bin, "tars"));
  chmodSync(join(host.bin, "tars"), 0o755);
  symlinkSync(uv, join(host.bin, "uv"));
  const python = Bun.spawnSync([
    "/usr/bin/python3",
    "-c",
    "import sys;print('%d.%d'%sys.version_info[:2])",
  ])
    .stdout.toString()
    .trim();
  return {
    host,
    uv,
    python,
    step: (name, script, env = {}, stdin) =>
      runStep(host, {
        name,
        argv: ["sh", "-c", script],
        cwd: host.home,
        env,
        timeoutMs: 120_000,
        ...(stdin === undefined ? {} : { stdin }),
      }),
    draft: (name, source) => {
      const dir = join(host.fakeHome, ".local/share/tars/workspace/drafts", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "script.py"), source);
      return `~/.local/share/tars/workspace/drafts/${name}`;
    },
  };
}

/** Puts `source` in the library as approved version v1; returns its directory inside the sandbox. */
export function install(host: Host, name: string, source: string, lock = ""): string {
  const version = join(host.fakeHome, ".local/share/tars/scripts/library", name, "versions", "v1");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "script.py"), source);
  approveSample(version, source, lock);
  symlinkSync(join("versions", "v1"), join(version, "..", "..", "current"));
  return join(host.home, ".local/share/tars/scripts/library", name, "versions", "v1");
}

/** The last stdout line parsed as JSON, or {} when it is not JSON. */
export function lastJson(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return {};
  }
}
