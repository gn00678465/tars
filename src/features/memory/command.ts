import { InvalidArgumentError, Option, type Command } from "commander";
import { EXIT, TarsError } from "../../core/exit.ts";
import type { Io } from "../../core/io.ts";
import { MemoryParseError, type MemoryEntry } from "./document.ts";
import { SOURCES, type EditError, type EditOutcome, type MemoryOp } from "./edit.ts";
import { updateMemoryFile } from "./store.ts";

export interface MemoryCommandContext {
  readonly io: Io;
  /** Called only when a memory command runs, so `tars --help` works even when paths cannot resolve. */
  memoryPath(): string;
}

export function registerMemoryCommands(program: Command, ctx: MemoryCommandContext): void {
  const memory = program
    .command("memory")
    .description("Change the shared memory file. Every write goes through these commands.");

  memory
    .command("remember")
    .description("Add an active entry. An active entry with the same id becomes superseded.")
    .requiredOption(
      "--id <id>",
      "stable id: lowercase letters, digits, hyphens (pref-, dec-, ref-)",
      parseId,
    )
    .requiredOption(
      "--section <section>",
      "section heading without `## `, e.g. 偏好",
      parseLine("--section"),
    )
    .requiredOption("--text <text>", "the entry, one line", parseLine("--text"))
    .addOption(
      new Option("--source <source>", "who said it: user = the user's own words")
        .choices(SOURCES)
        .makeOptionMandatory(),
    )
    .option("--date <YYYY-MM-DD>", "observed date (default: today)", parseDate)
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Exit codes: 0 done or already present, 1 failure, 2 usage error.

Examples:
  tars memory remember --id pref-short-replies --section 偏好 --text '回覆先講結論。' --source user
  tars memory remember --id pref-short-replies --section 偏好 --text '回覆先講結論，再講原因。' --source user --json`,
    )
    .action(async (opts: RememberOptions) => {
      const { id, section, text, source, json } = opts;
      const date = opts.date ?? today();
      await execute(ctx, { kind: "remember", id, section, text, source, date }, json);
    });

  memory
    .command("forget")
    .description("Mark one active entry superseded. Nothing is deleted.")
    .addOption(new Option("--id <id>", "id of the entry").argParser(parseId).conflicts("match"))
    .addOption(
      new Option("--match <text>", "text that appears in exactly one active entry").argParser(
        parseLine("--match"),
      ),
    )
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Exit codes: 0 forgotten or already superseded, 1 no entry, or --match hit several (ids on stderr), 2 usage error.

Examples:
  tars memory forget --id pref-short-replies
  tars memory forget --match '先講結論' --json`,
    )
    .action(async (opts: ForgetOptions) => {
      let op: MemoryOp;
      if (opts.id !== undefined) op = { kind: "forget-id", id: opts.id };
      else if (opts.match !== undefined) op = { kind: "forget-match", match: opts.match };
      else {
        throw new TarsError(
          "pass --id <id> or --match <text>\n  tars memory forget --id pref-short-replies",
          EXIT.usage,
        );
      }
      await execute(ctx, op, opts.json);
    });
}

interface RememberOptions {
  id: string;
  section: string;
  text: string;
  source: (typeof SOURCES)[number];
  date?: string;
  json?: boolean;
}

interface ForgetOptions {
  id?: string;
  match?: string;
  json?: boolean;
}

async function execute(ctx: MemoryCommandContext, op: MemoryOp, json = false): Promise<void> {
  const memoryPath = ctx.memoryPath();
  let outcome: EditOutcome;
  try {
    outcome = await updateMemoryFile(memoryPath, op);
  } catch (err) {
    if (err instanceof MemoryParseError) {
      throw new TarsError(`cannot edit ${memoryPath}: ${err.message}`);
    }
    throw err;
  }
  if (!outcome.ok) throw editFailure(outcome.error);
  const { result, entry } = outcome;
  ctx.io.out(
    json
      ? JSON.stringify({ result, id: entry.id, section: entry.section, status: entry.status })
      : `${result} ${entry.id}`,
  );
}

function editFailure(error: EditError): TarsError {
  switch (error.kind) {
    case "section-mismatch":
      return new TarsError(
        `id ${error.id} lives in section ${error.section}; rerun with --section ${error.section}`,
        EXIT.usage,
      );
    case "id-not-found":
      return new TarsError(`no entry has id ${error.id}`);
    case "no-match":
      return new TarsError(`no active entry contains "${error.match}"`);
    case "ambiguous-match":
      return new TarsError(
        `"${error.match}" is in ${error.candidates.length} active entries; nothing changed. Rerun with --id:\n${error.candidates.map(candidateLine).join("\n")}`,
      );
  }
}

function candidateLine(entry: MemoryEntry): string {
  return `  ${entry.id}\t${entry.body.split("\n")[0] ?? ""}`;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseId(value: string): string {
  if (!ID.test(value))
    throw new InvalidArgumentError(
      "use lowercase letters, digits and single hyphens, e.g. pref-short-replies.",
    );
  return value;
}

function parseLine(flag: string): (value: string) => string {
  return (value) => {
    const line = value.trim();
    if (line === "" || line.includes("\n"))
      throw new InvalidArgumentError(`${flag} must be one non-empty line.`);
    return line;
  };
}

function parseDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidArgumentError("use YYYY-MM-DD.");
  }
  return value;
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
