// End-to-end suite for `tars claude` and `tars agy`. Run with `bun run e2e`; `--help` explains it.
// Not part of `bun test`: no file here matches bun's test-file patterns (*.test.ts, *.spec.ts, ...).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { startFakeApi, TOOL_USE_ID, type Captured, type Reply } from "./fake-api.ts";
import {
  CLAUDE_LEAKS,
  diffSnapshots,
  GEMINI_LEAKS,
  layout,
  MEMORY,
  onHost,
  SENTINEL,
  SIDE_EFFECTS,
  snapshotUserConfig,
  SOUL,
  writeFixtures,
} from "./fixtures.ts";
import {
  binaryDirsFor,
  EXIT_SKIP,
  HARNESSES,
  missingPrerequisites,
  namespacesWork,
  overrideVar,
  reexecInNetns,
  resolveHarness,
  runStep,
  type Harness,
  type Host,
  type Step,
  type StepResult,
} from "./sandbox.ts";

const HELP = `Usage: bun run e2e   (builds dist/tars, then runs test/e2e/run.ts)

Runs the built dist/tars against the real claude and agy binaries inside a sandbox:
a loopback-only network namespace, bwrap with a fake home mounted over $HOME, fresh /tmp
and /run, and a private dbus-daemon plus gnome-keyring. A fake model API on loopback
captures every request. Nothing reaches the real home, the real keyring, or a provider.

Environment:
  ${overrideVar("claude")}=<path>  claude binary to test (default: claude on PATH)
  ${overrideVar("agy")}=<path>     agy binary to test (default: agy on PATH)
  TARS_E2E_KEEP=1                  keep the scratch dir even when every check passes

Exit codes:
  0   every check passed
  1   a check failed, or the suite could not run (dist/tars missing, sandbox broke)
  2   usage error
  ${EXIT_SKIP}  skipped: a prerequisite is missing (bwrap, unshare, ip, dbus-daemon, dbus-send,
      gnome-keyring-daemon, secret-tool, claude, agy) or user namespaces are disabled`;

const INNER = "TARS_E2E_INNER";
/** What the sandbox's own dbus-daemon and gnome-keyring create in the fresh XDG_RUNTIME_DIR. */
const PRIVATE_RUNTIME_ENTRIES = ["dbus-1", "keyring"];
const ROOT = join(import.meta.dir, "..", "..");
const TARS_BIN = join(ROOT, "dist", "tars");

const CLAUDE_TOKEN = "sk-ant-oat01-E2E-FAKE-TOKEN";
const PARENT_API_KEY = "sk-ant-api03-E2E-FAKE-PARENT-KEY";
const GEMINI_KEY = "e2e-fake-gemini-key";
const GOOGLE_LOGIN = JSON.stringify({
  token: {
    access_token: "E2E_FAKE_GOOGLE_ACCESS",
    token_type: "Bearer",
    refresh_token: "E2E_FAKE_GOOGLE_REFRESH",
    expiry: "2099-01-01T00:00:00Z",
  },
  email: "e2e@example.invalid",
  auth_method: "consumer",
});
// What a parent Claude Code session exports: "cli" is the interactive value; the dummy
// entrypoint shows whether the child adopts whatever value it inherits.
const SESSION_MARKERS = {
  dummy: {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "e2e-parent-entrypoint",
    CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-0000000e2e00",
  },
  interactive: {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-0000000e2e01",
  },
} as const;
const PROMPT = "Reply with OK.";
const remember = (id: string, text: string) =>
  `tars memory remember --id ${id} --section 偏好 --text '${text}' --source user`;
const WRITEBACK = {
  claude: { id: "e2e-x", text: "E2E_WRITEBACK_CLAUDE" },
  agy: { id: "e2e-y", text: "E2E_WRITEBACK_AGY" },
} as const;
// The narrowest grants found: without them claude -p answers the Bash call with "This command
// requires approval", and agy --print auto-denies run_command ("--mode auto" is refused).
const CLAUDE_ALLOW = ["--allowedTools", "Bash(tars memory remember:*)"];
// modelProvider routes agy to GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL, the fake API.
const agyPrint = (permissions?: { allow: string[] }) => [
  "--print-timeout",
  "90s",
  "--settings",
  JSON.stringify({ modelProvider: "gemini", ...(permissions && { permissions }) }),
];
const AGY_PRINT = agyPrint();
const AGY_ALLOW = { allow: ["command(tars memory remember)"] };

interface Check {
  readonly id: string;
  readonly claim: string;
  readonly pass: boolean;
  readonly evidence: string;
}

interface Observation {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

function outer(): number {
  const missing = missingPrerequisites(process.env);
  if (missing.length > 0) {
    console.error(`e2e: SKIP, missing prerequisites: ${missing.join(", ")}`);
    return EXIT_SKIP;
  }
  if (!namespacesWork()) {
    console.error("e2e: SKIP, unprivileged user or network namespaces are disabled (unshare -rn)");
    return EXIT_SKIP;
  }
  if (!existsSync(TARS_BIN)) {
    console.error(`e2e: ${TARS_BIN} is missing; run: bun run e2e (it builds first)`);
    return 1;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, [INNER]: "1" };
  for (const harness of HARNESSES) env[overrideVar(harness)] = resolveHarness(harness, process.env);
  return reexecInNetns(import.meta.path, env) ?? 1;
}

async function inner(): Promise<number> {
  const started = performance.now();
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("HOME must be an absolute path");
  const work = mkdtempSync(join(tmpdir(), "tars-e2e-"));
  const api = startFakeApi();
  const bins = {
    claude: resolveHarness("claude", process.env),
    agy: resolveHarness("agy", process.env),
  };
  if (!bins.claude || !bins.agy) throw new Error("harness binaries vanished after the outer check");
  const host: Host = {
    uid: process.getuid?.() ?? 0,
    user: process.env.USER || userInfo().username,
    home,
    work,
    fakeHome: join(work, "home"),
    bin: join(work, "bin"),
    binaryDirs: binaryDirsFor([bins.claude, bins.agy]),
    apiUrl: api.url,
  };
  mkdirSync(host.bin, { recursive: true });
  copyFileSync(TARS_BIN, join(host.bin, "tars"));
  chmodSync(join(host.bin, "tars"), 0o755);
  symlinkSync(bins.claude, join(host.bin, "claude"));
  symlinkSync(bins.agy, join(host.bin, "agy"));
  writeFixtures(host);

  const suite = new Suite(host, api);
  try {
    await suite.run();
  } catch (err) {
    console.error(`e2e: the suite broke: ${(err as Error).stack}\nscratch dir kept: ${work}`);
    return 1;
  } finally {
    api.stop();
  }
  const failed = suite.checks.filter((c) => !c.pass);
  writeFileSync(
    join(work, "report.json"),
    `${JSON.stringify({ checks: suite.checks, observations: suite.observations }, null, 2)}\n`,
  );
  printReport(suite.checks, suite.observations);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${suite.checks.length - failed.length}/${suite.checks.length} checks passed in ${seconds}s`,
  );
  if (failed.length > 0 || process.env.TARS_E2E_KEEP === "1")
    console.log(`scratch dir kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
  return failed.length > 0 ? 1 : 0;
}

class Suite {
  readonly checks: Check[] = [];
  readonly observations: Observation[] = [];
  private readonly l;

  constructor(
    private readonly host: Host,
    private readonly api: ReturnType<typeof startFakeApi>,
  ) {
    this.l = layout(host);
  }

  check(id: string, claim: string, pass: boolean, evidence: string) {
    this.checks.push({ id, claim, pass, evidence });
  }

  observe(id: string, question: string, answer: string) {
    this.observations.push({ id, question, answer });
  }

  /** Runs a step with the fake API set to `reply`, and saves its output and requests to the scratch dir. */
  async step(step: Step, reply: Reply = { kind: "text" }): Promise<Run> {
    const requests = this.api.begin(reply);
    const result = await runStep(this.host, step);
    const dir = join(this.host.work, "steps", step.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stdout.txt"), result.stdout);
    writeFileSync(join(dir, "stderr.txt"), result.stderr);
    writeFileSync(join(dir, "requests.jsonl"), requests.map((r) => JSON.stringify(r)).join("\n"));
    writeFileSync(join(dir, "exit.txt"), `${result.exitCode}\n${result.ms}ms\n`);
    return { result, requests, files: `steps/${step.name}` };
  }

  claudeEnv(extra: Record<string, string> = {}) {
    return { ANTHROPIC_BASE_URL: this.host.apiUrl, ...extra };
  }

  agyEnv() {
    return { GEMINI_API_KEY: GEMINI_KEY, GOOGLE_GEMINI_BASE_URL: this.host.apiUrl };
  }

  async run() {
    await this.sandboxSelfCheck();
    await this.controls();
    const userConfig = snapshotUserConfig(this.host);

    await this.setup();
    await this.claude();
    await this.claudeInteractive();
    await this.agy();

    const changes = diffSnapshots(userConfig, snapshotUserConfig(this.host));
    this.check(
      "r45-no-user-writes",
      "tars runs leave the user's ~/.claude, ~/.claude.json, ~/.gemini, ~/.config, ~/.agents untouched",
      changes.length === 0,
      changes.length === 0 ? "content hashes equal before and after" : changes.join("; "),
    );
    const side = readdirSync(this.l.side);
    this.check(
      "r45-no-user-hooks-mcp",
      "no user hook or MCP server ran during any tars run",
      side.length === 0,
      side.length === 0 ? `${this.l.side} stayed empty` : `ran: ${side.join(", ")}`,
    );
  }

  async sandboxSelfCheck() {
    const script = `echo "route4=$(tail -n +2 /proc/net/route | wc -l)"
echo "route6=$(grep -vc ' lo$' /proc/net/ipv6_route)"
getent hosts api.anthropic.com >/dev/null 2>&1; echo "dns=$?"
echo "home=$(cat "$HOME/.tars-e2e-fake-home")"
for d in /run/dbus /run/systemd/resolve /run/avahi-daemon; do [ -e "$d" ] && echo "visible=$d"; done
echo "runuser=$(ls -A "$XDG_RUNTIME_DIR" | tr '\\n' ' ')"`;
    const { result, files } = await this.step({
      name: "sandbox-self-check",
      argv: ["/bin/sh", "-c", script],
      cwd: this.host.home,
    });
    const out = result.stdout;
    const value = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
    const runUser = (value("runuser") ?? "").split(" ").filter(Boolean);
    this.check(
      "sandbox",
      "sandbox has no route off loopback, no DNS, the fake home at $HOME, and none of the host's /run sockets",
      result.exitCode === 0 &&
        value("route4") === "0" &&
        value("route6") === "0" &&
        value("dns") !== "0" &&
        value("home") === "fake" &&
        !out.includes("visible=") &&
        runUser.every((name) => PRIVATE_RUNTIME_ENTRIES.includes(name)),
      `${files}/stdout.txt: ${out.trim().replaceAll("\n", ", ")}`,
    );
  }

  /** The user's own config, run without tars, so that each planted sentinel is shown to be detectable. */
  async controls() {
    await this.control(
      {
        name: "control-claude",
        argv: ["claude", "-p", PROMPT],
        cwd: this.l.scratchDir,
        env: this.claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN }),
      },
      CLAUDE_LEAKS,
      [SIDE_EFFECTS.claudeHook, SIDE_EFFECTS.claudeMcp],
    );
    await this.control(
      {
        name: "control-agy",
        argv: ["agy", "--print", PROMPT, ...AGY_PRINT],
        cwd: this.l.scratchDir,
        env: this.agyEnv(),
      },
      GEMINI_LEAKS,
      [SIDE_EFFECTS.geminiHook, SIDE_EFFECTS.geminiMcp],
    );
  }

  async control(step: Step, leaks: Readonly<Record<string, string>>, effects: readonly string[]) {
    const run = await this.step(step);
    const text = run.requests.map(textOf).join("\n");
    const side = readdirSync(this.l.side);
    const missing = [
      ...Object.entries(leaks)
        .filter(([, sentinel]) => !text.includes(sentinel))
        .map(([where]) => where),
      ...effects.filter((effect) => !side.includes(effect)),
    ];
    this.check(
      step.name,
      `${step.argv[0]} without tars, on the fake home, loads every planted user sentinel, hook, and MCP server`,
      missing.length === 0,
      missing.length === 0
        ? `${run.files}/requests.jsonl has all ${Object.keys(leaks).length} sentinels; side files: ${side.join(", ")}`
        : `missing: ${missing.join(", ")}`,
    );
    clearSide(this.l.side);
  }

  async setup() {
    const install = await this.step({
      name: "tars-install",
      argv: ["tars", "install", "--soul", this.l.soulFixture, "--memory", this.l.memoryFixture],
      cwd: this.host.home,
    });
    await this.onPath();
    const auth = await this.step({
      name: "tars-auth-claude",
      argv: ["tars", "auth", "claude"],
      cwd: this.host.home,
      stdin: `${CLAUDE_TOKEN}\n`,
    });
    // agy reads the user's Google login from the keyring as service=gemini username=antigravity.
    const plant = await this.step({
      name: "plant-google-login",
      argv: [
        "sh",
        "-c",
        'printf %s "$1" | secret-tool store --label=e2e service gemini username antigravity',
        "sh",
        GOOGLE_LOGIN,
      ],
      cwd: this.host.home,
    });
    this.check(
      "setup",
      "tars install and tars auth claude succeed inside the sandbox; the fake Google login is planted",
      install.result.exitCode === 0 && auth.result.exitCode === 0 && plant.result.exitCode === 0,
      `exit codes ${install.result.exitCode}/${auth.result.exitCode}/${plant.result.exitCode}; ${auth.files}/stdout.txt: ${auth.result.stdout.trim()}`,
    );
  }

  /** install copied dist/tars into ~/.local/bin, which the sandbox PATH lacks, so it must write the startup files. */
  async onPath() {
    const installed = join(this.host.home, ".local", "bin", "tars");
    const shells = await this.step({
      name: "tars-on-path",
      // Starts without the sandbox bin dir, and sources ~/.profile directly: this host's
      // /etc/profile.d appends ~/.local/bin to every login PATH, which would hide a missing line.
      argv: [
        "env",
        "PATH=/usr/bin:/bin",
        "sh",
        "-c",
        '(. "$HOME/.profile" && command -v tars) && zsh -c "command -v tars"',
      ],
      cwd: this.host.home,
    });
    const same =
      existsSync(onHost(this.host, installed)) &&
      readFileSync(onHost(this.host, installed)).equals(readFileSync(join(this.host.bin, "tars")));
    const found = shells.result.stdout.trim().split("\n");
    this.check(
      "install-on-path",
      "tars install copies the built tars to ~/.local/bin; from a PATH without it, sh after ~/.profile and a non-interactive zsh both find it there",
      shells.result.exitCode === 0 &&
        same &&
        found.length === 2 &&
        found.every((p) => p === installed),
      `same bytes as dist/tars: ${same}; ${shells.files}/stdout.txt: ${found.join(", ")}`,
    );
  }

  /**
   * Interactive claude runs a first-run flow, login screen included, on a config dir it has not
   * seen, whatever CLAUDE_CODE_OAUTH_TOKEN says. -p skips that flow, so this needs a pty.
   */
  async claudeInteractive() {
    const screen = async (name: string, argv: string, env: Record<string, string>) => {
      const run = await this.step({
        name,
        argv: ["script", "-q", "-c", argv, "/dev/null"],
        cwd: this.l.launchDir,
        env: this.claudeEnv({ TERM: "xterm-256color", ...env }),
        timeoutMs: 10_000,
      });
      // The TUI draws with cursor moves instead of spaces, so compare with all whitespace removed.
      const text = Bun.stripANSI(run.result.stdout);
      return { run, text: text.replace(/\s+/g, "") };
    };
    const FIRST_RUN = "WelcometoClaudeCode";
    const TRUST = "Itrustthisfolder";
    const control = await screen("control-claude-interactive", "claude", {
      CLAUDE_CONFIG_DIR: join(this.l.scratchDir, "fresh-claude-config"),
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
    });
    const tars = await screen("tars-claude-interactive", "tars claude", {});
    this.check(
      "claude-interactive-no-login",
      "interactive tars claude skips Claude Code's first-run login and reaches the folder trust prompt; plain claude on a fresh config dir does not",
      control.text.includes(FIRST_RUN) &&
        !tars.text.includes(FIRST_RUN) &&
        tars.text.includes(TRUST),
      `${control.run.files}/stdout.txt first-run: ${control.text.includes(FIRST_RUN)}; ${tars.run.files}/stdout.txt first-run: ${tars.text.includes(FIRST_RUN)}, trust prompt: ${tars.text.includes(TRUST)}`,
    );
  }

  async claude() {
    const settingsPath = onHost(
      this.host,
      join(this.l.dataDir, "harness", "claude", "settings.json"),
    );
    const settingsBefore = readFileSync(settingsPath, "utf8");
    const plain = await this.step({
      name: "tars-claude",
      argv: ["tars", "claude", "--", "-p", PROMPT],
      cwd: this.l.launchDir,
      env: this.claudeEnv({ ANTHROPIC_API_KEY: PARENT_API_KEY }),
    });
    const settingsAfter = readFileSync(settingsPath, "utf8");
    this.observe(
      "claude-settings-write",
      "Does Claude Code write to $CLAUDE_CONFIG_DIR/settings.json during a run?",
      settingsBefore === settingsAfter
        ? "observed: no, byte-identical before and after tars-claude"
        : `observed: yes. before ${JSON.stringify(settingsBefore)} after ${JSON.stringify(settingsAfter)}`,
    );
    const main = plain.requests.find(offersClaudeTool);
    const system = main ? systemOf(main) : "";
    this.check(
      "claude-runs",
      "tars claude -- -p exits 0 and sends a model request",
      plain.result.exitCode === 0 && main !== undefined,
      `${plain.files}: exit ${plain.result.exitCode}, ${plain.requests.length} requests`,
    );
    for (const [label, content] of [
      ["SOUL.md", SOUL],
      ["MEMORY.md", MEMORY],
    ] as const) {
      const block = `<tars-file label="${label}" sha256="${sha256(content)}">\n${content}</tars-file>`;
      this.check(
        `claude-system-${label}`,
        `system prompt carries the ${label} block with its sentinel and sha256`,
        system.includes(block),
        `${plain.files}/requests.jsonl main request .system: ${system.includes(block) ? "contains" : "lacks"} ${block.split("\n")[0]}`,
      );
    }
    this.check(
      "claude-sha-logged",
      "tars logs the sha256 of SOUL.md and MEMORY.md to stderr",
      plain.result.stderr.includes(`${sha256(SOUL)}  SOUL.md`) &&
        plain.result.stderr.includes(`${sha256(MEMORY)}  MEMORY.md`),
      `${plain.files}/stderr.txt`,
    );
    this.sessionChecks("claude", plain, CLAUDE_LEAKS, [
      "the launch dir's .claude/skills",
      SENTINEL.projectClaudeSkill,
    ]);
    const turns = plain.requests.filter(isClaudeTurn);
    const badAuth = turns.filter(
      (r) =>
        r.headers.authorization !== `Bearer ${CLAUDE_TOKEN}` ||
        r.headers["x-api-key"] !== undefined,
    );
    this.check(
      "claude-auth",
      "every model request sends Authorization: Bearer <keyring token> and no x-api-key, though ANTHROPIC_API_KEY is set",
      turns.length > 0 && badAuth.length === 0,
      `${plain.files}/requests.jsonl headers of ${turns.length} /v1/messages requests: ${badAuth.length === 0 ? "all Bearer token" : `${badAuth.length} differ`}`,
    );

    for (const [kind, markers] of Object.entries(SESSION_MARKERS)) {
      const marked = await this.step({
        name: `tars-claude-markers-${kind}`,
        argv: ["tars", "claude", "--", "-p", PROMPT],
        cwd: this.l.launchDir,
        env: this.claudeEnv(markers),
      });
      this.observe(
        `claude-session-markers-${kind}`,
        `Does a parent's ${Object.entries(markers)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")} change the child claude?`,
        compareRuns(plain, marked, markers.CLAUDE_CODE_SESSION_ID),
      );
    }

    const atWorkspace = await this.step({
      name: "tars-claude-at-workspace",
      argv: [
        "tars",
        "claude",
        "--",
        "-p",
        PROMPT,
        "--debug-file",
        join(this.l.logs, "claude-at-workspace.debug"),
      ],
      cwd: this.l.workspace,
      env: this.claudeEnv(),
    });
    this.observe(
      "claude-add-dir-workspace",
      "Is --add-dir <workspace> harmful when claude starts in the workspace?",
      describeAtWorkspace(atWorkspace, this.l.workspace),
    );

    // Last: it changes MEMORY.md, which the runs above compare against.
    const { id, text } = WRITEBACK.claude;
    const memory = await this.step(
      {
        name: "tars-claude-memory",
        argv: ["tars", "claude", "--", "-p", "Remember that I like e2e checks.", ...CLAUDE_ALLOW],
        cwd: this.l.launchDir,
        env: this.claudeEnv(),
      },
      { kind: "run", command: remember(id, text) },
    );
    this.writeBack("claude", memory, id, text);
  }

  async agy() {
    const plain = await this.step({
      name: "tars-agy",
      argv: [
        "tars",
        "agy",
        "--",
        "--print",
        PROMPT,
        ...AGY_PRINT,
        "--log-file",
        join(this.l.logs, "tars-agy.log"),
      ],
      cwd: this.l.launchDir,
      env: this.agyEnv(),
    });
    const main = plain.requests.find(offersShellTool);
    const system = main ? systemOf(main) : "";
    this.check(
      "agy-runs",
      "tars agy -- --print exits 0 and sends a model request",
      plain.result.exitCode === 0 && main !== undefined,
      `${plain.files}: exit ${plain.result.exitCode}, ${plain.requests.length} requests`,
    );
    for (const [label, sentinel] of [
      ["SOUL.md", SENTINEL.soul],
      ["MEMORY.md", SENTINEL.memory],
    ] as const) {
      this.check(
        `agy-system-${label}`,
        `systemInstruction carries the ${label} sentinel`,
        system.includes(sentinel),
        `${plain.files}/requests.jsonl main request .systemInstruction: ${system.includes(sentinel) ? "has" : "lacks"} ${sentinel}`,
      );
    }
    this.sessionChecks("agy", plain, GEMINI_LEAKS, [
      "the launch dir's AGENTS.md",
      SENTINEL.projectAgentsMd,
    ]);

    const { id, text } = WRITEBACK.agy;
    const memory = await this.step(
      {
        name: "tars-agy-memory",
        argv: [
          "tars",
          "agy",
          "--",
          "--print",
          "Remember that I like e2e checks.",
          ...agyPrint(AGY_ALLOW),
        ],
        cwd: this.l.launchDir,
        env: this.agyEnv(),
      },
      { kind: "run", command: remember(id, text) },
    );
    this.writeBack("agy", memory, id, text);

    const atWorkspace = await this.step({
      name: "tars-agy-at-workspace",
      argv: [
        "tars",
        "agy",
        "--",
        "--print",
        PROMPT,
        ...AGY_PRINT,
        "--log-file",
        join(this.l.logs, "tars-agy-at-workspace.log"),
      ],
      cwd: this.l.workspace,
      env: this.agyEnv(),
    });
    this.observe(
      "agy-add-dir-workspace",
      "Is --add-dir <workspace> harmful when agy starts in the workspace?",
      describeAtWorkspace(atWorkspace, this.l.workspace),
    );
    this.observe(
      "upstream-json",
      "Does tars-skills/upstream.json at the skills root cause a warning?",
      this.upstreamWarnings(),
    );
  }

  /** Isolation, skills, and r44 checks that read the same way for both harnesses. */
  sessionChecks(
    harness: Harness,
    run: Run,
    leaks: Readonly<Record<string, string>>,
    [launchLabel, launchSentinel]: readonly [string, string],
  ) {
    const all = run.requests.map(textOf).join("\n");
    const leaked = Object.entries(leaks).filter(([, sentinel]) => all.includes(sentinel));
    this.check(
      `${harness}-no-user-config`,
      `no request carries ${Object.keys(leaks).join(", ")}`,
      leaked.length === 0,
      `${run.files}/requests.jsonl, all ${run.requests.length} requests: ${leaked.length === 0 ? "no leak sentinel" : `leaked ${leaked.map(([where]) => where).join(", ")}`}`,
    );
    const main = run.requests.find(harness === "claude" ? offersClaudeTool : offersShellTool);
    const mainText = main ? textOf(main) : "";
    const missing = tarsSkillDescriptions().filter(([, d]) => !mainText.includes(d));
    this.check(
      `${harness}-tars-skills`,
      "the main request lists the tars skills memory and tars-mode",
      main !== undefined && missing.length === 0,
      `${run.files}/requests.jsonl main request: ${missing.length === 0 ? "both descriptions present" : `missing ${missing.map(([name]) => name).join(", ")}`}`,
    );
    this.check(
      `${harness}-launch-dir`,
      `${launchLabel} loads (r44)`,
      mainText.includes(launchSentinel),
      `${run.files}/requests.jsonl main request: ${mainText.includes(launchSentinel) ? "has" : "lacks"} ${launchSentinel}`,
    );
  }

  writeBack(harness: Harness, run: Run, id: string, text: string) {
    const memory = readFileSync(onHost(this.host, join(this.l.dataDir, "MEMORY.md")), "utf8");
    const entry = new RegExp(
      `## 偏好\\n[\\s\\S]*<!-- id: ${id} \\| observed: \\d{4}-\\d{2}-\\d{2} \\| status: active \\| source: user -->\\n- ${text}\\n`,
    );
    const result = toolResult(run.requests);
    this.check(
      `${harness}-memory-writeback`,
      `a tool call inside the ${harness} session runs tars memory remember and the data dir's MEMORY.md gains the entry`,
      run.result.exitCode === 0 && entry.test(memory) && result.includes(`added ${id}`),
      `exit ${run.result.exitCode}; MEMORY.md ${entry.test(memory) ? "has" : "lacks"} ${id} under 偏好; tool result in ${run.files}/requests.jsonl: ${JSON.stringify(result.split("\n").find((line) => line.includes("added")) ?? result.slice(0, 160))}`,
    );
  }

  upstreamWarnings(): string {
    const steps = join(this.host.work, "steps");
    const sources: [string, string][] = readdirSync(steps).map((name) => [
      `steps/${name}/stderr.txt`,
      readFileSync(join(steps, name, "stderr.txt"), "utf8"),
    ]);
    for (const name of readdirSync(this.l.logs))
      sources.push([`logs/${name}`, readFileSync(join(this.l.logs, name), "utf8")]);
    const hits = sources.flatMap(([file, text]) =>
      text
        .split("\n")
        .filter((line) => /upstream/i.test(line))
        .map((line) => `${file}: ${line.trim().slice(0, 200)}`),
    );
    return hits.length === 0
      ? `observed: no line mentions upstream in ${sources.length} stderr and log files (claude --debug-file and agy --log-file included)`
      : `observed: ${hits.join(" | ")}`;
  }
}

function clearSide(dir: string) {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every string inside a JSON value, so that escaping in the wire format does not hide a match. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) strings(item, out);
  return out;
}

function textOf(request: Captured): string {
  const json = parseJson(request.body);
  return json === undefined ? request.body : strings(json).join("\n");
}

function field(request: Captured, key: string): unknown {
  const json = parseJson(request.body);
  return typeof json === "object" && json !== null
    ? (json as Record<string, unknown>)[key]
    : undefined;
}

const isClaudeTurn = (r: Captured) => r.method === "POST" && /\/v1\/messages(\?|$)/.test(r.path);
const toolNames = (r: Captured) => strings(field(r, "tools")).join("\n");
const offersClaudeTool = (r: Captured) => isClaudeTurn(r) && /\bBash\b/.test(toolNames(r));
const offersShellTool = (r: Captured) =>
  r.path.includes("enerateContent") && toolNames(r).includes("run_command");
const systemOf = (r: Captured) =>
  strings(field(r, "system") ?? field(r, "systemInstruction")).join("\n");

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

/** The output the harness sent back for the fake tool call, from the follow-up request. */
function toolResult(requests: readonly Captured[]): string {
  for (const request of requests.toReversed()) {
    const results = [
      ...list(field(request, "messages"))
        .flatMap((turn) => list(turn.content))
        .filter((block) => block.tool_use_id === TOOL_USE_ID)
        .map((block) => block.content),
      ...list(field(request, "contents"))
        .flatMap((turn) => list(turn.parts))
        .map((part) => part.functionResponse)
        .filter((response) => response !== undefined),
    ];
    if (results.length > 0) return strings(results).join("\n");
  }
  return "(no follow-up request with a tool result)";
}

function tarsSkillDescriptions(): [string, string][] {
  return ["memory", "tars-mode"].map((name) => {
    const text = readFileSync(join(ROOT, "tars-skills", name, "SKILL.md"), "utf8");
    const description = text.match(/^description: (.*)$/m)?.[1] ?? `<no description in ${name}>`;
    return [name, description.slice(0, 40)];
  });
}

interface Run {
  readonly result: StepResult;
  readonly requests: Captured[];
  readonly files: string;
}

/** Lines of `other` that `base` lacks, so volatile ids aside, only what the change caused shows. */
function newLines(base: string, other: string): string[] {
  const seen = new Set(base.split("\n"));
  return other
    .split("\n")
    .filter((line) => line.trim() !== "" && !seen.has(line))
    .map((line) => line.slice(0, 120));
}

function compareRuns(base: Run, other: Run, parentSessionId: string): string {
  const a = base.requests.find(offersClaudeTool);
  const b = other.requests.find(offersClaudeTool);
  const header = (r: Captured | undefined, key: string) => r?.headers[key] ?? "(none)";
  const turns = (run: Run) => run.requests.filter(isClaudeTurn).length;
  const facts = [
    `exit ${base.result.exitCode} vs ${other.result.exitCode}`,
    `model requests ${turns(base)} vs ${turns(other)}`,
    `session id reused from parent: ${header(b, "x-claude-code-session-id") === parentSessionId}`,
    `user-agent ${header(a, "user-agent")} vs ${header(b, "user-agent")}`,
    `new system prompt lines ${JSON.stringify(a && b ? newLines(systemOf(a), systemOf(b)) : "n/a")}`,
    `new message lines ${JSON.stringify(a && b ? newLines(textOf(a), textOf(b)).filter((l) => !l.startsWith("{")) : "n/a")}`,
    `new stderr lines ${JSON.stringify(newLines(base.result.stderr, other.result.stderr))}`,
  ];
  return `observed (${base.files} vs ${other.files}): ${facts.join("; ")}`;
}

function describeAtWorkspace(run: Run, workspace: string): string {
  const main = run.requests.find((r) => offersClaudeTool(r) || offersShellTool(r));
  const text = main ? textOf(main) : "";
  const listed = text.match(new RegExp(`^\\s*- ${RegExp.escape(workspace)}$`, "gm"))?.length ?? 0;
  const stderr = run.result.stderr
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^[0-9a-f]{64} {2}/.test(line))
    .slice(0, 5);
  return `observed (${run.files}): exit ${run.result.exitCode}; ${run.requests.length} requests; workspace is ${listed}x a list item under "Additional working directories" (claude) or "Active Workspaces" (agy); stderr besides the sha256 lines: ${stderr.length === 0 ? "none" : JSON.stringify(stderr)}`;
}

function printReport(checks: readonly Check[], observations: readonly Observation[]) {
  console.log("Checks:");
  for (const c of checks)
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.id}: ${c.claim}\n        ${c.evidence}`);
  console.log("\nObservations:");
  for (const o of observations) console.log(`  ${o.id}: ${o.question}\n        ${o.answer}`);
}

// Last, so every declaration above is initialized before it runs.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error(`unknown argument: ${process.argv[2]}\n\n${HELP}`);
  process.exit(2);
}
process.exit(process.env[INNER] === "1" ? await inner() : outer());
