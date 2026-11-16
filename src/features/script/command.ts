import { InvalidArgumentError, type Command } from "commander";
import { join } from "node:path";
import type { Io } from "../../core/io.ts";
import type { SecretStore } from "../../core/secrets.ts";
import { runApproved, runTrial, type Outcome } from "./execute.ts";
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
import { SLUG, type Domain, type ScriptMeta } from "./metadata.ts";
import { prepareOutDir, type OutDirRules } from "./out-dir.ts";
import { OUTPUT_LIMIT, type SandboxHost } from "./sandbox.ts";

export interface ScriptCommandContext {
  readonly io: Io;
  /** Called only when a script command runs, so `tars --help` works even when paths cannot resolve. */
  scriptsDir(): string;
  now(): Date;
  readonly secrets: SecretStore;
  sandboxHost(): Promise<SandboxHost>;
  outDirRules(): OutDirRules;
  /** Python's major.minor, which picks the venv. */
  python(): string;
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
    .addHelpText(
      "after",
      `
Exit codes: 0 done, 1 no such script, 2 usage error.

Examples:
  tars script show bark-push
  tars script show bark-push --source > drafts/bark-push/script.py`,
    )
    .action(async (name: string, opts: { source?: boolean; json?: boolean }) => {
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
      const outcome = await runApproved(s, await executeOptions(args, opts), {
        secrets: ctx.secrets,
        scriptsDir: ctx.scriptsDir(),
        host: await ctx.sandboxHost(),
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
The output is also saved under the submission's trials/ for the approver to read.
Exit codes: as tars script run.

Examples:
  tars script trial bark-push -- --title ""
  tars script trial download --out out/trial -- not-a-url`,
    )
    .action(async (name: string, args: string[], opts: RunOptions) => {
      const outcome = await runTrial(
        join(ctx.scriptsDir(), "pending", name),
        await executeOptions(args, opts),
        { host: await ctx.sandboxHost(), now: ctx.now() },
      );
      report(ctx.io, outcome);
      ctx.exitWith(outcome.exit);
    });

  const executeOptions = async (args: string[], opts: RunOptions) => ({
    args,
    timeoutMs: opts.timeout * 1000,
    python: ctx.python(),
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

function report(io: Io, outcome: Outcome): void {
  if (outcome.stdout !== "") io.out(outcome.stdout.replace(/\n$/, ""));
  if (outcome.stderr !== "") io.err(outcome.stderr.replace(/\n$/, ""));
  if (outcome.truncated) io.err(`tars: output past ${OUTPUT_LIMIT} bytes per stream was dropped`);
}

function parseName(value: string): string {
  if (!SLUG.test(value))
    throw new InvalidArgumentError("use lowercase letters, digits and hyphens, e.g. bark-push.");
  return value;
}

function parseLine(value: string): string {
  const line = value.trim();
  if (line === "" || line.includes("\n"))
    throw new InvalidArgumentError("text must be one non-empty line.");
  return line;
}

const domainText = (d: Domain) =>
  d.kind === "any"
    ? "*"
    : d.kind === "secret-url"
      ? "secret:url"
      : `${d.host}${d.port ? `:${d.port}` : ""}`;

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
