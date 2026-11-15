import { existsSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Exit code when a prerequisite is missing; the automake convention for a skipped test. */
export const EXIT_SKIP = 77;

const SYSTEM_TOOLS = [
  "bwrap",
  "unshare",
  "ip",
  "dbus-daemon",
  "dbus-send",
  "gnome-keyring-daemon",
  "secret-tool",
] as const;

export const HARNESSES = ["claude", "agy"] as const;
export type Harness = (typeof HARNESSES)[number];

export const overrideVar = (harness: Harness) => `TARS_E2E_${harness.toUpperCase()}`;

/**
 * The real binary behind `harness`: the override variable, else the one on PATH. A mise
 * command wrapper resolves to the mise executable itself, which needs mise's config from the
 * real home, so it is asked for the tool's own binary instead.
 */
export function resolveHarness(harness: Harness, env: NodeJS.ProcessEnv): string | undefined {
  const given = env[overrideVar(harness)] || Bun.which(harness);
  if (!given || !existsSync(given)) return undefined;
  const real = realpathSync(given);
  if (basename(real) !== "mise") return real;
  const found = Bun.spawnSync([real, "which", harness], { env }).stdout.toString().trim();
  return found && existsSync(found) ? realpathSync(found) : undefined;
}

/** Names of missing prerequisites, empty when everything the suite runs is present. */
export function missingPrerequisites(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = SYSTEM_TOOLS.filter((tool) => !Bun.which(tool));
  for (const harness of HARNESSES) {
    if (!resolveHarness(harness, env)) missing.push(`${harness} (or ${overrideVar(harness)})`);
  }
  return missing;
}

/** Whether unprivileged user and network namespaces work on this machine. */
export function namespacesWork(): boolean {
  return Bun.spawnSync(["unshare", "-rn", "true"]).exitCode === 0;
}

/**
 * Re-runs this script in a fresh network namespace that has only loopback, as the invoking
 * uid again (unshare -r maps it to root, which bwrap and the harnesses should not see).
 */
export function reexecInNetns(script: string, env: NodeJS.ProcessEnv) {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const inner =
    'ip link set lo up && exec unshare --user --map-user="$1" --map-group="$2" "${@:3}"';
  return Bun.spawnSync(
    [
      "unshare",
      "-rn",
      "bash",
      "-c",
      inner,
      "bash",
      String(uid),
      String(gid),
      process.execPath,
      script,
    ],
    { env, stdio: ["inherit", "inherit", "inherit"] },
  ).exitCode;
}

export interface Host {
  readonly uid: number;
  readonly user: string;
  /** The real $HOME path. Inside the sandbox the fake home is mounted here. */
  readonly home: string;
  /** Scratch dir, visible at the same path inside the sandbox. */
  readonly work: string;
  /** Host path of the fake home. */
  readonly fakeHome: string;
  /** First on PATH inside the sandbox: a copy of dist/tars and links to the harness binaries. */
  readonly bin: string;
  /** Host dirs holding the real harness binaries, mounted read-only at the same paths. */
  readonly binaryDirs: readonly string[];
  readonly apiUrl: string;
}

export interface Step {
  readonly name: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface StepResult {
  readonly name: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

const KEYRING_PASSWORD = "e2e-keyring-password";

// The bus listens on an abstract socket, which exists only inside this network namespace.
// gnome-keyring keeps its keyring under the fake home, so entries survive from step to step.
const WITH_PRIVATE_KEYRING = `set -e
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --print-pid >/dev/null
printf '%s' "$E2E_KEYRING_PASSWORD" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
unset E2E_KEYRING_PASSWORD
i=0
until dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \\
  org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null | grep -q true; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || { echo "e2e: private keyring did not start" >&2; exit 70; }
  sleep 0.1
done
exec "$@"`;

/** The environment every sandboxed command starts from; nothing is inherited from the host. */
export function baseEnv(host: Host): Record<string, string> {
  return {
    PATH: `${host.bin}:/usr/bin:/bin`,
    HOME: host.home,
    USER: host.user,
    LOGNAME: host.user,
    TERM: "dumb",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    XDG_RUNTIME_DIR: `/run/user/${host.uid}`,
    DBUS_SESSION_BUS_ADDRESS: "unix:abstract=tars-e2e-session-bus",
    E2E_KEYRING_PASSWORD: KEYRING_PASSWORD,
  };
}

/**
 * Runs one command under bwrap with the fake home over $HOME, fresh /tmp and /run (which hides
 * the session bus, the system bus, systemd-resolved, avahi, and every other host socket there),
 * and a private dbus-daemon plus gnome-keyring. The caller is already in the loopback-only netns.
 */
export async function runStep(host: Host, step: Step): Promise<StepResult> {
  const bwrap = [
    "bwrap",
    "--dev-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--perms",
    "0700",
    "--dir",
    `/run/user/${host.uid}`,
    "--bind",
    host.fakeHome,
    host.home,
    ...host.binaryDirs.flatMap((dir) => ["--ro-bind", dir, dir]),
    "--bind",
    host.work,
    host.work,
    "--unshare-pid",
    "--die-with-parent",
    "--chdir",
    step.cwd,
    "--",
    "/bin/sh",
    "-c",
    WITH_PRIVATE_KEYRING,
    "sh",
    ...step.argv,
  ];
  const started = performance.now();
  const child = Bun.spawn(bwrap, {
    env: { ...baseEnv(host), ...step.env },
    stdin: step.stdin === undefined ? "ignore" : new TextEncoder().encode(step.stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: step.timeoutMs ?? 120_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { name: step.name, exitCode, stdout, stderr, ms: Math.round(performance.now() - started) };
}

/** Dirs to mount read-only so the harness binaries resolve inside the sandbox. */
export function binaryDirsFor(binaries: readonly string[]): string[] {
  return [...new Set(binaries.map((path) => dirname(path)))];
}
