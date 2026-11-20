import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { processStartTime, spawnAndWait, type SandboxResult } from "../../core/spawn.ts";

export type Network =
  | { readonly kind: "none" }
  | { readonly kind: "allow"; readonly hosts: readonly string[] }
  | { readonly kind: "open" };

export interface SandboxJob {
  readonly python: string;
  readonly script: string;
  readonly venv: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly network: Network;
  readonly secret?: string;
  readonly outDir?: string;
  readonly timeoutMs: number;
}

export interface SandboxHost {
  readonly realHome: string;
  readonly data: string;
  readonly bins: readonly string[];
  readonly seccomp: string;
}

export type { SandboxResult } from "../../core/spawn.ts";

// The proxy checks the addresses a name resolves to against these, but lets "localhost" reach
// loopback and never checks an IP literal at all; openAsk refuses the literals.
const OPEN_DENIED_DOMAINS = ["localhost", "*.localhost"];
const OPEN_DENIED_ADDRESSES = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
  "169.254.0.0/16",
  "fe80::/10",
];

export async function openAsk({ host }: { host: string }) {
  return isIpLiteral(host)
    ? { allow: false as const, reason: 'domains "*" allows host names, not IP addresses' }
    : true;
}

function isIpLiteral(host: string): boolean {
  try {
    const name = new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}/`).hostname;
    return isIP(name.replace(/^\[|\]$/g, "")) !== 0;
  } catch {
    return true;
  }
}

// sandbox-runtime binds a host /tmp/claude into every sandbox read-write, whatever denyRead says,
// and /tmp is shared with every local process.
const SHARED_TMP = "/tmp/claude";

export async function runSandboxed(job: SandboxJob, host: SandboxHost): Promise<SandboxResult> {
  const runDir = join(host.data, "run");
  await removeStaleRuns(runDir);
  const denyRead = [host.realHome, host.data, ...host.bins, "/tmp", "/var/tmp", "/run/user"];
  const baseRead = [job.script, job.venv, host.seccomp];
  const filesystem = (extra: string[]) => ({
    denyRead,
    allowRead: [...baseRead, ...extra],
    allowWrite: job.outDir ? [job.outDir] : [],
    // sandbox-runtime denies <cwd>/.git/hooks and .git/config only once <cwd>/.git exists, so a
    // script could plant a repository whose hooks and core.fsmonitor run when the user's shell runs
    // git in --out. Denying .git itself makes bwrap abort when .git exists, because the library
    // still stubs .git/config inside the read-only .git.
    denyWrite: job.outDir ? [join(job.outDir, ".git/hooks"), join(job.outDir, ".git/config")] : [],
  });
  const open = job.network.kind === "open";
  const config = {
    network: {
      allowedDomains: job.network.kind === "allow" ? [...job.network.hosts] : [],
      deniedDomains: open ? OPEN_DENIED_DOMAINS : [],
      ...(open ? { deniedResolvedAddresses: OPEN_DENIED_ADDRESSES } : {}),
    },
    filesystem: filesystem([]),
    seccomp: { applyPath: host.seccomp },
  } as SandboxRuntimeConfig;

  const record = join(runDir, `${process.pid}.json`);
  const callerDir = process.cwd();
  // On Linux sandbox-runtime ignores its cwd argument and denies writes to .git/hooks, .bashrc and
  // the like only under process.cwd(); --out is the one writable place, so that is what it scans.
  process.chdir(job.outDir ?? job.cwd);
  try {
    await SandboxManager.initialize(config, open ? openAsk : undefined);
    // sandbox-runtime only warns when the seccomp helper is missing, then runs with Unix sockets
    // unfiltered.
    const deps = SandboxManager.checkDependencies();
    const problems = [...deps.errors, ...deps.warnings];
    if (problems.length > 0)
      throw new TarsError(`the sandbox is not usable: ${problems.join("; ")}`);
    if (!(await SandboxManager.waitForNetworkInitialization()))
      throw new TarsError("the sandbox network proxy did not start");
    const socket = SandboxManager.getLinuxHttpSocketPath();
    if (!socket) throw new TarsError("the sandbox network proxy has no socket");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      record,
      JSON.stringify({ pid: process.pid, start: processStartTime(process.pid), socket }),
    );
    // sandbox-runtime puts NO_PROXY with loopback and private ranges into the command it builds,
    // so clearing it in the spawn env has no effect; it must be cleared in the command itself.
    const command = `NO_PROXY= no_proxy= exec ${[job.python, job.script, ...job.args].map(quote).join(" ")}`;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, undefined, {
      filesystem: filesystem([socket]),
    });
    if (existsSync(SHARED_TMP))
      throw new TarsError(
        `${SHARED_TMP} exists, and the sandbox would let the script read and write it; remove it first`,
      );
    return await spawnAndWait(wrapped.argv, job.cwd, sandboxEnv(job), job.timeoutMs);
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
    await rm(record, { force: true });
    process.chdir(callerDir);
  }
}

// On Linux wrapWithSandboxArgv returns process.env unchanged; its own variables are in the command.
function sandboxEnv(job: SandboxJob): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: "/tmp",
    ...(job.secret === undefined ? {} : { TARS_SECRET: job.secret }),
    ...(job.outDir === undefined ? {} : { TARS_OUT: job.outDir }),
  };
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A tars killed with SIGKILL leaves sandbox-runtime's socat bridge and sockets behind. */
async function removeStaleRuns(runDir: string): Promise<void> {
  const names = await readdir(runDir).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(runDir, name);
    let rec: { pid?: number; start?: string; socket?: string };
    try {
      rec = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (
      typeof rec.pid !== "number" ||
      typeof rec.socket !== "string" ||
      !rec.socket.startsWith("/")
    )
      continue;
    const start = processStartTime(rec.pid);
    if (start !== undefined && start === rec.start) continue;
    for (const pid of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(pid)) continue;
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      if (basename(cmdline.split("\0")[0] ?? "") === "socat" && cmdline.includes(rec.socket))
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
    }
    await rm(rec.socket, { force: true });
    for (const f of await readdir(tmpdir()).catch(() => [] as string[]))
      if (f.startsWith(`srt-mux-${rec.pid}-`)) await rm(join(tmpdir(), f), { force: true });
    await rm(path, { force: true });
  }
}
