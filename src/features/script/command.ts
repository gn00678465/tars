import { InvalidArgumentError, Option, type Command } from "commander";
import { readFile } from "node:fs/promises";
import { EXIT, TarsError } from "../../core/exit.ts";
import type { Io } from "../../core/io.ts";
import type { SecretStore } from "../../core/secrets.ts";
import type { Terminal } from "../../core/terminal.ts";
import {
  addNote,
  listScripts,
  loadScript,
  readNotes,
  recentRuns,
  retireScript,
  scriptsLayout,
  searchScripts,
  type LibraryScript,
  type ScriptsLayout,
} from "./library.ts";
import { gatherDossier, renderDossier } from "./dossier.ts";
import { hostText, OUTPUT_LIMIT, parseSlug, type Domain, type ScriptMeta } from "./metadata.ts";
import type { OsvEndpoint } from "./osv.ts";
import { prepareOutDir, type OutDirRules } from "./out-dir.ts";
import { attachReview, readSubmission, REPORT_LIMIT } from "./pending.ts";
import type { SandboxHost, SandboxResult } from "./sandbox.ts";
import type { Toolchain } from "./supply.ts";

export interface ScriptCommandContext {
  readonly io: Io;
  scriptsDir(): string;
  now(): Date;
  readonly secrets: SecretStore;
  sandboxHost(): Promise<SandboxHost>;
  outDirRules(): OutDirRules;
  toolchain(): Toolchain;
  osv(): OsvEndpoint;
  /** The command line the user runs in their own terminal to review `name`. */
  approveCommand(name: string): string;
  /** Whether an agent session started this tars (TARS_IN_SESSION). */
  inSession(): boolean;
  /** Opens the user's terminal; a TarsError when the process has none. */
  terminal(): Terminal;
  exitWith(code: number): void;
}

interface RunOptions {
  timeout: number;
  out?: string;
}

export function registerScriptCommands(program: Command, ctx: ScriptCommandContext): void {
  const layout = (): ScriptsLayout => scriptsLayout(ctx.scriptsDir());
  const script = program
    .command("script")
    .description("Find, read and look after the approved scripts in the script library.");

  script
    .command("list")
    .description("List the scripts in the library.")
    .option("--json", "print the result as JSON")
    .addHelpText("after", "\nExit codes: 0 done, 1 failure, 2 usage error.")
    .action(async (opts: { json?: boolean }) => {
      const { scripts, broken } = await listScripts(layout());
      for (const b of broken) ctx.io.err(`warning: skipped ${b.reason}`);
      if (opts.json) ctx.io.out(JSON.stringify(scripts.map((s) => summaryJson(s.meta))));
      else for (const s of scripts) ctx.io.out(summaryLine(s.meta));
    });

  script
    .command("search")
    .description("Find scripts whose name, summary, args or notes contain any of the words.")
    .argument("<words...>", "words to look for; a script matching more words ranks higher")
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Exit codes: 0 done (also when nothing matched), 1 failure, 2 usage error.

Examples:
  tars script search push notification --json`,
    )
    .action(async (words: string[], opts: { json?: boolean }) => {
      const hits = await searchScripts(layout(), words, ctx.now());
      if (opts.json)
        ctx.io.out(
          JSON.stringify(hits.map((h) => ({ ...summaryJson(h.script.meta), matched: h.matched }))),
        );
      else if (hits.length === 0) ctx.io.err("no script matched");
      else for (const h of hits) ctx.io.out(summaryLine(h.script.meta));
    });

  script
    .command("show")
    .description("Print how to call a script, its exit codes, notes and recent runs.")
    .argument("<name>", "script name", parseName)
    .option("--source", "print only the current script.py, to copy into a draft")
    .option("--json", "print the result as JSON")
    .addOption(
      new Option(
        "--pending",
        "print the submission under review instead: script, declarations, gate 1, trials, report",
      ).conflicts(["source", "json"]),
    )
    .addHelpText(
      "after",
      `
Exit codes: 0 done, 1 no such script or submission, 2 usage error.

Examples:
  tars script show bark-push
  tars script show bark-push --source > drafts/bark-push/script.py
  tars script show bark-push --pending`,
    )
    .action(async (name: string, opts: { source?: boolean; json?: boolean; pending?: boolean }) => {
      if (opts.pending) {
        const submission = await readSubmission(ctx.scriptsDir(), name);
        const dossier = await gatherDossier(ctx.scriptsDir(), submission, ctx.toolchain().index);
        return ctx.io.out(renderDossier(dossier, ctx.now()).trimEnd());
      }
      const s = await loadScript(layout(), name);
      if (opts.source) return ctx.io.out(s.source.trimEnd());
      const notes = (await readNotes(s)).trimEnd();
      const runs = await recentRuns(s, 5);
      if (opts.json)
        return ctx.io.out(JSON.stringify({ ...detailJson(s), notes, recentRuns: runs }));
      ctx.io.out(detailText(s));
      ctx.io.out(`\nnotes:\n${notes === "" ? "  (none)" : notes}`);
      ctx.io.out(
        `\nrecent runs:\n${runs.length === 0 ? "  (none)" : runs.map((r) => `  ${r.time} exit ${r.exit} ${r.ms} ms`).join("\n")}`,
      );
    });

  addRunOptions(script.command("run"))
    .description("Run an approved script in the sandbox, with only the secret it declares.")
    .addHelpText(
      "after",
      `
Exit codes: the script's own code (0 to 123, see tars script show <name>);
1 when tars refuses or fails before the script starts; 2 usage error;
124 timed out; 128+n stopped by signal n.

Examples:
  tars script run bark-push -- --title 會議 --body 改到三點
  tars script run download --out out/files -- https://example.com/report.pdf`,
    )
    .action(async (name: string, args: string[], opts: RunOptions) => {
      const s = await loadScript(layout(), name);
      const { runApproved } = await import("./execute.ts");
      const outcome = await runApproved(s, await executeOptions(args, opts), {
        secrets: ctx.secrets,
        scriptsDir: ctx.scriptsDir(),
        host: await ctx.sandboxHost(),
        toolchain: ctx.toolchain(),
        now: ctx.now(),
      });
      report(ctx.io, outcome);
      ctx.exitWith(outcome.exit);
    });

  addRunOptions(script.command("trial"))
    .description(
      "Run a submitted script in the sandbox without any secret, to test it before approval.",
    )
    .addHelpText(
      "after",
      `
No secret, no "secret:url" host, and no network at all for an external-write script, so a
trial never writes to the outside world. The output is also saved under the submission's
trials/ for the approver to read.
Exit codes: as tars script run.

Examples:
  tars script trial bark-push -- --title ""
  tars script trial download --out out/trial -- not-a-url`,
    )
    .action(async (name: string, args: string[], opts: RunOptions) => {
      const submission = await readSubmission(ctx.scriptsDir(), name);
      const { runTrial } = await import("./execute.ts");
      const outcome = await runTrial(submission, await executeOptions(args, opts), {
        host: await ctx.sandboxHost(),
        toolchain: ctx.toolchain(),
        now: ctx.now(),
      });
      report(ctx.io, outcome);
      ctx.exitWith(outcome.exit);
    });

  const executeOptions = async (args: string[], opts: RunOptions) => ({
    args,
    timeoutMs: opts.timeout * 1000,
    ...(opts.out === undefined ? {} : { outDir: await prepareOutDir(opts.out, ctx.outDirRules()) }),
  });

  script
    .command("note")
    .description("Add one line to a script's notes, for the next agent that uses it.")
    .argument("<name>", "script name", parseName)
    .argument("<text>", "one line: what the next caller should know", parseLine)
    .addHelpText(
      "after",
      `
Exit codes: 0 added, 1 no such script, 2 usage error.

Examples:
  tars script note bark-push "--body longer than 4000 characters is cut by the server"`,
    )
    .action(async (name: string, text: string) => {
      await addNote(await loadScript(layout(), name), text, ctx.now());
      ctx.io.out(`noted ${name}`);
    });

  script
    .command("retire")
    .description("Move a script, with its notes and runs, out of the library.")
    .argument("<name>", "script name", parseName)
    .addHelpText("after", "\nExit codes: 0 retired, 1 no such script, 2 usage error.")
    .action(async (name: string) => {
      const target = await retireScript(layout(), await loadScript(layout(), name), ctx.now());
      ctx.io.out(`retired ${name} to ${target}`);
    });

  script
    .command("submit")
    .description(
      "Check a draft (gate 1) and put it up for review, replacing an earlier submission.",
    )
    .argument("<draft-dir>", "directory holding the draft's script.py")
    .addHelpText(
      "after",
      `
Locks the dependencies, asks OSV about them and builds the environment. A draft that fails
changes nothing: an earlier submission of the same script stays the one under review.
The last line printed is the command the user runs, in their own terminal, to approve it.

Exit codes: 0 submitted, 1 gate 1 refused the draft or tars failed, 2 usage error.

Examples:
  tars script submit drafts/bark-push`,
    )
    .action(async (draftDir: string) => {
      const { gate1ProblemText, submit } = await import("./gate1.ts");
      const result = await submit(draftDir, {
        scriptsDir: ctx.scriptsDir(),
        secrets: ctx.secrets,
        toolchain: ctx.toolchain(),
        osv: ctx.osv(),
        now: ctx.now(),
      });
      if (!result.ok) {
        for (const problem of result.problems) ctx.io.err(`gate 1: ${gate1ProblemText(problem)}`);
        ctx.io.err(
          "gate 1 refused the draft; nothing changed. Fix it and submit again. An earlier submission, if any, is still under review.",
        );
        return ctx.exitWith(EXIT.failure);
      }
      const { submission, newPackages, base } = result;
      const { name } = submission;
      const replaces =
        base.kind === "none"
          ? "a new script"
          : base.kind === "current"
            ? `updates version ${base.script.version}`
            : "replaces a library entry that does not load";
      ctx.io.out(`submitted ${name} (${replaces})`);
      if (newPackages.length > 0)
        ctx.io.out(`packages the user has not approved yet: ${newPackages.join(", ")}`);
      ctx.io.out(`test it:    tars script trial ${name} -- <args>`);
      ctx.io.out(`report:     tars script review ${name} --report <file>`);
      ctx.io.out("then ask the user to run this in their own terminal:");
      ctx.io.out(ctx.approveCommand(name));
    });

  script
    .command("review")
    .description("Attach the gate 2 report to a submission; a later report replaces it.")
    .argument("<name>", "script name", parseName)
    .requiredOption("--report <file>", `the report: UTF-8 text, at most ${REPORT_LIMIT} bytes`)
    .addHelpText(
      "after",
      `
The report is tied to the script.py it reviewed; after another submit it no longer counts.

Exit codes: 0 attached, 1 nothing submitted or an unusable report, 2 usage error.

Examples:
  tars script review bark-push --report drafts/bark-push/review.md`,
    )
    .action(async (name: string, opts: { report: string }) => {
      const report = await readReport(opts.report);
      const submission = await readSubmission(ctx.scriptsDir(), name);
      await attachReview(submission, report, ctx.now());
      ctx.io.out(`attached the review to ${name} (script.py ${submission.scriptSha.slice(0, 12)})`);
    });

  script
    .command("approve")
    .description(
      "Gate 3, for the user: read a submission in your own terminal and decide whether it enters the library.",
    )
    .argument("<name>", "script name", parseName)
    .addHelpText(
      "after",
      `
Asks its questions on /dev/tty, never stdin, and refuses inside a tars session.
Exit codes: 0 approved, 1 not approved or failure, 2 usage error.

Examples:
  tars script approve bark-push`,
    )
    .action(async (name: string) => {
      if (ctx.inSession())
        throw new TarsError(
          "approve is for the user: run it in your own terminal, outside the tars session",
        );
      const terminal = ctx.terminal();
      try {
        const { approve } = await import("./approve.ts");
        const toolchain = ctx.toolchain();
        const outcome = await approve(name, {
          scriptsDir: ctx.scriptsDir(),
          terminal,
          toolchain,
          osv: ctx.osv(),
          outDirRules: ctx.outDirRules,
          now: ctx.now,
          runLive: async (dir, meta, opts) => {
            const { runWithSecret } = await import("./execute.ts");
            return runWithSecret(dir, meta, opts, {
              secrets: ctx.secrets,
              scriptsDir: ctx.scriptsDir(),
              host: await ctx.sandboxHost(),
              toolchain,
            });
          },
        });
        if (outcome.kind === "declined") {
          ctx.io.err(`not approved (${outcome.reason}); ${name} is still pending`);
          return ctx.exitWith(EXIT.failure);
        }
        ctx.io.out(
          outcome.kind === "already-approved"
            ? `${name} ${outcome.version} is already in the library`
            : `approved ${name} ${outcome.version}${outcome.reused ? " (a version already in the library)" : ""}`,
        );
        if (outcome.pending === "newer")
          ctx.io.err(
            `a newer submission of ${name} arrived while you were reading; it is still pending and needs its own approval`,
          );
        if (outcome.pending === "stuck")
          ctx.io.err(
            `the approved submission could not be removed from pending; run tars script approve ${name} again to clear it`,
          );
      } finally {
        terminal.close();
      }
    });
}

function addRunOptions(cmd: Command): Command {
  return cmd
    .argument("<name>", "script name", parseName)
    .argument("[args...]", "arguments for the script, after --")
    .option("--timeout <seconds>", "stop the script after this many seconds", parseTimeout, 120)
    .option("--out <dir>", "a directory the script may write; it gets the path in TARS_OUT");
}

function parseTimeout(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 3600)
    throw new InvalidArgumentError("use whole seconds from 1 to 3600.");
  return n;
}

function report(io: Io, outcome: SandboxResult): void {
  if (outcome.stdout !== "") io.out(outcome.stdout.replace(/\n$/, ""));
  if (outcome.stderr !== "") io.err(outcome.stderr.replace(/\n$/, ""));
  if (outcome.truncated) io.err(`tars: output past ${OUTPUT_LIMIT} bytes per stream was dropped`);
}

async function readReport(path: string): Promise<string> {
  const bytes = await readFile(path).catch(() => {
    throw new TarsError(`cannot read the report at ${path}`);
  });
  if (bytes.length > REPORT_LIMIT)
    throw new TarsError(`the report is ${bytes.length} bytes; the limit is ${REPORT_LIMIT}`);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new TarsError("the report is not UTF-8");
  if (text.trim() === "") throw new TarsError("the report is empty");
  return text;
}

const parseName = parseSlug("bark-push");

function parseLine(value: string): string {
  const line = value.trim();
  if (line === "" || line.includes("\n"))
    throw new InvalidArgumentError("text must be one non-empty line.");
  return line;
}

const domainText = (d: Domain) =>
  d.kind === "any" ? "*" : d.kind === "secret-url" ? "secret:url" : hostText(d);

function summaryJson(meta: ScriptMeta) {
  return {
    name: meta.name,
    summary: meta.summary,
    secret: meta.secret ?? null,
    effects: meta.effects,
  };
}

function summaryLine(meta: ScriptMeta): string {
  return `${meta.name}\t${meta.effects}\t${meta.secret ?? "-"}\t${meta.summary}`;
}

function detailJson(s: LibraryScript) {
  const { meta } = s;
  return {
    ...summaryJson(meta),
    version: s.version,
    domains: meta.domains.map(domainText),
    args: meta.args,
    outputs: meta.outputs,
    exit: Object.fromEntries(meta.exit),
    dependencies: meta.dependencies,
  };
}

function detailText(s: LibraryScript): string {
  const { meta } = s;
  return [
    `${meta.name}: ${meta.summary}`,
    `call:    tars script run ${meta.name} -- ${meta.args}`,
    `outputs: ${meta.outputs}`,
    `effects: ${meta.effects}`,
    `secret:  ${meta.secret ?? "(none)"}`,
    `domains: ${meta.domains.map(domainText).join(", ") || "(no network)"}`,
    `version: ${s.version}`,
    "exit codes:",
    ...[...meta.exit].map(([code, meaning]) => `  ${code}  ${meaning}`),
    "  124 timed out (tars)",
    "  128+n stopped by signal n (tars)",
  ].join("\n");
}
