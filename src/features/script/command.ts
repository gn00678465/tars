import { InvalidArgumentError, type Command } from "commander";
import type { Io } from "../../core/io.ts";
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

export interface ScriptCommandContext {
  readonly io: Io;
  /** Called only when a script command runs, so `tars --help` works even when paths cannot resolve. */
  scriptsDir(): string;
  now(): Date;
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
