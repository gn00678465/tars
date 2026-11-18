import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { ensureSymlink, uniqueTemp, writeFileAtomic } from "../../core/fs.ts";
import { sha256 } from "../../core/hash.ts";
import { uniqueStamp, versionId, type VersionId } from "./library.ts";
import type { Lock } from "./lock.ts";
import { isRecord, requireScriptMeta, SLUG, type ScriptMeta } from "./metadata.ts";
import type { SandboxResult } from "./sandbox.ts";
import { LOCK_FILE } from "./supply.ts";

// pending/<name>/
//   current -> <id>      the submission under review; only publishSubmission writes it
//   <id>/                one submission: script.py, script.py.lock, venv-<python>/,
//     gate1.json         {"script", "lock", "time"}; written after current points here
//     trials/<stamp>.json
//     review.md          first line REVIEW_STAMP, then the report
//
// One directory per submit means two submits, or a submit and an approve, never write the same
// files; the pointer is the only thing they share.

declare const brand: unique symbol;

/**
 * A submission whose script.py and lock matched gate1.json when read. Only readSubmission and
 * publishSubmission make one, so holding one means the hashes were compared. Gate 2 and gate 3
 * work from these fields and never read the two files again.
 */
export interface Submission {
  readonly [brand]: "Submission";
  readonly name: string;
  /** pending/<name>/<id>, resolved once. */
  readonly dir: string;
  readonly source: string;
  readonly meta: ScriptMeta;
  readonly lockText: string;
  readonly scriptSha: string;
  readonly lockSha: string;
  readonly version: VersionId;
  /** When gate 1 passed; OSV was clean as of then. */
  readonly gate1Time: string;
}

export interface TrialRecord extends SandboxResult {
  readonly time: string;
  /** sha256 of the script.py the trial ran. */
  readonly script: string;
  readonly args: readonly string[];
}

export type Review =
  | { readonly kind: "missing" }
  /** Written for other bytes; its text is not shown. */
  | { readonly kind: "stale"; readonly time: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "attached"; readonly time: string; readonly report: string };

export interface Evidence {
  /** Trials of this submission's script.py, oldest first. */
  readonly trials: readonly TrialRecord[];
  /** Trial files for another script.py, or that do not parse. They count for nothing. */
  readonly ignoredTrials: number;
  readonly review: Review;
}

/** The report is copied into approval.json, so it stays small. */
export const REPORT_LIMIT = 32 * 1024;

/** Longer than any submit runs: four uv calls at 300 s each plus the OSV deadline. */
const STALE_MS = 24 * 60 * 60 * 1000;

const GATE1 = "gate1.json";
const REVIEW_STAMP = /^<!-- tars review: script ([0-9a-f]{64}) at (\S+) -->$/;

const pendingRoot = (scriptsDir: string, name: string) => join(scriptsDir, "pending", name);

const resubmit = (name: string, why: string) =>
  new TarsError(`${name}: ${why}. Submit it again: tars script submit <draft dir>`);

/** The directory pending/<name>/current points at, refused when it leaves pending/<name>/. */
async function currentDir(scriptsDir: string, name: string): Promise<string> {
  if (!SLUG.test(name)) throw new TarsError(`invalid script name ${JSON.stringify(name)}`);
  const root = pendingRoot(scriptsDir, name);
  const dir = await realpath(join(root, "current")).catch(() => {
    throw new TarsError(`nothing is submitted for ${name}; run: tars script submit <draft dir>`);
  });
  const inside = (await realpath(root)) + sep;
  if (!dir.startsWith(inside) || dir.slice(inside.length).includes(sep))
    throw new TarsError(`${name}: ${join(root, "current")} points outside ${inside}`);
  return dir;
}

export async function readSubmission(scriptsDir: string, name: string): Promise<Submission> {
  const dir = await currentDir(scriptsDir, name);
  const read = (file: string) => readFile(join(dir, file), "utf8").catch(() => undefined);
  const [gate1Text, source, lockText] = await Promise.all([
    read(GATE1),
    read("script.py"),
    read(LOCK_FILE),
  ]);
  if (gate1Text === undefined)
    throw resubmit(name, "the submission is incomplete (its submit did not finish)");
  const gate1 = parseGate1(gate1Text);
  if (gate1 === undefined) throw resubmit(name, `${GATE1} is not a gate 1 record`);
  if (source === undefined || sha256(source) !== gate1.script)
    throw resubmit(name, "script.py changed after gate 1");
  if (lockText === undefined || sha256(lockText) !== gate1.lock)
    throw resubmit(name, `${LOCK_FILE} changed after gate 1`);
  const meta = requireScriptMeta(source, `${name}: `);
  if (meta.name !== name) throw new TarsError(`${name}: script.py declares name ${meta.name}`);
  return submission(name, dir, source, meta, lockText, gate1.time);
}

/**
 * The whole submit transition. `vet` gets a private directory that holds script.py and must
 * leave the lock and the venv there; it returns the lock it vetted, or undefined when gate 1
 * refused, and then nothing changes: an earlier submission stays the one under review.
 *
 * current moves before gate1.json is written, and the directories to remove are listed before
 * current moves. A directory with gate1.json has been current at some point, so every one listed
 * was superseded by this submit's own swap; no other submit's unpublished work is ever removed.
 * Killed between the swap and gate1.json, readers refuse the submission as incomplete.
 */
export async function publishSubmission(
  scriptsDir: string,
  name: string,
  source: string,
  now: Date,
  vet: (dir: string) => Promise<Lock | undefined>,
): Promise<Submission | undefined> {
  const root = pendingRoot(scriptsDir, name);
  const id = uniqueStamp(now);
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  let lock: Lock | undefined;
  try {
    await writeFile(join(dir, "script.py"), source);
    lock = await vet(dir);
  } finally {
    if (lock === undefined) await rm(dir, { recursive: true, force: true });
  }
  if (lock === undefined) return undefined;
  const made = submission(
    name,
    await realpath(dir),
    source,
    requireScriptMeta(source),
    lock.text,
    now.toISOString(),
  );
  const superseded = await leftovers(root, id, now);
  await ensureSymlink(id, join(root, "current"));
  const record = { script: made.scriptSha, lock: made.lockSha, time: made.gate1Time };
  await writeFileAtomic(join(dir, GATE1), `${JSON.stringify(record)}\n`);
  for (const path of superseded) await rm(path, { recursive: true, force: true });
  return made;
}

/** Entries of pending/<name>/ a new submit replaces: finished submissions, and anything a killed submit left over a day ago. */
async function leftovers(root: string, own: string, now: Date): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root)) {
    if (entry === "current" || entry === own) continue;
    const path = join(root, entry);
    const finished = (await lstat(join(path, GATE1)).catch(() => undefined)) !== undefined;
    const age = now.getTime() - ((await lstat(path).catch(() => undefined))?.mtimeMs ?? Infinity);
    if (finished || age > STALE_MS) found.push(path);
  }
  return found;
}

/**
 * Removes the submission approve read, and only that directory. current is left alone: when it
 * now points elsewhere a newer submission arrived meanwhile, and the return value says so.
 * The directory is renamed away first, so a kill midway never leaves half a submission behind
 * current.
 */
/**
 * Takes back what is submitted for `name`, complete or broken, as approve does after installing:
 * current is left dangling, which means nothing is submitted. The library is not touched.
 */
export async function withdrawSubmission(scriptsDir: string, name: string): Promise<void> {
  const dir = await currentDir(scriptsDir, name);
  const doomed = uniqueTemp(dir);
  await rename(dir, doomed);
  await rm(doomed, { recursive: true, force: true });
}

export async function removeSubmission(
  scriptsDir: string,
  approved: Submission,
): Promise<"removed" | "newer-pending"> {
  const doomed = uniqueTemp(approved.dir);
  const swept = await rename(approved.dir, doomed).then(
    () => false,
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
      return true;
    },
  );
  if (!swept) await rm(doomed, { recursive: true, force: true });
  const now = await realpath(join(pendingRoot(scriptsDir, approved.name), "current")).catch(
    () => undefined,
  );
  return now === undefined || now === approved.dir ? "removed" : "newer-pending";
}

export async function recordTrial(
  submission: Submission,
  args: readonly string[],
  outcome: SandboxResult,
  now: Date,
): Promise<void> {
  const record: TrialRecord = {
    time: now.toISOString(),
    script: submission.scriptSha,
    args,
    ...outcome,
  };
  const trials = join(submission.dir, "trials");
  try {
    // Not recursive: a submission removed while the trial ran must stay removed.
    await mkdir(trials).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    await writeFile(
      join(trials, `${uniqueStamp(now)}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new TarsError(
      `${submission.name} was submitted again while the trial ran, so this trial counts for nothing; trial again`,
    );
  }
}

/** The stamp and the report land in one atomic write, so a report never sits beside another script's hash. */
export async function attachReview(
  submission: Submission,
  report: string,
  now: Date,
): Promise<void> {
  const stamp = `<!-- tars review: script ${submission.scriptSha} at ${now.toISOString()} -->`;
  await writeFileAtomic(join(submission.dir, "review.md"), `${stamp}\n${report}`).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
      throw new TarsError(
        `${submission.name} was submitted again; review the new submission instead`,
      );
    },
  );
}

/** A trial or review of the wrong shape or for other bytes is counted or labelled, never fatal. */
export async function readEvidence(submission: Submission): Promise<Evidence> {
  const dir = join(submission.dir, "trials");
  const files = (await readdir(dir).catch(() => [] as string[])).toSorted();
  const trials: TrialRecord[] = [];
  let ignoredTrials = 0;
  for (const file of files) {
    const trial = parseTrial(await readFile(join(dir, file), "utf8").catch(() => ""));
    if (trial?.script === submission.scriptSha) trials.push(trial);
    else ignoredTrials++;
  }
  trials.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const text = await readFile(join(submission.dir, "review.md"), "utf8").catch(() => undefined);
  return { trials, ignoredTrials, review: parseReview(text, submission.scriptSha) };
}

/** Gate 2 still to do, or only the user's approve left. A stale report counts as no report. */
export type PendingState = "awaiting-review" | "awaiting-approve";

/**
 * Every submission under review. approve leaves pending/<name>/current dangling, which means
 * nothing is submitted; a submission that fails its checks is reported, not thrown.
 */
export async function listSubmissions(scriptsDir: string): Promise<{
  submissions: { submission: Submission; state: PendingState }[];
  broken: { name: string; reason: string }[];
}> {
  const root = join(scriptsDir, "pending");
  const names = (await readdir(root).catch(() => [] as string[])).filter((n) => SLUG.test(n));
  const submissions: { submission: Submission; state: PendingState }[] = [];
  const broken: { name: string; reason: string }[] = [];
  for (const name of names.toSorted()) {
    if ((await realpath(join(root, name, "current")).catch(() => undefined)) === undefined)
      continue;
    try {
      const submission = await readSubmission(scriptsDir, name);
      submissions.push({ submission, state: await stateOf(submission) });
    } catch (err) {
      if (!(err instanceof TarsError)) throw err;
      broken.push({ name, reason: err.message });
    }
  }
  return { submissions, broken };
}

/** The state of what is submitted for `name`, or undefined when nothing is. */
export async function pendingState(
  scriptsDir: string,
  name: string,
): Promise<PendingState | undefined> {
  if (
    (await realpath(join(pendingRoot(scriptsDir, name), "current")).catch(() => undefined)) ===
    undefined
  )
    return undefined;
  return stateOf(await readSubmission(scriptsDir, name));
}

async function stateOf(submission: Submission): Promise<PendingState> {
  const { review } = await readEvidence(submission);
  return review.kind === "attached" ? "awaiting-approve" : "awaiting-review";
}

function submission(
  name: string,
  dir: string,
  source: string,
  meta: ScriptMeta,
  lockText: string,
  gate1Time: string,
): Submission {
  const scriptSha = sha256(source);
  const lockSha = sha256(lockText);
  const made: Omit<Submission, typeof brand> = {
    name,
    dir,
    source,
    meta,
    lockText,
    scriptSha,
    lockSha,
    version: versionId(scriptSha, lockSha),
    gate1Time,
  };
  return made as Submission;
}

function parseGate1(text: string): { script: string; lock: string; time: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { script, lock, time } = value;
  return typeof script === "string" && typeof lock === "string" && typeof time === "string"
    ? { script, lock, time }
    : undefined;
}

function parseTrial(text: string): TrialRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { time, script, args, exit, stdout, stderr, truncated, ms } = value;
  if (
    typeof time !== "string" ||
    typeof script !== "string" ||
    !Array.isArray(args) ||
    !args.every((a): a is string => typeof a === "string") ||
    typeof exit !== "number" ||
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    typeof truncated !== "boolean" ||
    typeof ms !== "number"
  )
    return undefined;
  return { time, script, args, exit, stdout, stderr, truncated, ms };
}

function parseReview(text: string | undefined, scriptSha: string): Review {
  if (text === undefined) return { kind: "missing" };
  const end = text.indexOf("\n");
  const stamp = REVIEW_STAMP.exec(end === -1 ? text : text.slice(0, end));
  if (stamp === null || end === -1) return { kind: "unreadable" };
  const [, script = "", time = ""] = stamp;
  return script === scriptSha
    ? { kind: "attached", time, report: text.slice(end + 1) }
    : { kind: "stale", time };
}
