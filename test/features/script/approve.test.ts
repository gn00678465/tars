import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import { sha256 } from "../../../src/core/hash.ts";
import {
  approve,
  type ApproveContext,
  type ApproveOutcome,
} from "../../../src/features/script/approve.ts";
import { gate1ProblemText, submit } from "../../../src/features/script/gate1.ts";
import {
  addNote,
  checkApproval,
  loadScript,
  readNotes,
  scriptsLayout,
  type ApprovalRecord,
  type LibraryScript,
} from "../../../src/features/script/library.ts";
import {
  attachReview,
  readSubmission,
  recordTrial,
  type Submission,
} from "../../../src/features/script/pending.ts";
import type { SandboxResult } from "../../../src/features/script/sandbox.ts";
import { readApproved, type PythonVersion } from "../../../src/features/script/supply.ts";
import { run } from "../../../src/main.ts";
import {
  fakeSecrets,
  scriptedTerminal,
  tempHome,
  testDeps,
  type ScriptedTerminal,
} from "../../helpers.ts";
import { fakeOsv, type FakeOsv } from "./fake-osv.ts";
import { fakePypi, type FakePypi } from "./fake-pypi.ts";
import { draftDir, plainScript, PYTHON, submitted, testToolchain, ZERO_DEP_LOCK } from "./gates.ts";
import { sampleScript } from "./sample.ts";

function setup(env: Record<string, string> = {}) {
  const home = tempHome();
  const data = join(home, "data");
  return { scripts: join(data, "scripts"), env: { HOME: home, TARS_DATA_DIR: data, ...env } };
}

describe("tars script approve guards", () => {
  test("inside a tars session it exits 1 without opening the terminal", async () => {
    const { env } = setup({ TARS_IN_SESSION: "1" });
    let opened = 0;
    const deps = testDeps({
      env,
      openTerminal: () => {
        opened++;
        return scriptedTerminal([]);
      },
    });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(opened).toBe(0);
    expect(deps.io.stderr.join("\n")).toContain("outside the tars session");
  });

  test("an empty TARS_IN_SESSION is not a session", async () => {
    const { env } = setup({ TARS_IN_SESSION: "" });
    const terminal = scriptedTerminal([]);
    const deps = testDeps({ env, openTerminal: () => terminal });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).not.toContain("outside the tars session");
  });

  test("without a terminal it exits 1", async () => {
    const { env } = setup();
    const deps = testDeps({
      env,
      openTerminal: () => {
        throw new TarsError("no terminal here");
      },
    });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("no terminal here");
  });

  test("the terminal is closed when the command ends", async () => {
    const { env } = setup();
    const terminal = scriptedTerminal([]);
    const deps = testDeps({ env, openTerminal: () => terminal });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(terminal.closed).toBe(true);
  });
});

setDefaultTimeout(60_000);

const TOOLCHAIN = testToolchain();
const V1 = plainScript("probe", "print('v1')");
const V2 = plainScript("probe", "print('v2')");
const RESULT: SandboxResult = {
  exit: 0,
  stdout: "live out\n",
  stderr: "",
  truncated: false,
  ms: 7,
};

interface LiveCall {
  readonly dir: string;
  readonly source: string;
  readonly args: readonly string[];
  readonly outDir?: string;
}

function world(over: Partial<ApproveContext> = {}) {
  const home = tempHome();
  const scripts = join(home, "data", "scripts");
  const launch = join(home, "launch");
  mkdirSync(launch);
  const live: LiveCall[] = [];
  const context = (answers: Parameters<typeof scriptedTerminal>[0]) => {
    const terminal = scriptedTerminal(answers);
    const ctx: ApproveContext = {
      scriptsDir: scripts,
      terminal,
      toolchain: TOOLCHAIN,
      osv: { url: "http://127.0.0.1:9", timeoutMs: 1000 },
      outDirRules: () => ({
        cwd: launch,
        launchDir: launch,
        realHome: home,
        data: join(home, "data"),
        bins: [],
      }),
      now: () => new Date(),
      runLive: async (dir, _meta, opts) => {
        live.push({
          dir,
          source: readFileSync(join(dir, "script.py"), "utf8"),
          args: opts.args,
          ...(opts.outDir === undefined ? {} : { outDir: opts.outDir }),
        });
        writeFileSync(join(dir, "live-run-was-here"), "");
        return RESULT;
      },
      ...over,
    };
    return { ctx, terminal };
  };
  const go = (answers: Parameters<typeof scriptedTerminal>[0]) =>
    approve("probe", context(answers).ctx);
  return { home, scripts, launch, live, context, go, layout: scriptsLayout(scripts) };
}

const text = (terminal: ScriptedTerminal) => terminal.transcript.join("");
const warnings = (terminal: ScriptedTerminal) =>
  terminal.transcript.flatMap((piece) => piece.split("\n")).filter((l) => l.startsWith("!!"));

/** The library runs exactly `source`, with a valid approval and a venv, and nothing is pending. */
async function expectInstalled(scripts: string, source: string): Promise<LibraryScript> {
  const script = await loadScript(scriptsLayout(scripts), "probe");
  expect(script.source).toBe(source);
  expect(await checkApproval(script.versionDir, script.source)).toEqual({
    script: sha256(source),
    lock: sha256(ZERO_DEP_LOCK),
  });
  expect(existsSync(join(script.versionDir, `venv-${PYTHON}`, "pyvenv.cfg"))).toBe(true);
  await expect(readSubmission(scripts, "probe")).rejects.toThrow("nothing is submitted");
  return script;
}

const approvalOf = (script: LibraryScript): ApprovalRecord =>
  JSON.parse(readFileSync(join(script.versionDir, "approval.json"), "utf8"));

const staged = (scripts: string) =>
  existsSync(join(scripts, "staging")) ? readdirSync(join(scripts, "staging")) : [];

describe("approve", () => {
  test("typing the name installs the reviewed bytes, records the three gates and removes the submission", async () => {
    const { scripts, go } = world();
    const submission = await submitted(scripts, V1);
    const evidence = join(scripts, "..", "workspace", ".evidence", "probe");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "trial.json"), "{}");
    await recordTrial(submission, ["--title", "private text"], { ...RESULT, exit: 3 }, new Date());
    await attachReview(submission, "tried an empty title\n", new Date());
    const outcome = await go(["n", "probe"]);
    expect(outcome).toEqual({
      kind: "approved",
      version: submission.version,
      reused: false,
      pending: "removed",
    });
    const script = await expectInstalled(scripts, V1);
    expect(script.version).toBe(submission.version);
    const record = approvalOf(script);
    expect(record.gate1).toEqual({ time: submission.gate1Time, packages: 0 });
    expect(record.gate2.trials.map((t) => [t.argsSha256, t.exit])).toEqual([
      [sha256(JSON.stringify(["--title", "private text"])), 3],
    ]);
    expect(record.gate2.review?.report).toBe("tried an empty title\n");
    expect(record.gate3).toEqual({ liveRuns: [], newPackages: [], replaced: null });
    expect(JSON.stringify(record)).not.toContain("private text");
    expect(staged(scripts)).toEqual([]);
    expect(existsSync(evidence)).toBe(false);
  });

  test("another name, or end of input, changes nothing", async () => {
    const { scripts, go } = world();
    const submission = await submitted(scripts, V1);
    expect(await go(["n", "probes"])).toEqual({ kind: "declined", reason: "name did not match" });
    expect(await go(["n"])).toEqual({ kind: "declined", reason: "end of input" });
    expect(await go([])).toEqual({ kind: "declined", reason: "end of input" });
    expect(existsSync(join(scripts, "library"))).toBe(false);
    expect(existsSync(join(scripts, "packages"))).toBe(false);
    expect(staged(scripts)).toEqual([]);
    expect(await readSubmission(scripts, "probe")).toEqual(submission);
  });

  test("the review material is shown before the first question", async () => {
    const { scripts, context } = world();
    await submitted(scripts, V1);
    const { ctx, terminal } = context([]);
    await approve("probe", ctx);
    const shown = terminal.transcript.slice(0, -1).join("");
    expect(shown).toContain("  | print('v1')");
    expect(shown).toContain("== gate 2 report ==");
    expect(terminal.transcript.at(-1)).toContain("Run it once");
  });

  test("warns when nothing from gate 2 counts, and not when a trial and a report do", async () => {
    const { scripts, context } = world();
    const submission = await submitted(scripts, V1);
    const bare = context([]);
    await approve("probe", bare.ctx);
    expect(warnings(bare.terminal).at(-1)).toContain("nothing from gate 2 counts");
    await recordTrial(submission, [], RESULT, new Date());
    await attachReview(submission, "ok\n", new Date());
    const backed = context([]);
    await approve("probe", backed.ctx);
    expect(warnings(backed.terminal)).toEqual([]);
  });
});

describe("approve: the live run", () => {
  test("gets the arguments as typed, empty string and newline included, and runs the directory that is then installed", async () => {
    const { scripts, live, go } = world();
    await submitted(scripts, V1);
    const outcome = await go(["y", '["--title", "", "two\\nlines"]', "", "n", "probe"]);
    expect(outcome.kind).toBe("approved");
    expect(live.map((l) => l.args)).toEqual([["--title", "", "two\nlines"]]);
    expect(live[0]?.source).toBe(V1);
    expect(live[0]?.dir).toContain(join(scripts, "staging"));
    const script = await expectInstalled(scripts, V1);
    expect(existsSync(join(script.versionDir, "live-run-was-here"))).toBe(true);
    expect(approvalOf(script).gate3.liveRuns.map((r) => [r.argsSha256, r.exit])).toEqual([
      [sha256(JSON.stringify(["--title", "", "two\nlines"])), 0],
    ]);
  });

  test("an empty line means no arguments, and the run can be repeated", async () => {
    const { scripts, live, go } = world();
    await submitted(scripts, V1);
    await go(["y", "", "", "yes", '[""]', "", "n", "probe"]);
    expect(live.map((l) => l.args)).toEqual([[], [""]]);
    expect(live[0]?.dir).toBe(live[1]?.dir as string);
  });

  test("the argument prompt asks again until it gets a JSON array of strings", async () => {
    const { scripts, live, context } = world();
    await submitted(scripts, V1);
    const { ctx, terminal } = context([
      "y",
      "--title hi",
      '{"title": "hi"}',
      '["hi", 3]',
      '"hi"',
      '["hi"]',
      "",
      "n",
      "probe",
    ]);
    expect((await approve("probe", ctx)).kind).toBe("approved");
    expect(live.map((l) => l.args)).toEqual([["hi"]]);
    expect(warnings(terminal).filter((w) => w.includes("JSON array of strings"))).toHaveLength(4);
  });

  test("its output is shown with control characters visible", async () => {
    const { scripts, context } = world({
      runLive: async () => ({
        ...RESULT,
        stdout: "sent\u001b[1A\u001b[2K\n",
        stderr: "\u202ewarn",
      }),
    });
    await submitted(scripts, V1);
    const { ctx, terminal } = context(["y", "", "", "n", "nope"]);
    await approve("probe", ctx);
    expect(text(terminal)).toContain("  | sent\\x1b[1A\\x1b[2K");
    expect(text(terminal)).toContain("  | \\u202ewarn");
    expect(text(terminal)).not.toContain("\u001b");
  });

  test("a run that cannot start is shown, and the review goes on", async () => {
    let calls = 0;
    const { scripts, context } = world({
      runLive: async () => {
        if (calls++ === 0) throw new TarsError("no script:bark in the keyring");
        return RESULT;
      },
    });
    await submitted(scripts, V1);
    const { ctx, terminal } = context(["y", "", "", "y", "", "", "n", "probe"]);
    expect((await approve("probe", ctx)).kind).toBe("approved");
    expect(warnings(terminal).some((w) => w.includes("no script:bark in the keyring"))).toBe(true);
    expect(approvalOf(await expectInstalled(scripts, V1)).gate3.liveRuns).toHaveLength(1);
  });

  test("--out goes through the --out rules: a directory under the launch dir is passed on, the home is refused", async () => {
    const { scripts, home, launch, live, context } = world();
    await submitted(scripts, V1);
    const { ctx, terminal } = context(["y", "", "dl", "y", "", home, "n", "nope"]);
    await approve("probe", ctx);
    expect(live.map((l) => l.outDir)).toEqual([join(launch, "dl")]);
    expect(warnings(terminal).some((w) => w.includes("--out"))).toBe(true);
  });

  test("a leading ~ in --out is the home, as a shell would read it", async () => {
    const { scripts, home, live, context } = world();
    await submitted(scripts, V1);
    const { ctx } = context(["y", "", "~/data/workspace/out/dl", "n", "nope"]);
    await approve("probe", ctx);
    expect(live.map((l) => l.outDir)).toEqual([join(home, "data", "workspace", "out", "dl")]);
  });

  test("a relative --out resolves against the directory the prompt names", async () => {
    const { scripts, home, live, context } = world();
    await submitted(scripts, V1);
    const { ctx, terminal } = context(["y", "", "dl", "n", "nope"]);
    await approve("probe", ctx);
    expect(terminal.transcript.join("\n")).toContain(`relative to ${join(home, "launch")}`);
    expect(live.map((l) => l.outDir)).toEqual([join(home, "launch", "dl")]);
  });

  test("end of input in the middle of it declines and leaves no staged version", async () => {
    const { scripts, live, go } = world();
    await submitted(scripts, V1);
    expect(await go(["y", "", "", "y"])).toEqual({ kind: "declined", reason: "end of input" });
    expect(live).toHaveLength(1);
    expect(staged(scripts)).toEqual([]);
    expect(existsSync(join(scripts, "library"))).toBe(false);
  });
});

describe("approve: updates", () => {
  test("an update keeps the notes and the runs, shows the diff, and records the version it replaced", async () => {
    const { scripts, layout, go, context } = world();
    await submitted(scripts, V1);
    await go(["n", "probe"]);
    const old = await loadScript(layout, "probe");
    await addNote(old, "the server cuts long bodies", new Date());
    writeFileSync(join(old.dir, "runs.jsonl"), '{"time":"t","version":"x","exit":0,"ms":1}\n');
    await submitted(scripts, V2);
    const { ctx, terminal } = context(["n", "probe"]);
    expect((await approve("probe", ctx)).kind).toBe("approved");
    expect(text(terminal)).toContain("  | -print('v1')");
    expect(text(terminal)).toContain("  | +print('v2')");
    const next = await expectInstalled(scripts, V2);
    expect(next.version).not.toBe(old.version);
    expect(approvalOf(next).gate3.replaced).toBe(old.version);
    expect(await readNotes(next)).toContain("the server cuts long bodies");
    expect(readFileSync(join(next.dir, "runs.jsonl"), "utf8")).toContain('"version":"x"');
    expect(readFileSync(join(old.versionDir, "script.py"), "utf8")).toBe(V1);
  });

  test("going back to an earlier version reuses its directory, records this approval and switches current", async () => {
    const { scripts, layout, go } = world();
    await submitted(scripts, V1);
    await go(["n", "probe"]);
    const first = await loadScript(layout, "probe");
    writeFileSync(join(first.versionDir, "kept-from-first-install"), "");
    await submitted(scripts, V2);
    await go(["n", "probe"]);
    const second = await loadScript(layout, "probe");
    await submitted(scripts, V1);
    const outcome = await go(["n", "probe"]);
    expect(outcome).toMatchObject({ kind: "approved", reused: true, version: first.version });
    const back = await expectInstalled(scripts, V1);
    expect(existsSync(join(back.versionDir, "kept-from-first-install"))).toBe(true);
    expect(approvalOf(back).gate3.replaced).toBe(second.version);
    expect(staged(scripts)).toEqual([]);
  });

  test("a version directory of the same id that is not a valid approval of these bytes is replaced", async () => {
    const { scripts, layout, go } = world();
    await submitted(scripts, V1);
    await go(["n", "probe"]);
    const first = await loadScript(layout, "probe");
    await submitted(scripts, V2);
    await go(["n", "probe"]);
    writeFileSync(join(first.versionDir, "script.py"), `${V1}import os\n`);
    writeFileSync(join(first.versionDir, "planted"), "");
    await submitted(scripts, V1);
    expect(await go(["n", "probe"])).toMatchObject({ kind: "approved", reused: false });
    const back = await expectInstalled(scripts, V1);
    expect(existsSync(join(back.versionDir, "planted"))).toBe(false);
  });

  test("current already names this version, but its files fail the approval check: the review runs and the directory is replaced", async () => {
    const { scripts, layout, context } = world();
    await submitted(scripts, V1);
    await approve("probe", context(["n", "probe"]).ctx);
    const live = await loadScript(layout, "probe");
    writeFileSync(join(live.versionDir, "script.py"), `${V1}import os\n`);
    await submitted(scripts, V1);
    const { ctx, terminal } = context(["n", "probe"]);
    expect(await approve("probe", ctx)).toMatchObject({ kind: "approved", reused: false });
    expect(text(terminal)).toContain("  | -import os");
    await expectInstalled(scripts, V1);
  });

  test("the library already running these exact bytes only clears the submission, without a question", async () => {
    const { scripts, context } = world();
    const first = await submitted(scripts, V1);
    await approve("probe", context(["n", "probe"]).ctx);
    await submitted(scripts, V1);
    const { ctx, terminal } = context(["n", "probe"]);
    expect(await approve("probe", ctx)).toEqual({
      kind: "already-approved",
      version: first.version,
      pending: "removed",
    });
    expect(terminal.transcript).toEqual([]);
    await expectInstalled(scripts, V1);
  });
});

describe("approve while something else writes", () => {
  test("a submit during the review: the reviewed bytes are installed and the new submission stays pending", async () => {
    const { scripts, go } = world();
    const reviewed = await submitted(scripts, V1);
    let newer: Submission | undefined;
    const outcome = await go([
      "n",
      async () => {
        newer = await submitted(scripts, V2);
        return "probe";
      },
    ]);
    expect(outcome).toEqual({
      kind: "approved",
      version: reviewed.version,
      reused: false,
      pending: "newer",
    });
    const script = await loadScript(scriptsLayout(scripts), "probe");
    expect(script.source).toBe(V1);
    expect(await readSubmission(scripts, "probe")).toEqual(newer as unknown as Submission);
  });

  test("files changed in pending during the review are not what gets shown, run or installed", async () => {
    const { scripts, live, go } = world();
    const reviewed = await submitted(scripts, V1);
    const swap = async () => {
      writeFileSync(join(reviewed.dir, "script.py"), V2);
      return "y";
    };
    expect((await go([swap, "", "", "n", "probe"])).kind).toBe("approved");
    expect(live[0]?.source).toBe(V1);
    await expectInstalled(scripts, V1);
  });

  test("two approvals of the same submission at once both end with it installed", async () => {
    const { scripts, go } = world();
    await submitted(scripts, V1);
    const outcomes = await Promise.all([go(["n", "probe"]), go(["n", "probe"])]);
    expect(outcomes.map((o) => o.kind)).toEqual(["approved", "approved"]);
    expect(outcomes.map((o) => o.kind === "approved" && o.reused).toSorted()).toEqual([
      false,
      true,
    ]);
    await expectInstalled(scripts, V1);
    expect(staged(scripts)).toEqual([]);
  });
});

describe("approve stopped midway, then run again", () => {
  test("before the version directory is in place: the library is untouched and the next approve installs", async () => {
    const { scripts, go } = world();
    const submission = await submitted(scripts, V1);
    mkdirSync(join(scripts, "library"), { recursive: true });
    writeFileSync(join(scripts, "library", "probe"), "in the way");
    await expect(go(["n", "probe"])).rejects.toThrow();
    expect(readFileSync(join(scripts, "library", "probe"), "utf8")).toBe("in the way");
    expect(await readSubmission(scripts, "probe")).toEqual(submission);
    rmSync(join(scripts, "library", "probe"));
    expect(await go(["n", "probe"])).toMatchObject({ kind: "approved", reused: false });
    await expectInstalled(scripts, V1);
  });

  test("a staged version a killed approve left is ignored, and removed once it is a day old", async () => {
    const { scripts, go } = world();
    await submitted(scripts, V1);
    const leftover = (name: string, ageMs: number) => {
      const dir = join(scripts, "staging", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "script.py"), V2);
      writeFileSync(join(dir, "approval.json"), "{}");
      const then = new Date(Date.now() - ageMs);
      utimesSync(dir, then, then);
      return dir;
    };
    const young = leftover("killed-an-hour-ago", 3_600_000);
    const old = leftover("killed-two-days-ago", 2 * 86_400_000);
    expect((await go(["n", "probe"])).kind).toBe("approved");
    await expectInstalled(scripts, V1);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  test("after the version directory is in place but before current moves: the next approve reuses it and moves current", async () => {
    const { scripts, go } = world();
    const submission = await submitted(scripts, V1);
    mkdirSync(join(scripts, "library", "probe", "current"), { recursive: true });
    writeFileSync(join(scripts, "library", "probe", "current", "in the way"), "");
    await expect(go(["n", "probe"])).rejects.toThrow();
    const version = join(scripts, "library", "probe", "versions", submission.version);
    expect(await checkApproval(version, V1)).toMatchObject({ script: sha256(V1) });
    expect(await readSubmission(scripts, "probe")).toEqual(submission);
    rmSync(join(scripts, "library", "probe", "current"), { recursive: true });
    expect(await go(["n", "probe"])).toMatchObject({ kind: "approved", reused: true });
    await expectInstalled(scripts, V1);
  });

  test("with current pointing at a version directory that is gone: the next approve installs it again", async () => {
    const { scripts, layout, go } = world();
    await submitted(scripts, V1);
    await go(["n", "probe"]);
    rmSync((await loadScript(layout, "probe")).versionDir, { recursive: true });
    await submitted(scripts, V1);
    expect(await go(["n", "probe"])).toMatchObject({ kind: "approved", reused: false });
    await expectInstalled(scripts, V1);
  });

  test("after current moved but before the submission is removed: approve still succeeds, and the next one clears it", async () => {
    const { scripts, context } = world();
    const submission = await submitted(scripts, V1);
    const root = join(scripts, "pending", "probe");
    chmodSync(root, 0o500);
    let outcome: ApproveOutcome;
    try {
      outcome = await approve("probe", context(["n", "probe"]).ctx);
    } finally {
      chmodSync(root, 0o700);
    }
    expect(outcome).toMatchObject({ kind: "approved", pending: "stuck" });
    expect((await loadScript(scriptsLayout(scripts), "probe")).source).toBe(V1);
    expect(await readSubmission(scripts, "probe")).toEqual(submission);
    const { ctx, terminal } = context([]);
    expect((await approve("probe", ctx)).kind).toBe("already-approved");
    expect(terminal.transcript).toEqual([]);
    await expectInstalled(scripts, V1);
  });
});

describe("approve with locked packages", () => {
  let pypi: FakePypi;
  let osv: FakeOsv;
  beforeEach(() => {
    pypi = fakePypi();
    pypi.wheel("alpha", "1.0", { requires: ["beta"] });
    pypi.wheel("beta", "1.0");
    osv = fakeOsv();
  });
  afterEach(() => {
    pypi.stop();
    osv.stop();
  });

  const SOURCE = sampleScript({
    dependencies: ["alpha"],
    body: "import alpha",
    tarsLines: [
      'name = "probe"',
      'summary = "s"',
      'effects = "read-only"',
      'args = ""',
      'outputs = "o"',
      'exit = { 0 = "ok" }',
    ],
  });

  async function submittedWithPackages(advisories: Record<string, string[]> = {}, status?: number) {
    const toolchain = testToolchain(pypi.index);
    const w = world({ toolchain });
    const result = await submit(draftDir(SOURCE), {
      scriptsDir: w.scripts,
      secrets: fakeSecrets(),
      toolchain,
      osv: osv.endpoint,
      now: new Date(),
    });
    if (!result.ok) throw new Error(result.problems.map(gate1ProblemText).join("\n"));
    const later = fakeOsv(advisories, status === undefined ? {} : { status });
    const go = (answers: Parameters<typeof scriptedTerminal>[0]) => {
      const { ctx, terminal } = w.context(answers);
      return { outcome: approve("probe", { ...ctx, osv: later.endpoint }), terminal };
    };
    return { ...w, submission: result.submission, go, stopLater: () => later.stop() };
  }

  const approvedPackages = async (scripts: string) =>
    [...(await readApproved(scripts))].map(String).toSorted();

  test("approving the script approves its new packages and builds the venv from the reviewed lock", async () => {
    const { scripts, go, stopLater } = await submittedWithPackages();
    const { outcome, terminal } = go(["n", "probe"]);
    expect((await outcome).kind).toBe("approved");
    stopLater();
    expect(text(terminal)).toContain("approving the script also approves: alpha, beta");
    expect(await approvedPackages(scripts)).toEqual(["alpha", "beta"]);
    const script = await loadScript(scriptsLayout(scripts), "probe");
    const python = join(script.versionDir, `venv-${PYTHON}`, "bin", "python");
    expect(Bun.spawnSync([python, "-c", "import alpha, beta"]).exitCode).toBe(0);
    expect(approvalOf(script).gate3.newPackages).toEqual(["alpha", "beta"]);
  });

  test("declining approves no package", async () => {
    const { scripts, go, stopLater } = await submittedWithPackages();
    expect((await go(["n", "no"]).outcome).kind).toBe("declined");
    stopLater();
    expect(await approvedPackages(scripts)).toEqual([]);
  });

  test("stopped after the version directory is in place but before the packages are approved: the next approve reuses it, approves them and moves current", async () => {
    const { scripts, submission, go, stopLater } = await submittedWithPackages();
    writeFileSync(join(scripts, "packages"), "in the way");
    await expect(go(["n", "probe"]).outcome).rejects.toThrow();
    const version = join(scripts, "library", "probe", "versions", submission.version);
    expect(await checkApproval(version, SOURCE)).toMatchObject({ script: sha256(SOURCE) });
    expect(existsSync(join(scripts, "library", "probe", "current"))).toBe(false);
    rmSync(join(scripts, "packages"));
    expect(await go(["n", "probe"]).outcome).toMatchObject({ kind: "approved", reused: true });
    stopLater();
    expect(await approvedPackages(scripts)).toEqual(["alpha", "beta"]);
    expect((await loadScript(scriptsLayout(scripts), "probe")).version).toBe(submission.version);
    await expect(readSubmission(scripts, "probe")).rejects.toThrow("nothing is submitted");
  });

  test("an advisory that appeared after gate 1 refuses before anything is shown", async () => {
    const { scripts, submission, go, stopLater } = await submittedWithPackages({
      beta: ["GHSA-late-0001"],
    });
    const { outcome, terminal } = go(["n", "probe"]);
    await expect(outcome).rejects.toThrow("GHSA-late-0001");
    stopLater();
    expect(terminal.transcript).toEqual([]);
    expect(existsSync(join(scripts, "library"))).toBe(false);
    expect(await readSubmission(scripts, "probe")).toEqual(submission);
  });

  test("OSV out of reach at gate 3 refuses", async () => {
    const { scripts, go, stopLater } = await submittedWithPackages({}, 500);
    const { outcome, terminal } = go(["n", "probe"]);
    await expect(outcome).rejects.toThrow("cannot check advisories");
    stopLater();
    expect(terminal.transcript).toEqual([]);
    expect(existsSync(join(scripts, "library"))).toBe(false);
  });
});

describe("approve rechecks the system Python", () => {
  test("a system Python the script's requires-python no longer admits refuses before anything is shown", async () => {
    const older = {
      ...TOOLCHAIN,
      python: { ...TOOLCHAIN.python, version: "3.11" as PythonVersion },
    };
    const { scripts, context } = world({ toolchain: older });
    const submission = await submitted(scripts, V1);
    const { ctx, terminal } = context(["n", "probe"]);
    await expect(approve("probe", ctx)).rejects.toThrow("requires-python");
    expect(terminal.transcript).toEqual([]);
    expect(await readSubmission(scripts, "probe")).toEqual(submission);
  });
});

describe("tars script approve", () => {
  test("declining exits 1 with nothing on stdout, and the submission stays", async () => {
    const { scripts, env } = setup();
    const submission = await submitted(scripts, V1);
    const terminal = scriptedTerminal(["n", "something else"]);
    const deps = testDeps({ env, openTerminal: () => terminal });
    expect(await run(["script", "approve", "probe"], deps)).toBe(1);
    expect(deps.io.stdout).toEqual([]);
    expect(deps.io.stderr.join("\n")).toContain("not approved (name did not match)");
    expect(text(terminal)).toContain("  | print('v1')");
    expect(await readSubmission(scripts, "probe")).toEqual(submission);
    expect(terminal.closed).toBe(true);
  });

  test("with nothing submitted it exits 1", async () => {
    const { env } = setup();
    const deps = testDeps({ env, openTerminal: () => scriptedTerminal([]) });
    expect(await run(["script", "approve", "probe"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("nothing is submitted for probe");
  });
});
