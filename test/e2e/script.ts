import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { approveSample } from "../features/script/sample.ts";
import {
  EXIT_SKIP,
  finishChecks,
  namespacesWork,
  printChecks,
  reexecInNetns,
  runStep,
  type Check,
  type Host,
} from "./sandbox.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TARS_BIN = join(ROOT, "dist", "tars");
const INNER = "TARS_E2E_SCRIPT_INNER";
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
];

const KEY = "E2E-FAKE-BARK-KEY-0123456789";
const ALLOWED_PORT = 18765;
const OTHER_PORT = 18766;
const SECRET = JSON.stringify({ url: `http://127.0.0.1:${ALLOWED_PORT}`, key: KEY });

const PROBE = `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "probe"
# summary = "e2e probe"
# secret = "fake-bark"
# domains = ["secret:url"]
# effects = "external-write"
# args = "<anything>"
# outputs = "JSON"
# exit = { 0 = "ok", 5 = "slept" }
# ///
import base64, json, os, socket, sys, time, urllib.parse, urllib.request
if sys.argv[1:2] == ["sleep"]:
    time.sleep(float(sys.argv[2])); sys.exit(5)
def attempt(f):
    try: return f()
    except Exception as e: return "DENIED " + type(e).__name__
def get(port):
    return attempt(lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5).status)
def bus():
    s = socket.socket(socket.AF_UNIX); s.connect("\\0tars-e2e-session-bus"); return "CONNECTED"
secret = os.environ.get("TARS_SECRET", "")
key = json.loads(secret)["key"] if secret else ""
print(secret); print(key); print(urllib.parse.quote(key)); print(base64.b64encode(key.encode()).decode())
print("stderr", key, file=sys.stderr)
out = os.environ.get("TARS_OUT")
if out: open(os.path.join(out, "written.txt"), "w").write("from the sandbox")
hook = attempt(lambda: open(os.path.join(out, ".git/hooks/pre-commit"), "w").write("x")) if out else None
print(json.dumps({
  "cwd": os.getcwd(),
  "hook": hook,
  "argv": sys.argv[1:],
  "allowed": get(${ALLOWED_PORT}), "other": get(${OTHER_PORT}),
  "home": [attempt(lambda: open(p).read()) for p in (${JSON.stringify(`${userInfo().homedir}/canary.txt`)}, ${JSON.stringify(`${userInfo().homedir}/.local/share/tars/MEMORY.md`)})],
  "canary": attempt(lambda: open("/tmp/canary.txt").read()),
  "bus": attempt(bus),
  "env": sorted(k for k in os.environ if k.startswith("TARS") or k in ("DBUS_SESSION_BUS_ADDRESS", "E2E_KEYRING_PASSWORD")),
}))
`;

const OPEN = `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "opener"
# summary = "e2e open network"
# domains = ["*"]
# effects = "read-only"
# args = ""
# outputs = "JSON"
# exit = { 0 = "ok" }
# ///
import json, urllib.request
def get(url):
    try: return urllib.request.urlopen(url, timeout=5).status
    except Exception as e: return "DENIED " + type(e).__name__
hosts = ["127.0.0.1", "localhost", "localhost.", "LOCALHOST", "127.0.0.2", "127.1", "2130706433", "0.0.0.0", "[::ffff:127.0.0.1]", "[::1]"]
print(json.dumps({h: get(f"http://{h}:${ALLOWED_PORT}/") for h in hosts}))
`;

function lastJson(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return {};
  }
}

const denied = (value: unknown) =>
  Array.isArray(value) && value.length > 0 && value.every((r) => String(r).startsWith("DENIED"));

function outer(): number {
  const missing = TOOLS.filter((t) => !Bun.which(t));
  if (missing.length > 0) {
    console.error(`e2e:script SKIP, missing: ${missing.join(", ")}`);
    return EXIT_SKIP;
  }
  if (!namespacesWork()) {
    console.error("e2e:script SKIP, user or network namespaces are disabled");
    return EXIT_SKIP;
  }
  return reexecInNetns(import.meta.path, { ...process.env, [INNER]: "1" }) ?? 1;
}

function install(host: Host, name: string, source: string): string {
  const version = join(host.fakeHome, ".local/share/tars/scripts/library", name, "versions", "v1");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "script.py"), source);
  approveSample(version, source);
  symlinkSync(join("versions", "v1"), join(version, "..", "..", "current"));
  return join(host.home, ".local/share/tars/scripts/library", name, "versions", "v1");
}

async function inner(): Promise<number> {
  const home = userInfo().homedir;
  const work = mkdtempSync(join(tmpdir(), "tars-e2e-script-"));
  const host: Host = {
    uid: process.getuid?.() ?? 0,
    user: userInfo().username,
    home,
    work,
    fakeHome: join(work, "home"),
    bin: join(work, "bin"),
    binaryDirs: [],
    apiUrl: "",
  };
  mkdirSync(host.fakeHome, { recursive: true });
  mkdirSync(host.bin, { recursive: true });
  copyFileSync(TARS_BIN, join(host.bin, "tars"));
  chmodSync(join(host.bin, "tars"), 0o755);
  const servers = [ALLOWED_PORT, OTHER_PORT].map((port) =>
    Bun.serve({ hostname: "::", port, fetch: () => new Response("ok") }),
  );
  const checks: Check[] = [];
  const check = (id: string, claim: string, pass: boolean, evidence: string) =>
    checks.push({ id, claim, pass, evidence });
  const step = (name: string, script: string, env: Record<string, string> = {}, stdin?: string) =>
    runStep(host, {
      name,
      argv: ["sh", "-c", script],
      cwd: host.home,
      env,
      timeoutMs: 120_000,
      ...(stdin === undefined ? {} : { stdin }),
    });
  const python = Bun.spawnSync(["python3", "-c", "import sys;print('%d.%d'%sys.version_info[:2])"])
    .stdout.toString()
    .trim();
  try {
    const pending = join(host.fakeHome, ".local/share/tars/scripts/pending/probe");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "script.py"), PROBE);
    const venvs = [
      install(host, "probe", PROBE),
      install(host, "opener", OPEN),
      join(host.home, ".local/share/tars/scripts/pending/probe"),
    ].map((v) => `python3 -m venv --without-pip ${v}/venv-${python}`);
    const setup = await step("setup", venvs.join(" && "));
    if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.stderr}`);

    const set = await step("secret-set", "tars secret set fake-bark", {}, SECRET);
    check(
      "secret-set",
      "tars secret set reads stdin and never prints the value",
      set.exitCode === 0 && !(set.stdout + set.stderr).includes(KEY),
      `exit ${set.exitCode}: ${set.stdout.trim()}`,
    );

    const run = await step(
      "run",
      `echo CANARY > /tmp/canary.txt && echo CANARY > ~/canary.txt && echo MEMORY > ~/.local/share/tars/MEMORY.md && tars script run probe -- '$(whoami)' 'a;b' "it's"`,
    );
    const all = run.stdout + run.stderr;
    const lines = run.stdout.trim().split("\n");
    const report = lastJson(run.stdout);
    check(
      "run-exit",
      "the probe runs and exits 0",
      run.exitCode === 0,
      `exit ${run.exitCode}; stderr: ${run.stderr.slice(0, 300)}`,
    );
    check(
      "redact",
      "no form of the secret reaches tars's output",
      !all.includes(KEY) &&
        !all.includes(Buffer.from(KEY).toString("base64")) &&
        lines.slice(0, 4).every((l) => l.includes("[REDACTED]")),
      lines.slice(0, 4).join(" | "),
    );
    check(
      "argv",
      "arguments arrive unexpanded",
      JSON.stringify(report.argv) === JSON.stringify(["$(whoami)", "a;b", "it's"]),
      JSON.stringify(report.argv),
    );
    check(
      "net-allowed",
      "the host from the secret's url is reachable",
      report.allowed === 200,
      String(report.allowed),
    );
    check(
      "net-other",
      "another loopback port is refused",
      String(report.other).startsWith("DENIED"),
      String(report.other),
    );
    check(
      "home",
      "files in the real home and the data dir are unreadable",
      denied(report.home),
      JSON.stringify(report.home),
    );
    check(
      "canary",
      "the host /tmp is unreadable",
      String(report.canary).startsWith("DENIED"),
      String(report.canary),
    );
    check(
      "bus",
      "the private D-Bus is unreachable",
      String(report.bus).startsWith("DENIED"),
      String(report.bus),
    );
    check(
      "env",
      "only TARS_SECRET of tars's variables reaches the script",
      JSON.stringify(report.env) === '["TARS_SECRET"]',
      JSON.stringify(report.env),
    );

    check(
      "stderr",
      "the secret is masked on stderr too",
      !run.stderr.includes(KEY) && run.stderr.includes(`stderr ${"[REDACTED]"}`),
      run.stderr.trim().slice(0, 200),
    );
    const versionDir = join(host.home, ".local/share/tars/scripts/library/probe/versions/v1");
    check(
      "cwd",
      "the script runs in its own version directory",
      report.cwd === versionDir,
      String(report.cwd),
    );

    const outHome = await step("out-home", "tars script run probe --out ~ -- x");
    check(
      "out-home",
      "--out ~ is refused before the script runs",
      outHome.exitCode === 1 && outHome.stderr.includes("--out") && outHome.stdout === "",
      `exit ${outHome.exitCode}: ${outHome.stderr.trim()}`,
    );

    const project = `${host.home}/projects/app`;
    const outOk = await step(
      "out-ok",
      `mkdir -p ${project}/dl/.git/hooks && cd ${project} && TARS_LAUNCH_DIR=${project} tars script run probe --out dl -- x`,
    );
    const outReport = lastJson(outOk.stdout);
    const dl = join(host.fakeHome, "projects/app/dl");
    const written = existsSync(join(dl, "written.txt"))
      ? readFileSync(join(dl, "written.txt"), "utf8")
      : "(missing)";
    check(
      "out-ok",
      "a --out under the launch dir is writable, though its parent is hidden, and the script still runs in its version directory",
      outOk.exitCode === 0 && written === "from the sandbox" && outReport.cwd === versionDir,
      `exit ${outOk.exitCode}: written.txt ${JSON.stringify(written)}, cwd ${String(outReport.cwd)} ${outOk.stderr.slice(0, 200)}`,
    );
    const hookFile = join(dl, ".git/hooks/pre-commit");
    check(
      "out-git-hook",
      "inside --out, the script cannot write .git/hooks",
      String(outReport.hook).startsWith("DENIED") && !existsSync(hookFile),
      `hook write: ${String(outReport.hook)}; ${hookFile} exists: ${existsSync(hookFile)}; dl holds ${JSON.stringify(readdirSync(dl).toSorted())}`,
    );

    const sharedTmp = await step("shared-tmp", "mkdir /tmp/claude && tars script run probe -- x");
    check(
      "shared-tmp",
      "a host /tmp/claude, which sandbox-runtime would bind in, stops the run",
      sharedTmp.exitCode === 1 &&
        sharedTmp.stderr.includes("/tmp/claude") &&
        sharedTmp.stdout === "",
      `exit ${sharedTmp.exitCode}: ${sharedTmp.stderr.trim()}`,
    );

    const agyHome = `${host.home}/.local/share/tars/harness/agy-home`;
    const agy = await step(
      "run-agy-home",
      `mkdir -p ${agyHome} && HOME=${agyHome} TARS_DATA_DIR=${host.home}/.local/share/tars tars script run probe -- x`,
    );
    const agyReport = lastJson(agy.stdout);
    check(
      "agy-home",
      "with HOME pointing at agy's home, the real home stays unreadable",
      agy.exitCode === 0 && denied(agyReport.home),
      `exit ${agy.exitCode}: ${JSON.stringify(agyReport.home)} ${agy.stderr.slice(0, 200)}`,
    );

    const outSsh = await step(
      "out-ssh",
      `HOME=${agyHome} TARS_DATA_DIR=${host.home}/.local/share/tars TARS_LAUNCH_DIR=${host.home} tars script run probe --out ${host.home}/.ssh -- x`,
    );
    check(
      "out-ssh",
      "with HOME pointing at agy's home, --out <real home>/.ssh is refused",
      outSsh.exitCode === 1 && outSsh.stderr.includes("--out") && outSsh.stdout === "",
      `exit ${outSsh.exitCode}: ${outSsh.stderr.trim()}`,
    );

    const open = await step("open", "tars script run opener");
    check(
      "open-loopback",
      'domains "*" cannot reach this machine',
      open.exitCode === 0 && !open.stdout.includes(": 200"),
      `exit ${open.exitCode}: ${open.stdout.trim()} ${open.stderr.slice(0, 200)}`,
    );

    const timeout = await step("timeout", "tars script run probe --timeout 2 -- sleep 30");
    check(
      "timeout",
      "a script past --timeout ends with 124",
      timeout.exitCode === 124,
      `exit ${timeout.exitCode} after ${timeout.ms} ms`,
    );

    const kill = await step(
      "sigkill",
      `tars script run probe -- sleep 15 & A=$!
       sleep 3; echo "only-a $(pgrep -c socat)"
       tars script run probe -- sleep 30 & B=$!
       sleep 3; kill -9 $B; sleep 1
       echo "after-kill $(pgrep -c socat) orphans $(pgrep -fc '[s]cript.py sleep 30')"
       tars script run probe -- quick > /dev/null
       echo "after-next $(pgrep -c socat)"
       wait $A; echo "a-exit $?"
       echo "sockets-left $(ls /tmp | grep -cE 'claude-http|srt-mux')"`,
    );
    const count = (label: string) =>
      Number(new RegExp(`${label} (\\d+)`).exec(kill.stdout)?.[1] ?? -1);
    check(
      "sigkill",
      "a SIGKILLed run leaves no script behind; the next run removes its bridge and spares a running tars",
      count("only-a") > 0 &&
        count("after-kill") > count("only-a") &&
        count("orphans") === 0 &&
        count("after-next") === count("only-a") &&
        count("a-exit") === 5 &&
        count("sockets-left") === 0,
      kill.stdout.trim().replaceAll("\n", " | "),
    );

    const trial = await step(
      "trial",
      "tars script trial probe -- t && ls ~/.local/share/tars/scripts/pending/probe/trials",
    );
    const trialReport = lastJson(trial.stdout.split("\n").slice(0, -2).join("\n"));
    check(
      "trial",
      'trial gets no secret, cannot reach the "secret:url" host, and saves its output',
      trial.exitCode === 0 &&
        !trial.stdout.includes(KEY) &&
        String(trialReport.allowed).startsWith("DENIED") &&
        (trial.stdout.trim().split("\n").at(-1) ?? "").endsWith(".json"),
      `exit ${trial.exitCode}: allowed=${trialReport.allowed} ${trial.stderr.slice(0, 200)}`,
    );

    const lib = join(
      host.fakeHome,
      ".local/share/tars/scripts/library/probe/versions/v1/script.py",
    );
    writeFileSync(lib, `${PROBE}# tampered\n`);
    const tampered = await step("tampered", "tars script run probe -- x");
    check(
      "tampered",
      "a script changed after approval is refused",
      tampered.exitCode === 1 && tampered.stderr.includes("changed after approval"),
      `exit ${tampered.exitCode}: ${tampered.stderr.trim()}`,
    );
  } finally {
    for (const s of servers) s.stop(true);
  }
  printChecks(checks);
  return finishChecks(checks, work);
}

if (import.meta.main) process.exitCode = process.env[INNER] ? await inner() : outer();
