import { TarsError } from "../../core/exit.ts";
import { libraryBase, scriptsLayout, type LibraryBase } from "./library.ts";
import { parseLock, type PackageName, type Pin } from "./lock.ts";
import { hostText, type Domain } from "./metadata.ts";
import {
  readEvidence,
  type Evidence,
  type Review,
  type Submission,
  type TrialRecord,
} from "./pending.ts";
import { problemText, readApproved } from "./supply.ts";

/** Everything a reviewer of a submission is shown, gathered once. */
export interface Dossier {
  readonly submission: Submission;
  readonly base: LibraryBase;
  readonly pins: readonly Pin[];
  /** Pins the user has not approved yet, as of when the dossier was gathered. */
  readonly newPackages: readonly PackageName[];
  readonly evidence: Evidence;
}

/**
 * Reads what surrounds a submission: the library version it would replace, which packages are
 * still unapproved, the trials and the report. The lock policy is applied again here, to the
 * bytes the submission holds, so `show --pending` and gate 3 never trust the pending directory.
 */
export async function gatherDossier(
  scriptsDir: string,
  submission: Submission,
  index: string,
): Promise<Dossier> {
  const parsed = parseLock(submission.lockText, index);
  if (!parsed.ok)
    throw new TarsError(
      `${submission.name}: the submitted lock breaks the lock policy; submit it again:\n${parsed.problems.map(problemText).join("\n")}`,
    );
  const { pins } = parsed.lock;
  const approved = await readApproved(scriptsDir);
  return {
    submission,
    base: await libraryBase(scriptsLayout(scriptsDir), submission.name),
    pins,
    newPackages: [...new Set(pins.map((p) => p.name))].filter((n) => !approved.has(n)),
    evidence: await readEvidence(submission),
  };
}

const TRIAL_LINES = 20;
const MAX_DIFF_PAIRS = 4_000_000;

/**
 * The review material in the order gate 3 reads it. tars's own lines start in column 0 and
 * warnings with "!!"; every line that comes from the script, a trial or the report sits behind a
 * "  | " gutter and goes through `visible`, so none of them can pose as a line of tars.
 */
export function renderDossier(dossier: Dossier, now: Date): string {
  const { submission, evidence } = dossier;
  const { meta } = submission;
  return [
    ...sourceSection(dossier),
    "",
    "== what it declares ==",
    `name:     ${visible(meta.name)}`,
    `summary:  ${visible(meta.summary)}`,
    `call:     tars script run ${visible(meta.name)} -- ${visible(meta.args)}`,
    `outputs:  ${visible(meta.outputs)}`,
    `effects:  ${meta.effects}`,
    `secret:   ${visible(meta.secret ?? "(none)")}`,
    `domains:  ${visible(meta.domains.map(domainText).join(", ")) || "(no network)"}`,
    `python:   ${visible(meta.requiresPython ?? "(any)")}`,
    `requires: ${visible(meta.dependencies.join(", ")) || "(nothing)"}`,
    "exit codes:",
    ...[...meta.exit].map(([code, meaning]) => `  ${code}  ${visible(meaning)}`),
    "",
    "== gate 1 ==",
    `passed at ${visible(submission.gate1Time)} (${age(submission.gate1Time, now)})`,
    `script.py      sha256 ${submission.scriptSha}`,
    `script.py.lock sha256 ${submission.lockSha}`,
    `version id     ${submission.version}`,
    dossier.pins.length === 0
      ? "locked packages: (none)"
      : `locked packages (${dossier.pins.length}): ${dossier.pins.map((p) => visible(`${p.name}==${p.version}`)).join(", ")}`,
    "",
    "== new packages ==",
    dossier.newPackages.length === 0
      ? "(none)"
      : `approving the script also approves: ${dossier.newPackages.join(", ")}`,
    "",
    "== trials (gate 2) ==",
    ...(evidence.trials.length === 0 ? ["!! no trial ran this script.py"] : []),
    ...(evidence.ignoredTrials === 0
      ? []
      : [
          `!! ignored ${evidence.ignoredTrials} trial record(s): made for another script.py, or unreadable`,
        ]),
    ...evidence.trials.flatMap(trialLines),
    "",
    "== gate 2 report ==",
    ...reviewLines(evidence.review),
    "",
  ].join("\n");
}

/**
 * Makes characters that steer a terminal printable: C0 except \n and \t, DEL, C1, and the bidi
 * controls U+202A to U+202E and U+2066 to U+2069. Left as they are, a script, a trial's output
 * or a report could move the cursor, erase lines or reorder text, and the reviewer would read
 * something other than what gets installed.
 */
export function visible(text: string): string {
  return text.replaceAll(
    // oxlint-disable-next-line no-control-regex -- matching them is the point
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x100
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : `\\u${code.toString(16).padStart(4, "0")}`;
    },
  );
}

const LINE = /[^\n]*\n|[^\n]+$/g;

/**
 * A line-based unified diff as hunk lines, empty when the texts are equal. Computed here and not
 * by `diff -u` because both sides are already in memory, and gate 3 never reads the files a
 * second time. undefined past MAX_DIFF_PAIRS line pairs; the caller shows the whole text then.
 */
export function unifiedDiff(before: string, after: string, context = 3): string[] | undefined {
  const a = before.match(LINE) ?? [];
  const b = after.match(LINE) ?? [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }
  const n = tailA - head;
  const m = tailB - head;
  if (n * m > MAX_DIFF_PAIRS) return undefined;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[head + i] === b[head + j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
  const ops: { tag: " " | "-" | "+"; line: string }[] = [];
  for (const line of a.slice(0, head)) ops.push({ tag: " ", line });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const left = a[head + i];
    const right = b[head + j];
    if (i < n && j < m && left === right) {
      ops.push({ tag: " ", line: left ?? "" });
      i++;
      j++;
    } else if (
      j < m &&
      (i === n || (lcs[i * width + j + 1] ?? 0) > (lcs[(i + 1) * width + j] ?? 0))
    ) {
      ops.push({ tag: "+", line: right ?? "" });
      j++;
    } else {
      ops.push({ tag: "-", line: left ?? "" });
      i++;
    }
  }
  for (const line of a.slice(tailA)) ops.push({ tag: " ", line });

  const out: string[] = [];
  const changed = ops.flatMap((op, at) => (op.tag === " " ? [] : [at]));
  for (let c = 0; c < changed.length;) {
    let last = c;
    while (
      last + 1 < changed.length &&
      (changed[last + 1] ?? 0) - (changed[last] ?? 0) <= 2 * context
    )
      last++;
    const from = Math.max(0, (changed[c] ?? 0) - context);
    const to = Math.min(ops.length, (changed[last] ?? 0) + context + 1);
    const hunk = ops.slice(from, to);
    const startA = ops.slice(0, from).filter((op) => op.tag !== "+").length;
    const startB = ops.slice(0, from).filter((op) => op.tag !== "-").length;
    const countA = hunk.filter((op) => op.tag !== "+").length;
    const countB = hunk.filter((op) => op.tag !== "-").length;
    out.push(
      `@@ -${countA === 0 ? startA : startA + 1},${countA} +${countB === 0 ? startB : startB + 1},${countB} @@`,
    );
    for (const op of hunk) {
      if (op.line.endsWith("\n")) out.push(op.tag + op.line.slice(0, -1));
      else out.push(op.tag + op.line, "\\ No newline at end of file");
    }
    c = last + 1;
  }
  return out;
}

const gutter = (lines: readonly string[]) => lines.map((line) => `  | ${visible(line)}`);

/** Text that tars did not write, as lines behind the gutter. */
export const quoted = (text: string) =>
  text === "" ? [] : gutter(text.replace(/\n$/, "").split("\n"));

const domainText = (d: Domain) =>
  d.kind === "any" ? "*" : d.kind === "secret-url" ? "secret:url" : hostText(d);

function sourceSection({ submission, base }: Dossier): string[] {
  const whole = quoted(submission.source);
  if (base.kind === "none") return ["== script.py (a new script) ==", ...whole];
  if (base.kind === "broken")
    return [
      "== script.py ==",
      `!! the library already has ${submission.name}, but it does not load (${visible(base.reason)}); showing the whole text`,
      ...whole,
    ];
  const { version, source } = base.script;
  if (source === submission.source)
    return [
      `== script.py: the same text as version ${version}; only the locked packages differ ==`,
    ];
  const diff = unifiedDiff(source, submission.source);
  if (diff === undefined)
    return [
      `== script.py (updates version ${version}) ==`,
      "!! too large to diff; showing the whole new text",
      ...whole,
    ];
  return [
    `== script.py: changes from version ${version} ==`,
    ...gutter([`--- library ${version}`, "+++ this submission", ...diff]),
  ];
}

function trialLines(trial: TrialRecord, index: number): string[] {
  const stream = (label: string, text: string) => {
    if (text === "") return [];
    const lines = text.replace(/\n$/, "").split("\n");
    return [
      `  ${label}:`,
      ...gutter(lines.slice(0, TRIAL_LINES)),
      ...(lines.length > TRIAL_LINES ? [`  (${lines.length - TRIAL_LINES} more lines)`] : []),
    ];
  };
  return [
    `trial ${index + 1}: ${visible(trial.time)}  exit ${trial.exit}  ${trial.ms} ms${trial.truncated ? "  (output truncated)" : ""}`,
    `  args: ${visible(JSON.stringify(trial.args))}`,
    ...stream("stdout", trial.stdout),
    ...stream("stderr", trial.stderr),
  ];
}

function reviewLines(review: Review): string[] {
  switch (review.kind) {
    case "missing":
      return ["!! no gate 2 report is attached"];
    case "stale":
      return [
        `!! the attached report (${visible(review.time)}) was written for another script.py; not shown`,
      ];
    case "unreadable":
      return ["!! review.md does not start with a review stamp; not shown"];
    case "attached":
      return [`attached at ${visible(review.time)}:`, ...quoted(review.report)];
  }
}

function age(time: string, now: Date): string {
  const ms = now.getTime() - Date.parse(time);
  if (!Number.isFinite(ms) || ms < 0) return "age unknown";
  const hours = Math.floor(ms / 3_600_000);
  return hours < 1
    ? "less than an hour ago"
    : hours < 48
      ? `${hours} h ago`
      : `${Math.floor(hours / 24)} days ago`;
}
