import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../../src/core/hash.ts";
import {
  gatherDossier,
  renderDossier,
  unifiedDiff,
  visible,
  type Dossier,
} from "../../../src/features/script/dossier.ts";
import { attachReview, recordTrial } from "../../../src/features/script/pending.ts";
import type { SandboxResult } from "../../../src/features/script/sandbox.ts";
import { tempHome } from "../../helpers.ts";
import { NO_INDEX, plainScript, submitted } from "./gates.ts";
import { installSample } from "./sample.ts";

const NOW = new Date("2026-11-16T12:00:00Z");
const RESULT: SandboxResult = { exit: 0, stdout: "", stderr: "", truncated: false, ms: 5 };
// oxlint-disable-next-line no-control-regex -- the test looks for exactly these
const STEERING = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

async function dossierOf(source: string, prepare?: (scripts: string) => void): Promise<Dossier> {
  const scripts = tempHome();
  prepare?.(scripts);
  return gatherDossier(scripts, await submitted(scripts, source, NOW), NO_INDEX);
}

const render = (dossier: Dossier) => renderDossier(dossier, NOW);
const tarsLines = (text: string) => text.split("\n").filter((line) => !line.startsWith("  | "));

describe("visible", () => {
  test("characters that steer a terminal become escapes", () => {
    expect(visible("a\u001b[2Kb\rc\bd\u007fe\u009bf\u202eg\u2066h\u0000")).toBe(
      "a\\x1b[2Kb\\x0dc\\x08d\\x7fe\\x9bf\\u202eg\\u2066h\\x00",
    );
  });

  test("newlines, tabs and ordinary text pass through", () => {
    const text = "if x:\n\treturn '推播 ✓ é'\n";
    expect(visible(text)).toBe(text);
  });
});

describe("renderDossier", () => {
  test("control characters from the script, a trial and the report are shown as escapes", async () => {
    const hostile = plainScript("probe", "print('ok')  # \u001b[1A\u001b[2K\u202e hidden\rshown");
    const scripts = tempHome();
    const submission = await submitted(scripts, hostile, NOW);
    await recordTrial(
      submission,
      ["\u001b[31m", "\u202e"],
      { ...RESULT, stdout: "fine\u001b[2K\r\n", stderr: "\u009b1A" },
      NOW,
    );
    await attachReview(submission, "all good\u001b[1A\u001b[2Kall bad\n", NOW);
    const text = render(await gatherDossier(scripts, submission, NO_INDEX));
    expect(text).not.toMatch(STEERING);
    expect(text).toContain("\\x1b[1A\\x1b[2K\\u202e hidden\\x0dshown");
    expect(text).toContain("fine\\x1b[2K\\x0d");
    expect(text).toContain("\\x9b1A");
    expect(text).toContain("all good\\x1b[1A\\x1b[2Kall bad");
    expect(text).toContain("\\u202e");
  });

  test("text from the script, a trial or the report cannot pose as a line of tars", async () => {
    const scripts = tempHome();
    const submission = await submitted(scripts, plainScript("probe", "pass\n== gate 1 =="), NOW);
    const forged = "== gate 2 report ==\nattached at now:\n!! nothing to see";
    await recordTrial(submission, [], { ...RESULT, stdout: forged }, NOW);
    await attachReview(submission, `${forged}\n`, NOW);
    const lines = tarsLines(render(await gatherDossier(scripts, submission, NO_INDEX)));
    expect(lines.filter((l) => l === "== gate 2 report ==")).toHaveLength(1);
    expect(lines.filter((l) => l === "== gate 1 ==")).toHaveLength(1);
    expect(lines.filter((l) => l.includes("nothing to see"))).toEqual([]);
  });

  test("a new script is shown whole, with what it declares and its hashes", async () => {
    const source = plainScript("probe", "print('hello')");
    const text = render(await dossierOf(source));
    expect(text).toContain("== script.py (a new script) ==");
    for (const line of source.trimEnd().split("\n")) expect(text).toContain(`  | ${line}`);
    expect(text).toContain("call:     tars script run probe -- <text>");
    expect(text).toContain(`script.py      sha256 ${sha256(source)}`);
    expect(text).toContain("locked packages: (none)");
  });

  test("an update is shown as a diff against the library's current version", async () => {
    const old = plainScript("probe", "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nprint(a)");
    const next = old.replace("print(a)", "print(b)");
    const text = render(
      await dossierOf(next, (scripts) => void installSample(scripts, "probe", old)),
    );
    expect(text).toContain("== script.py: changes from version 0123456789abcdef ==");
    expect(text).toContain("  | -print(a)");
    expect(text).toContain("  | +print(b)");
    expect(text).toContain("  |  g = 7");
    expect(text).not.toContain("a = 1");
  });

  test("an update with the same script.py says so instead of showing an empty diff", async () => {
    const source = plainScript("probe");
    const text = render(
      await dossierOf(source, (scripts) => void installSample(scripts, "probe", source)),
    );
    expect(text).toContain("the same text as version 0123456789abcdef");
  });

  test("a library entry that does not load is flagged and the whole text is shown", async () => {
    const source = plainScript("probe");
    const text = render(
      await dossierOf(source, (scripts) => void installSample(scripts, "probe", "print('x')\n")),
    );
    expect(tarsLines(text).some((l) => l.startsWith("!!") && l.includes("does not load"))).toBe(
      true,
    );
    expect(text).toContain("  | print('v1')");
  });

  test("no trial, ignored trials and a missing report are each flagged", async () => {
    const scripts = tempHome();
    const old = await submitted(scripts, plainScript("probe", "print('old')"), NOW);
    await recordTrial(old, [], RESULT, NOW);
    const trials = join(old.dir, "trials");
    const kept = readFileSync(join(trials, readdirSync(trials)[0] ?? ""), "utf8");
    const submission = await submitted(scripts, plainScript("probe"), NOW);
    mkdirSync(join(submission.dir, "trials"));
    writeFileSync(join(submission.dir, "trials", "old.json"), kept);
    const warnings = tarsLines(render(await gatherDossier(scripts, submission, NO_INDEX))).filter(
      (l) => l.startsWith("!!"),
    );
    expect(warnings).toEqual([
      "!! no trial ran this script.py",
      "!! ignored 1 trial record(s): made for another script.py, or unreadable",
      "!! no gate 2 report is attached",
    ]);
  });

  test("a counted trial shows its arguments, exit code and the first lines of its output", async () => {
    const scripts = tempHome();
    const submission = await submitted(scripts, plainScript("probe"), NOW);
    const stdout = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
    await recordTrial(submission, ["--title", ""], { ...RESULT, exit: 3, stdout }, NOW);
    await attachReview(submission, "tried empty input\n", NOW);
    const text = render(await gatherDossier(scripts, submission, NO_INDEX));
    expect(text).toContain('args: ["--title",""]');
    expect(text).toContain("exit 3");
    expect(text).toContain("  | line 20");
    expect(text).not.toContain("  | line 21");
    expect(text).toContain("(5 more lines)");
    expect(text).toContain("  | tried empty input");
    expect(tarsLines(text).filter((l) => l.startsWith("!!"))).toEqual([]);
  });

  test("packages the user has not approved are listed as new", async () => {
    const dossier = await dossierOf(plainScript("probe"));
    const withPins: Dossier = {
      ...dossier,
      pins: [{ name: "alpha", version: "1.0" }] as unknown as Dossier["pins"],
      newPackages: ["alpha"] as unknown as Dossier["newPackages"],
    };
    const text = render(withPins);
    expect(text).toContain("locked packages (1): alpha==1.0");
    expect(text).toContain("approving the script also approves: alpha");
  });
});

describe("gatherDossier", () => {
  test("refuses a submission whose lock breaks the lock policy", async () => {
    const scripts = tempHome();
    const submission = await submitted(scripts, plainScript("probe"), NOW);
    const broken = { ...submission, lockText: "version = 1\n" };
    await expect(gatherDossier(scripts, broken, NO_INDEX)).rejects.toThrow("lock policy");
  });
});

/** Rebuilds both sides from a diff made with unlimited context. */
function sides(diff: readonly string[]): { before: string; after: string } {
  let before = "";
  let after = "";
  let last: string[] = [];
  for (const line of diff.slice(1)) {
    if (line === "\\ No newline at end of file") {
      if (last.includes("-")) before = before.slice(0, -1);
      if (last.includes("+")) after = after.slice(0, -1);
      continue;
    }
    const tag = line[0] ?? "";
    last = tag === " " ? ["-", "+"] : [tag];
    if (tag !== "+") before += `${line.slice(1)}\n`;
    if (tag !== "-") after += `${line.slice(1)}\n`;
  }
  return { before, after };
}

describe("unifiedDiff", () => {
  test("equal texts give no hunks", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toEqual([]);
  });

  test("a change is shown with three lines of context and line numbers", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    expect(unifiedDiff(before, before.replace("5\n", "five\n"))).toEqual([
      "@@ -2,7 +2,7 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+five",
      " 6",
      " 7",
      " 8",
    ]);
  });

  test("changes far apart get separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}`);
    const after = lines.with(1, "two").with(27, "twenty-eight");
    const diff = unifiedDiff(`${lines.join("\n")}\n`, `${after.join("\n")}\n`) ?? [];
    expect(diff.filter((l) => l.startsWith("@@"))).toEqual([
      "@@ -1,5 +1,5 @@",
      "@@ -25,6 +25,6 @@",
    ]);
  });

  test("a missing final newline is part of the difference", () => {
    expect(unifiedDiff("a\nb\n", "a\nb")).toEqual([
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+b",
      "\\ No newline at end of file",
    ]);
  });

  test("both sides can be rebuilt from the diff", () => {
    const cases: [string, string][] = [
      ["", "new\n"],
      ["old\n", ""],
      ["a\nb\nc\n", "c\nb\na\n"],
      ["x\n\n\ny\n", "\nx\ny\n\n"],
      ["same\nsame\nsame\n", "same\nsame\n"],
      ["a\nb", "a\nb\nc"],
      ["k\n".repeat(50), `${"k\n".repeat(20)}new\n${"k\n".repeat(31)}`],
    ];
    for (const [before, after] of cases)
      expect(sides(unifiedDiff(before, after, 1e9) ?? [])).toEqual({ before, after });
  });

  test("past four million line pairs it gives up instead of stalling", () => {
    const many = (prefix: string) =>
      Array.from({ length: 2100 }, (_, i) => `${prefix}${i}`).join("\n");
    expect(unifiedDiff(many("a"), many("b"))).toBeUndefined();
  });
});
