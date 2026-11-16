import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ApprovalRecord } from "../../src/features/script/library.ts";
import { approveSample } from "../features/script/sample.ts";
import { runDialog } from "./pty.ts";
import { finishChecks, printChecks, type Check, type Host } from "./sandbox.ts";
import { enterScriptNetns, lastJson, scriptHost } from "./script-host.ts";

const INNER = "TARS_E2E_SCRIPT_INNER";

const KEY = "E2E-FAKE-BARK-KEY-0123456789";
/** The run step's bus listens here, so the probe knows which live socket it must fail to reach. */
const PROBE_BUS = "tars-e2e-probe-bus";
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
    s = socket.socket(socket.AF_UNIX); s.connect("\\0${PROBE_BUS}"); return "CONNECTED"
secret = os.environ.get("TARS_SECRET", "")
key = json.loads(secret)["key"] if secret else ""
print(secret); print(key); print(urllib.parse.quote(key)); print(base64.b64encode(key.encode()).decode())
print("stderr", key, file=sys.stderr)
out = os.environ.get("TARS_OUT")
if out: open(os.path.join(out, "written.txt"), "w").write("from the sandbox")
def plant(rel):
    path = os.path.join(out, rel); os.makedirs(os.path.dirname(path), exist_ok=True); open(path, "w").write("x")
head = attempt(lambda: plant(".git/HEAD")) if out else None
hook = attempt(lambda: plant(".git/hooks/pre-commit")) if out else None
print(json.dumps({
  "cwd": os.getcwd(),
  "head": head,
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

const ZERO_DEP = `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "zero-dep"
# summary = "e2e script whose venv tars builds"
# effects = "read-only"
# args = ""
# outputs = "one line"
# exit = { 0 = "ok" }
# ///
import sys
print("zero-dep ran on", sys.prefix)
`;

const gated = (mark: string) => `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "gated"
# summary = "e2e script that goes through the three gates"
# secret = "fake-bark"
# domains = ["secret:url"]
# effects = "external-write"
# args = "<words> | sleep <seconds>"
# outputs = "one line"
# exit = { 0 = "ok", 3 = "no secret" }
# ///
import json, os, sys, time, urllib.parse, urllib.request
MARK = "gated ${mark}"
if sys.argv[1:2] == ["sleep"]:
    time.sleep(float(sys.argv[2])); print(MARK, "woke"); sys.exit(0)
secret = os.environ.get("TARS_SECRET")
if not secret:
    print(MARK, "no secret"); sys.exit(3)
s = json.loads(secret)
def tty():
    try: open("/dev/tty").close(); return "OPENED"
    except Exception as e: return "DENIED"
query = urllib.parse.urlencode({"key": s["key"], "argv": json.dumps(sys.argv[1:])})
status = urllib.request.urlopen(s["url"] + "/push?" + query, timeout=5).status
print(MARK, "pushed", status, "key", s["key"], "tty", tty(), "prefix", sys.prefix)
`;

const denied = (value: unknown) =>
  Array.isArray(value) && value.length > 0 && value.every((r) => String(r).startsWith("DENIED"));

function install(host: Host, name: string, source: string, lock = ""): string {
  const version = join(host.fakeHome, ".local/share/tars/scripts/library", name, "versions", "v1");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "script.py"), source);
  approveSample(version, source, lock);
  symlinkSync(join("versions", "v1"), join(version, "..", "..", "current"));
  return join(host.home, ".local/share/tars/scripts/library", name, "versions", "v1");
}

/** The lock `uv lock` writes for a script without dependencies; it needs no network. */
function zeroDepLock(uv: string, work: string): string {
  const dir = join(work, "zero-dep-lock");
  mkdirSync(dir);
  writeFileSync(join(dir, "script.py"), ZERO_DEP);
  const proc = Bun.spawnSync(
    [uv, "lock", "--script", join(dir, "script.py"), "--exclude-newer", "P7D", "--no-build"],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        UV_CACHE_DIR: join(dir, "cache"),
        UV_NO_CONFIG: "1",
        UV_PYTHON_DOWNLOADS: "never",
      },
    },
  );
  if (proc.exitCode !== 0) throw new Error(`uv lock failed: ${proc.stderr}`);
  return readFileSync(join(dir, "script.py.lock"), "utf8");
}

async function inner(): Promise<number> {
  const { host, uv, python, step, draft } = scriptHost("tars-e2e-script-");
  const { work } = host;
  const pushes: URLSearchParams[] = [];
  const servers = [ALLOWED_PORT, OTHER_PORT].map((port) =>
    Bun.serve({
      hostname: "::",
      port,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/push") pushes.push(url.searchParams);
        return new Response("ok");
      },
    }),
  );
  const checks: Check[] = [];
  const check = (id: string, claim: string, pass: boolean, evidence: string) =>
    checks.push({ id, claim, pass, evidence });
  try {
    const venvs = [install(host, "probe", PROBE), install(host, "opener", OPEN)].map(
      (v) => `python3 -m venv --without-pip ${v}/venv-${python}`,
    );
    const setup = await step("setup", venvs.join(" && "));
    if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.stderr}`);
    const zeroDep = install(host, "zero-dep", ZERO_DEP, zeroDepLock(uv, work));

    const set = await step("secret-set", "tars secret set fake-bark", {}, SECRET);
    check(
      "secret-set",
      "tars secret set reads stdin and never prints the value",
      set.exitCode === 0 && !(set.stdout + set.stderr).includes(KEY),
      `exit ${set.exitCode}: ${set.stdout.trim()}`,
    );

    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    const list = (path: string) => (existsSync(path) ? readdirSync(path) : ["(missing)"]);
    const pendingProbe = join(host.fakeHome, ".local/share/tars/scripts/pending/probe");
    const submitted = await step("submit", `tars script submit ${draft("probe", PROBE)}`);
    const current = join(pendingProbe, "current");
    check(
      "submit",
      "submit passes gate 1 offline for a script without dependencies, builds its venv, and ends with the command for the user",
      submitted.exitCode === 0 &&
        submitted.stdout.trim().split("\n").at(-1) === "tars script approve probe" &&
        existsSync(join(current, "gate1.json")) &&
        existsSync(join(current, `venv-${python}`, "pyvenv.cfg")) &&
        read(join(current, "script.py")) === PROBE,
      `exit ${submitted.exitCode}: ${submitted.stdout.trim().replaceAll("\n", " | ")} ${submitted.stderr.slice(0, 300)}`,
    );

    const refused = await step(
      "submit-refused",
      `tars script submit ${draft("probe-next", PROBE.replace(">=3.12", ">=9.0"))}`,
    );
    check(
      "submit-refused",
      "a draft gate 1 refuses exits 1, and the earlier submission stays the one under review",
      refused.exitCode === 1 &&
        refused.stderr.includes("gate 1: requires-python") &&
        refused.stdout === "" &&
        list(pendingProbe).length === 2 &&
        read(join(current, "script.py")) === PROBE,
      `exit ${refused.exitCode}: ${refused.stderr.trim().slice(0, 300)}; pending holds ${JSON.stringify(list(pendingProbe))}`,
    );

    const run = await step(
      "run",
      `echo CANARY > /tmp/canary.txt && echo CANARY > ~/canary.txt && echo MEMORY > ~/.local/share/tars/MEMORY.md && tars script run probe -- '$(whoami)' 'a;b' "it's"`,
      { DBUS_SESSION_BUS_ADDRESS: `unix:abstract=${PROBE_BUS}` },
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

    const fresh = await step(
      "out-fresh-git",
      `cd ${project} && TARS_LAUNCH_DIR=${project} tars script run probe --out fresh -- x`,
    );
    const freshReport = lastJson(fresh.stdout);
    const freshDir = join(host.fakeHome, "projects/app/fresh");
    const freshEntries = existsSync(freshDir) ? readdirSync(freshDir).toSorted() : [];
    const freshWritten = existsSync(join(freshDir, "written.txt"))
      ? readFileSync(join(freshDir, "written.txt"), "utf8")
      : "(missing)";
    check(
      "out-fresh-git",
      "inside a --out with no .git, the script cannot create .git/HEAD or .git/hooks, and no .git is left behind",
      fresh.exitCode === 0 &&
        String(freshReport.head).startsWith("DENIED") &&
        String(freshReport.hook).startsWith("DENIED") &&
        freshWritten === "from the sandbox" &&
        JSON.stringify(freshEntries) === '["written.txt"]',
      `exit ${fresh.exitCode}: written.txt ${JSON.stringify(freshWritten)}, head ${String(freshReport.head)}, hook ${String(freshReport.hook)}; fresh holds ${JSON.stringify(freshEntries)} ${fresh.stderr.slice(0, 200)}`,
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
      "tars script trial probe -- t && ls ~/.local/share/tars/scripts/pending/probe/current/trials",
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

    writeFileSync(join(host.fakeHome, "review.md"), "REVIEW-MARK: tried an empty title\n");
    const reviewed = await step(
      "review",
      "tars script review probe --report ~/review.md && tars script show probe --pending",
    );
    check(
      "review",
      "review attaches the report, and show --pending compares the script with the library and prints the trial and the report",
      reviewed.exitCode === 0 &&
        reviewed.stdout.includes("the same text as version v1") &&
        reviewed.stdout.includes('args: ["t"]') &&
        reviewed.stdout.includes("  | REVIEW-MARK: tried an empty title") &&
        !reviewed.stdout.includes("!!"),
      `exit ${reviewed.exitCode}: ${reviewed.stdout.split("\n").length} lines ${reviewed.stderr.slice(0, 300)}`,
    );

    const built = await step("venv-built", "tars script run zero-dep");
    const venv = join(zeroDep.replace(host.home, host.fakeHome), `venv-${python}`);
    check(
      "venv-built",
      "an approved script with a lock and no venv gets one built by uv, then runs in it",
      built.exitCode === 0 &&
        built.stdout.includes(`zero-dep ran on ${zeroDep}/venv-${python}`) &&
        existsSync(join(venv, "pyvenv.cfg")) &&
        readFileSync(join(venv, "pyvenv.cfg"), "utf8").includes("uv = "),
      `exit ${built.exitCode}: ${built.stdout.trim()} ${built.stderr.slice(0, 300)}`,
    );

    const CONFIRM = "Type probe to approve it";
    const noTty = await runDialog(host, {
      name: "approve-no-tty",
      command: "tars script approve probe",
      tty: false,
      turns: [],
    });
    check(
      "approve-no-tty",
      "approve without a controlling terminal exits 1 and asks nothing",
      noTty.exitCode === 1 && noTty.stderr.includes("/dev/tty") && noTty.stdout === "",
      `exit ${noTty.exitCode}: ${noTty.stderr.trim()}`,
    );

    const inSession = await runDialog(host, {
      name: "approve-in-session",
      command: "tars script approve probe",
      env: { TARS_IN_SESSION: "1" },
      tty: true,
      turns: [],
    });
    check(
      "approve-in-session",
      "approve with TARS_IN_SESSION set exits 1 before it touches the terminal",
      inSession.exitCode === 1 &&
        inSession.stderr.includes("outside the tars session") &&
        inSession.transcript === "",
      `exit ${inSession.exitCode}: ${inSession.stderr.trim()}; terminal showed ${JSON.stringify(inSession.transcript)}`,
    );

    const answer = (name: string, send: string) =>
      runDialog(host, {
        name,
        command: "tars script approve probe",
        tty: true,
        turns: [
          { expect: "Run it once with the real secret before deciding? [y/N] ", send: "n\n" },
          { expect: CONFIRM, send },
        ],
      });
    const wrong = await answer("approve-tty-wrong", "prob\n");
    const eof = await answer("approve-tty-eof", "\x04");
    check(
      "approve-tty",
      "the compiled tars shows the review and asks on /dev/tty, not stdout, and tells a typed line from end of input",
      [wrong, eof].every(
        (r) =>
          r.missed === undefined &&
          !r.timedOut &&
          r.exitCode === 1 &&
          r.stdout === "" &&
          r.transcript.includes("  | REVIEW-MARK: tried an empty title"),
      ) &&
        wrong.stderr.includes("name did not match") &&
        eof.stderr.includes("end of input"),
      [wrong, eof]
        .map((r) => `${r.name}: exit ${r.exitCode}, missed ${r.missed}, ${r.stderr.trim()}`)
        .join(" | "),
    );

    const scriptsDir = join(host.fakeHome, ".local/share/tars/scripts");
    const gatedHome = join(scriptsDir, "library/gated");
    const gatedPending = join(scriptsDir, "pending/gated");
    const V1 = gated("v1");
    const V2 = gated("v2");
    const currentVersion = () =>
      existsSync(join(gatedHome, "current"))
        ? (readlinkSync(join(gatedHome, "current")).split("/").at(-1) ?? "")
        : "";
    const approval = (version: string): ApprovalRecord =>
      JSON.parse(
        read(join(gatedHome, "versions", version, "approval.json")) ||
          '{"script":"","gate2":{"trials":[],"ignoredTrials":-1,"review":null},"gate3":{"liveRuns":[],"replaced":"(none)"}}',
      );
    const runLines = () =>
      read(join(gatedHome, "runs.jsonl"))
        .trim()
        .split("\n")
        .flatMap((line) => (line === "" ? [] : [JSON.parse(line) as { version: string }]));

    writeFileSync(join(host.fakeHome, "gated-review.md"), "GATED-REVIEW: no secret gives exit 3\n");
    const gates = await step(
      "gates-1-2",
      `tars script submit ${draft("gated", V1)} && { tars script trial gated -- t; echo "trial-exit $?"; } && tars script review gated --report ~/gated-review.md`,
    );
    const trialDir = join(gatedPending, "current", "trials");
    const v1Trials = existsSync(trialDir) ? readdirSync(trialDir) : [];
    const v1Trial = read(join(trialDir, v1Trials[0] ?? "none"));
    check(
      "gates-1-2",
      "a new script passes gate 1, its trial runs without the secret and sends nothing, and the report is attached",
      gates.exitCode === 0 &&
        gates.stdout.includes("submitted gated (a new script)") &&
        gates.stdout.includes("gated v1 no secret") &&
        gates.stdout.includes("trial-exit 3") &&
        v1Trials.length === 1 &&
        pushes.length === 0,
      `exit ${gates.exitCode}: ${gates.stdout.trim().replaceAll("\n", " | ")} ${gates.stderr.slice(0, 300)}; pushes ${pushes.length}`,
    );

    const LIVE = "Run it once with the real secret before deciding? [y/N] ";
    const flow = await runDialog(host, {
      name: "approve-flow",
      command: "tars script approve gated",
      tty: true,
      turns: [
        { expect: LIVE, send: "y\n" },
        { expect: "Arguments as a JSON array", send: '["hello", "", "two\\nlines"]\n' },
        { expect: "--out directory", send: "\n" },
        { expect: "Run it again? [y/N] ", send: "n\n" },
        { expect: "Type gated to approve it", send: "gated\n" },
      ],
    });
    const v1 = currentVersion();
    check(
      "approve-flow",
      "in a pty, approve shows the script, the trial and the report, runs it live, takes the name and exits 0 with one line on stdout",
      flow.exitCode === 0 &&
        flow.missed === undefined &&
        flow.stdout.trim() === `approved gated ${v1}` &&
        flow.transcript.includes('  | MARK = "gated v1"') &&
        flow.transcript.includes("trial 1:") &&
        flow.transcript.includes("  | GATED-REVIEW: no secret gives exit 3") &&
        flow.transcript.includes("gated v1 pushed 200") &&
        !flow.transcript.includes("!!"),
      `exit ${flow.exitCode}, missed ${flow.missed}, stdout ${JSON.stringify(flow.stdout)}, stderr ${flow.stderr.trim().slice(0, 300)}`,
    );
    check(
      "approve-live-run",
      "only the live run of gate 3 reaches the service, with the real key and the arguments as typed",
      pushes.length === 1 &&
        pushes[0]?.get("key") === KEY &&
        JSON.stringify(JSON.parse(pushes[0]?.get("argv") ?? "null")) ===
          JSON.stringify(["hello", "", "two\nlines"]),
      `${pushes.length} push(es): ${pushes.map((p) => p.get("argv")).join(" ; ")}`,
    );
    const flowAll = flow.transcript + flow.stdout + flow.stderr;
    const liveLine = (
      flow.transcript.split("\n").find((l) => l.includes("gated v1 pushed")) ?? "(no output line)"
    ).trim();
    check(
      "approve-redacted",
      "the live run's output is masked before it reaches the terminal",
      flow.transcript.includes("key [REDACTED]") && !flowAll.includes(KEY),
      liveLine,
    );
    const ttyControl = await runDialog(host, {
      name: "tty-control",
      command: `python3 -c 'open("/dev/tty").close(); print("OPENED")'`,
      tty: true,
      turns: [],
    });
    check(
      "approve-sandbox-tty",
      "the script under review cannot open the terminal the user answers on, which a process outside the sandbox can",
      liveLine.includes("tty DENIED") && ttyControl.stdout.trim() === "OPENED",
      `in the sandbox: ${liveLine}; outside it: ${ttyControl.stdout.trim()}${ttyControl.stderr.trim()}`,
    );
    const record = approval(v1);
    const staging = join(scriptsDir, "staging");
    check(
      "approve-installed",
      "the approved version holds the reviewed bytes and the record of the three gates; nothing is left pending or staged, and no package was approved",
      /^[0-9a-f]{16}$/.test(v1) &&
        read(join(gatedHome, "versions", v1, "script.py")) === V1 &&
        existsSync(join(gatedHome, "versions", v1, `venv-${python}`, "pyvenv.cfg")) &&
        record.script === new Bun.CryptoHasher("sha256").update(V1).digest("hex") &&
        record.gate2.trials.length === 1 &&
        record.gate2.review?.report.includes("GATED-REVIEW") === true &&
        record.gate3.liveRuns.length === 1 &&
        record.gate3.replaced === null &&
        !JSON.stringify(record).includes("hello") &&
        !existsSync(join(gatedPending, "current")) &&
        existsSync(staging) &&
        list(staging).length === 0 &&
        list(join(scriptsDir, "packages")).length === 0,
      `version ${v1}; gate2 trials ${record.gate2.trials.length}, live runs ${record.gate3.liveRuns.length}; pending holds ${JSON.stringify(list(gatedPending))}; staging exists ${existsSync(staging)}`,
    );

    const afterApprove = await step(
      "run-after-approve",
      'tars script run gated -- hi && tars script note gated "E2E-NOTE: keep me"',
    );
    check(
      "run-after-approve",
      "the approved script runs from its version directory, in the venv built during approve",
      afterApprove.exitCode === 0 &&
        afterApprove.stdout.includes("gated v1 pushed 200") &&
        afterApprove.stdout.includes(`/library/gated/versions/${v1}/venv-${python}`),
      `exit ${afterApprove.exitCode}: ${afterApprove.stdout.trim()} ${afterApprove.stderr.slice(0, 300)}`,
    );

    const tamper = await step(
      "gate1-mismatch-setup",
      `tars script submit ${draft("gated", V2)} && echo "# after gate 1" >> ~/.local/share/tars/scripts/pending/gated/current/script.py; tars script trial gated -- t`,
    );
    const mismatch = await runDialog(host, {
      name: "gate1-mismatch",
      command: "tars script approve gated",
      tty: true,
      turns: [],
    });
    check(
      "gate1-mismatch",
      "a script.py changed after gate 1 is refused by trial and by approve, which shows and installs nothing",
      tamper.exitCode === 1 &&
        tamper.stderr.includes("script.py changed after gate 1") &&
        !tamper.stdout.includes("gated v2") &&
        mismatch.exitCode === 1 &&
        mismatch.stderr.includes("script.py changed after gate 1") &&
        mismatch.transcript === "" &&
        currentVersion() === v1,
      `trial exit ${tamper.exitCode}: ${tamper.stderr.trim().slice(0, 200)} | approve exit ${mismatch.exitCode}: ${mismatch.stderr.trim().slice(0, 200)}; terminal showed ${JSON.stringify(mismatch.transcript.slice(0, 80))}`,
    );

    const resubmit = await step("update-submit", `tars script submit ${draft("gated", V2)}`);
    if (existsSync(join(gatedPending, "current"))) {
      mkdirSync(join(gatedPending, "current", "trials"), { recursive: true });
      writeFileSync(join(gatedPending, "current", "trials", "from-v1.json"), v1Trial);
    }
    const update = await runDialog(host, {
      name: "update",
      command: `tars script run gated -- sleep 6 > ~/slow.out 2>&1 & slow=$!
        until pgrep -f '[s]cript.py sleep 6' > /dev/null; do sleep 0.2; done
        tars script approve gated; code=$?
        wait $slow; echo "slow-exit $?" >> ~/slow.out; exit $code`,
      tty: true,
      turns: [
        { expect: LIVE, send: "n\n" },
        { expect: "Type gated to approve it", send: "gated\n" },
      ],
    });
    const v2 = currentVersion();
    const v2VenvReady = existsSync(join(gatedHome, "versions", v2, `venv-${python}`, "pyvenv.cfg"));
    const slow = read(join(host.fakeHome, "slow.out"));
    const afterUpdate = await step("run-after-update", "tars script run gated -- again");
    const updateWarnings = update.transcript.split("\n").filter((l) => l.startsWith("!!"));
    check(
      "stale-trial",
      "a trial of the earlier script.py counts for nothing in the review of the new one, and approve says so",
      resubmit.exitCode === 0 &&
        resubmit.stdout.includes(`updates version ${v1}`) &&
        updateWarnings.some((w) => w.includes("ignored 1 trial record(s)")) &&
        updateWarnings.some((w) => w.includes("no trial ran this script.py")) &&
        updateWarnings.some((w) => w.includes("no gate 2 report is attached")) &&
        approval(v2).gate2.trials.length === 0 &&
        approval(v2).gate2.ignoredTrials === 1,
      updateWarnings.join(" | "),
    );
    const notes = read(join(gatedHome, "NOTES.md"));
    const runs = runLines();
    check(
      "update-keeps-history",
      "an update shows the diff, moves current to a version whose venv is already built, and keeps the notes, the runs and the earlier version",
      update.exitCode === 0 &&
        update.missed === undefined &&
        v2 !== v1 &&
        v2VenvReady &&
        update.stdout.trim() === `approved gated ${v2}` &&
        update.transcript.includes('  | -MARK = "gated v1"') &&
        update.transcript.includes('  | +MARK = "gated v2"') &&
        approval(v2).gate3.replaced === v1 &&
        notes.includes("E2E-NOTE: keep me") &&
        runs[0]?.version === v1 &&
        read(join(gatedHome, "versions", v1, "script.py")) === V1,
      `exit ${update.exitCode}, missed ${update.missed}, ${v1} -> ${v2}, venv ready ${v2VenvReady}; runs ${runs.map((r) => r.version).join(",")}; notes ${JSON.stringify(notes.trim())}; ${update.stderr.trim().slice(0, 200)}`,
    );
    check(
      "update-during-run",
      "a run that started before the update finishes on the whole earlier version; the next run gets the new one",
      slow.includes("gated v1 woke") &&
        !slow.includes("gated v2") &&
        slow.includes("slow-exit 0") &&
        runs.filter((r) => r.version === v1).length === 2 &&
        afterUpdate.exitCode === 0 &&
        afterUpdate.stdout.includes("gated v2 pushed 200") &&
        runLines().at(-1)?.version === v2,
      `slow run: ${slow.trim().replaceAll("\n", " | ")}; next run: ${afterUpdate.stdout.trim().slice(0, 80)}; runs ${runLines()
        .map((r) => r.version)
        .join(",")}`,
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

if (import.meta.main)
  process.exitCode = process.env[INNER]
    ? await inner()
    : enterScriptNetns(import.meta.path, INNER, "e2e:script");
