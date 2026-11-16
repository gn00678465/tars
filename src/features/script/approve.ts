import { TarsError } from "../../core/exit.ts";
import { sha256 } from "../../core/hash.ts";
import type { Terminal } from "../../core/terminal.ts";
import { gatherDossier, quoted, renderDossier, visible, type Dossier } from "./dossier.ts";
import type { ExecuteOptions } from "./execute.ts";
import { gate1ProblemText, pythonProblems } from "./gate1.ts";
import {
  checkApproval,
  discardStaged,
  installVersion,
  scriptsLayout,
  stageVersion,
  type ApprovalRecord,
  type RunSummary,
  type StagedVersion,
  type VersionId,
} from "./library.ts";
import type { ScriptMeta } from "./metadata.ts";
import { findAdvisories, type OsvEndpoint } from "./osv.ts";
import { prepareOutDir, type OutDirRules } from "./out-dir.ts";
import { readSubmission, removeSubmission, type Submission } from "./pending.ts";
import type { SandboxResult } from "./sandbox.ts";
import { problemText, type Toolchain } from "./supply.ts";

export type ApproveOutcome =
  | {
      readonly kind: "approved";
      readonly version: VersionId;
      /** versions/<id>/ was already there and valid, e.g. going back to an earlier version. */
      readonly reused: boolean;
      /**
       * "newer" when another submit arrived during the review and is still pending. "stuck" when
       * the approved submission could not be removed; the next approve of it finishes that.
       */
      readonly pending: "removed" | "newer" | "stuck";
    }
  /** The library already runs these exact bytes: an earlier approve stopped before removing pending. */
  | { readonly kind: "already-approved"; readonly version: VersionId }
  | { readonly kind: "declined"; readonly reason: "end of input" | "name did not match" };

export interface ApproveContext {
  readonly scriptsDir: string;
  readonly terminal: Terminal;
  readonly toolchain: Toolchain;
  readonly osv: OsvEndpoint;
  outDirRules(): OutDirRules;
  now(): Date;
  /** Runs <dir>/script.py in the sandbox with the secret it declares; the output comes back masked. */
  runLive(dir: string, meta: ScriptMeta, opts: ExecuteOptions): Promise<SandboxResult>;
}

const LIVE_TIMEOUT_MS = 120_000;

/**
 * Gate 3. The submission is read once; what is shown, what a live run executes and what is
 * installed all come from that one read, so a file changed while the user reads is never
 * approved. Nothing in the library changes before the name is typed, and a kill anywhere after
 * leaves a state the next approve of the same submission completes.
 */
export async function approve(name: string, ctx: ApproveContext): Promise<ApproveOutcome> {
  const { scriptsDir, terminal } = ctx;
  const layout = scriptsLayout(scriptsDir);
  const submission = await readSubmission(scriptsDir, name);
  const dossier = await gatherDossier(scriptsDir, submission, ctx.toolchain.index);
  const { base, evidence } = dossier;
  const { version } = submission;
  if (
    base.kind === "current" &&
    base.script.version === version &&
    typeof (await checkApproval(base.script.versionDir, base.script.source)) !== "string"
  ) {
    await removeSubmission(scriptsDir, submission);
    return { kind: "already-approved", version };
  }
  await recheck(dossier, ctx);
  terminal.write(renderDossier(dossier, ctx.now()));
  if (evidence.trials.length === 0 && evidence.review.kind !== "attached")
    terminal.write(
      "!! nothing from gate 2 counts for this script.py: no trial and no report. Approving it rests on your own reading.\n",
    );

  const stage: { made?: StagedVersion } = {};
  const staged = async () =>
    (stage.made ??= await stageVersion(layout, submission, ctx.toolchain, ctx.now()));
  try {
    const liveRuns: RunSummary[] = [];
    const how = submission.meta.secret === undefined ? "for real" : "with the real secret";
    for (let first = true; ; first = false) {
      const answer = await terminal.ask(
        first ? `Run it once ${how} before deciding? [y/N] ` : "Run it again? [y/N] ",
      );
      if (answer === undefined) return { kind: "declined", reason: "end of input" };
      if (!/^y(es)?$/i.test(answer.trim())) break;
      const run = await liveRun(submission, staged, ctx);
      if (run === "end of input") return { kind: "declined", reason: run };
      if (run !== undefined) liveRuns.push(run);
    }
    const typed = await terminal.ask(`Type ${name} to approve it, anything else cancels: `);
    if (typed === undefined) return { kind: "declined", reason: "end of input" };
    if (typed.trim() !== name) return { kind: "declined", reason: "name did not match" };

    const record: ApprovalRecord = {
      script: submission.scriptSha,
      lock: submission.lockSha,
      time: ctx.now().toISOString(),
      gate1: { time: submission.gate1Time, packages: dossier.pins.length },
      gate2: {
        trials: evidence.trials.map((t) => summary(t.time, t.args, t.exit)),
        ignoredTrials: evidence.ignoredTrials,
        review:
          evidence.review.kind === "attached"
            ? { time: evidence.review.time, report: evidence.review.report }
            : null,
      },
      gate3: {
        liveRuns,
        newPackages: [...dossier.newPackages],
        replaced: base.kind === "current" ? base.script.version : null,
      },
    };
    const installed = await installVersion(
      layout,
      scriptsDir,
      await staged(),
      record,
      dossier.newPackages,
    );
    // The script is live from here; a pending directory that will not go away must not turn
    // an approval the user just gave into a failure.
    const pending = await removeSubmission(scriptsDir, submission).then(
      (left) => (left === "removed" ? "removed" : "newer"),
      () => "stuck" as const,
    );
    return { kind: "approved", version, reused: installed === "reused", pending };
  } finally {
    if (stage.made !== undefined) await discardStaged(stage.made);
  }
}

/**
 * What may have changed since gate 1 without the submission changing: the system Python, and
 * the advisories against the locked packages. OSV out of reach refuses, as it does at gate 1.
 */
async function recheck({ submission, pins }: Dossier, ctx: ApproveContext): Promise<void> {
  const { name } = submission;
  const python = pythonProblems(submission.meta, ctx.toolchain.python.version);
  if (python.length > 0)
    throw new TarsError(
      `${name}: ${python.map(gate1ProblemText).join("; ")}. The system Python is not the one gate 1 saw; submit it again.`,
    );
  const verdict = await findAdvisories(pins, ctx.osv);
  if (verdict.kind === "unavailable")
    throw new TarsError(
      `${name}: cannot check advisories now (${verdict.detail}), so nothing was approved. Try again when OSV is reachable.`,
    );
  if (verdict.advisories.length > 0)
    throw new TarsError(
      `${name}: advisories appeared after gate 1:\n${verdict.advisories.map((a) => problemText({ kind: "advisory", ...a })).join("\n")}\nSubmit it again with fixed versions.`,
    );
}

async function liveRun(
  submission: Submission,
  staged: () => Promise<StagedVersion>,
  ctx: ApproveContext,
): Promise<RunSummary | "end of input" | undefined> {
  const { terminal } = ctx;
  const args = await askArgs(terminal);
  if (args === undefined) return "end of input";
  const out = await terminal.ask("--out directory the script may write (empty line for none): ");
  if (out === undefined) return "end of input";
  try {
    const outDir =
      out.trim() === "" ? undefined : await prepareOutDir(out.trim(), ctx.outDirRules());
    const time = ctx.now().toISOString();
    const outcome = await ctx.runLive((await staged()).dir, submission.meta, {
      args,
      timeoutMs: LIVE_TIMEOUT_MS,
      ...(outDir === undefined ? {} : { outDir }),
    });
    terminal.write(
      [
        `exit ${outcome.exit}  ${outcome.ms} ms${outcome.truncated ? "  (output truncated)" : ""}`,
        "stdout:",
        ...quoted(outcome.stdout),
        "stderr:",
        ...quoted(outcome.stderr),
        "",
      ].join("\n"),
    );
    return summary(time, args, outcome.exit);
  } catch (err) {
    if (!(err instanceof TarsError)) throw err;
    terminal.write(`!! the run did not start: ${visible(err.message)}\n`);
    return undefined;
  }
}

// One JSON array per line: a shell-like split could express neither an empty argument nor one
// that holds a newline.
async function askArgs(terminal: Terminal): Promise<string[] | undefined> {
  for (;;) {
    const line = await terminal.ask(
      'Arguments as a JSON array of strings, e.g. ["--title", "hi"] (empty line for none): ',
    );
    if (line === undefined) return undefined;
    if (line.trim() === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed) && parsed.every((a): a is string => typeof a === "string"))
      return parsed;
    terminal.write("!! that is not a JSON array of strings\n");
  }
}

// Arguments are stored as a hash, the rule runs.jsonl follows: they may hold private text.
const summary = (time: string, args: readonly string[], exit: number): RunSummary => ({
  time,
  argsSha256: sha256(JSON.stringify(args)),
  exit,
});
