import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import { sha256 } from "../../../src/core/hash.ts";
import { parseLock } from "../../../src/features/script/lock.ts";
import {
  attachReview,
  publishSubmission,
  readEvidence,
  readSubmission,
  recordTrial,
  removeSubmission,
} from "../../../src/features/script/pending.ts";
import type { SandboxResult } from "../../../src/features/script/sandbox.ts";
import { tempHome } from "../../helpers.ts";
import { NO_INDEX, plainScript, submitted, ZERO_DEP_LOCK } from "./gates.ts";

const V1 = plainScript("probe", "print('v1')");
const V2 = plainScript("probe", "print('v2')");
const RESULT: SandboxResult = { exit: 0, stdout: "out\n", stderr: "", truncated: false, ms: 5 };
const DAY_MS = 86_400_000;

const root = (scripts: string) => join(scripts, "pending", "probe");
const ids = (scripts: string) =>
  readdirSync(root(scripts))
    .filter((n) => n !== "current")
    .toSorted();

async function refusal(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TarsError);
  return (err as TarsError).message;
}

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const lockOf = () => {
  const parsed = parseLock(ZERO_DEP_LOCK, NO_INDEX);
  if (!parsed.ok) throw new Error("fixture lock");
  return parsed.lock;
};

describe("publishSubmission and readSubmission", () => {
  test("a published submission reads back with the hashes of the bytes that were vetted", async () => {
    const scripts = tempHome();
    const made = await submitted(scripts, V1, new Date("2026-11-16T01:02:03Z"));
    const read = await readSubmission(scripts, "probe");
    expect(read).toEqual(made);
    expect(read.source).toBe(V1);
    expect(read.scriptSha).toBe(sha256(V1));
    expect(read.lockSha).toBe(sha256(ZERO_DEP_LOCK));
    expect(read.gate1Time).toBe("2026-11-16T01:02:03.000Z");
    expect(read.dir).toBe(join(root(scripts), readlinkSync(join(root(scripts), "current"))));
  });

  test("a resubmit that fails gate 1 keeps the earlier submission and leaves nothing of its own", async () => {
    const scripts = tempHome();
    const first = await submitted(scripts, V1);
    const refused = await publishSubmission(
      scripts,
      "probe",
      V2,
      new Date(),
      async () => undefined,
    );
    expect(refused).toBeUndefined();
    expect(await readSubmission(scripts, "probe")).toEqual(first);
    expect(ids(scripts)).toHaveLength(1);
  });

  test("a submit whose check throws keeps the earlier submission and leaves nothing of its own", async () => {
    const scripts = tempHome();
    const first = await submitted(scripts, V1);
    const failing = publishSubmission(scripts, "probe", V2, new Date(), async () => {
      throw new TarsError("uv is not on PATH");
    });
    expect(await refusal(failing)).toContain("uv is not on PATH");
    expect(await readSubmission(scripts, "probe")).toEqual(first);
    expect(ids(scripts)).toHaveLength(1);
  });

  test("a later submit replaces the earlier one and removes its directory", async () => {
    const scripts = tempHome();
    const first = await submitted(scripts, V1);
    const second = await submitted(scripts, V2);
    expect((await readSubmission(scripts, "probe")).source).toBe(V2);
    expect(existsSync(first.dir)).toBe(false);
    expect(ids(scripts)).toEqual([second.dir.split("/").at(-1) ?? ""]);
  });

  test("two submits at once: the one that publishes last wins, and neither loses its own directory midway", async () => {
    const scripts = tempHome();
    const slow = gate();
    const slowStarted = gate();
    const a = publishSubmission(scripts, "probe", V1, new Date(), async (dir) => {
      slowStarted.open();
      await slow.opened;
      writeFileSync(join(dir, "script.py.lock"), ZERO_DEP_LOCK);
      return lockOf();
    });
    await slowStarted.opened;
    const b = await submitted(scripts, V2);
    expect((await readSubmission(scripts, "probe")).source).toBe(V2);
    slow.open();
    const made = await a;
    expect(made?.source).toBe(V1);
    expect(await readSubmission(scripts, "probe")).toEqual(made as NonNullable<typeof made>);
    expect(existsSync(b.dir)).toBe(false);
    expect(ids(scripts)).toHaveLength(1);
  });

  test("a submit killed after moving current leaves a submission readers refuse, and the next submit recovers", async () => {
    const scripts = tempHome();
    const first = await submitted(scripts, V1);
    rmSync(join(first.dir, "gate1.json"));
    expect(await refusal(readSubmission(scripts, "probe"))).toContain("incomplete");
    await submitted(scripts, V2);
    expect((await readSubmission(scripts, "probe")).source).toBe(V2);
  });

  test("a directory a killed submit left is removed once it is a day old, not before", async () => {
    const scripts = tempHome();
    const now = new Date("2026-11-16T00:00:00Z");
    const young = join(root(scripts), "young");
    const old = join(root(scripts), "old");
    for (const dir of [young, old]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "script.py"), V1);
    }
    utimesSync(young, now, new Date(now.getTime() - DAY_MS / 2));
    utimesSync(old, now, new Date(now.getTime() - 2 * DAY_MS));
    await submitted(scripts, V1, now);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });
});

describe("readSubmission refuses", () => {
  test("when nothing is submitted", async () => {
    expect(await refusal(readSubmission(tempHome(), "probe"))).toContain("nothing is submitted");
  });

  test("a script.py changed after gate 1", async () => {
    const scripts = tempHome();
    const made = await submitted(scripts, V1);
    writeFileSync(join(made.dir, "script.py"), V2);
    expect(await refusal(readSubmission(scripts, "probe"))).toContain(
      "script.py changed after gate 1",
    );
  });

  test("a lock changed after gate 1", async () => {
    const scripts = tempHome();
    const made = await submitted(scripts, V1);
    writeFileSync(join(made.dir, "script.py.lock"), `${ZERO_DEP_LOCK}# x\n`);
    expect(await refusal(readSubmission(scripts, "probe"))).toContain(
      "script.py.lock changed after gate 1",
    );
  });

  test("a gate1.json of the wrong shape", async () => {
    const scripts = tempHome();
    const made = await submitted(scripts, V1);
    writeFileSync(join(made.dir, "gate1.json"), '{"script": 1}');
    expect(await refusal(readSubmission(scripts, "probe"))).toContain("not a gate 1 record");
  });

  test("a current that points outside pending/<name>", async () => {
    const scripts = tempHome();
    const other = await submitted(scripts, plainScript("other"));
    mkdirSync(root(scripts), { recursive: true });
    symlinkSync(other.dir, join(root(scripts), "current"));
    expect(await refusal(readSubmission(scripts, "probe"))).toContain("points outside");
  });

  test("a submission whose script.py declares another name", async () => {
    const scripts = tempHome();
    const other = await submitted(scripts, plainScript("other"));
    mkdirSync(root(scripts), { recursive: true });
    const moved = join(root(scripts), "moved");
    mkdirSync(moved);
    for (const file of ["script.py", "script.py.lock", "gate1.json"])
      writeFileSync(join(moved, file), readFileSync(join(other.dir, file)));
    symlinkSync("moved", join(root(scripts), "current"));
    expect(await refusal(readSubmission(scripts, "probe"))).toContain("declares name other");
  });
});

describe("gate 2 evidence", () => {
  test("a trial of this script.py counts; one for other bytes or of the wrong shape is only counted as ignored", async () => {
    const scripts = tempHome();
    const made = await submitted(scripts, V1);
    await recordTrial(made, ["a", ""], RESULT, new Date("2026-11-16T03:00:00Z"));
    writeFileSync(
      join(made.dir, "trials", "old.json"),
      JSON.stringify({
        time: "2026-11-15T00:00:00Z",
        script: sha256(V2),
        args: [],
        ...RESULT,
      }),
    );
    writeFileSync(join(made.dir, "trials", "junk.json"), "{");
    const evidence = await readEvidence(made);
    expect(evidence.trials).toEqual([
      { time: "2026-11-16T03:00:00.000Z", script: sha256(V1), args: ["a", ""], ...RESULT },
    ]);
    expect(evidence.ignoredTrials).toBe(2);
  });

  test("a report is attached to the script.py it reviewed, and a later one replaces it", async () => {
    const scripts = tempHome();
    const made = await submitted(scripts, V1);
    expect((await readEvidence(made)).review).toEqual({ kind: "missing" });
    await attachReview(made, "first\n", new Date("2026-11-16T04:00:00Z"));
    await attachReview(made, "second\nline\n", new Date("2026-11-16T05:00:00Z"));
    expect((await readEvidence(made)).review).toEqual({
      kind: "attached",
      time: "2026-11-16T05:00:00.000Z",
      report: "second\nline\n",
    });
  });

  test("a report written for other bytes is stale, and one without a stamp is unreadable", async () => {
    const scripts = tempHome();
    const old = await submitted(scripts, V1);
    await attachReview(old, "about v1\n", new Date("2026-11-16T04:00:00Z"));
    const review = readFileSync(join(old.dir, "review.md"), "utf8");
    const made = await submitted(scripts, V2);
    expect((await readEvidence(made)).review).toEqual({ kind: "missing" });
    writeFileSync(join(made.dir, "review.md"), review);
    expect((await readEvidence(made)).review).toEqual({
      kind: "stale",
      time: "2026-11-16T04:00:00.000Z",
    });
    writeFileSync(join(made.dir, "review.md"), "looks fine to me\n");
    expect((await readEvidence(made)).review).toEqual({ kind: "unreadable" });
  });

  test("a trial or review that ends after a resubmit is refused instead of recreating the old directory", async () => {
    const scripts = tempHome();
    const old = await submitted(scripts, V1);
    await submitted(scripts, V2);
    expect(await refusal(recordTrial(old, [], RESULT, new Date()))).toContain("submitted again");
    expect(await refusal(attachReview(old, "r\n", new Date()))).toContain("submitted again");
    expect(existsSync(old.dir)).toBe(false);
  });
});

describe("removeSubmission", () => {
  test("removes the approved submission's directory", async () => {
    const scripts = tempHome();
    const made = await submitted(scripts, V1);
    expect(await removeSubmission(scripts, made)).toBe("removed");
    expect(existsSync(made.dir)).toBe(false);
    expect(await refusal(readSubmission(scripts, "probe"))).toContain("nothing is submitted");
  });

  test("leaves a submission that arrived meanwhile in place and says so", async () => {
    const scripts = tempHome();
    const approved = await submitted(scripts, V1);
    const newer = await submitted(scripts, V2);
    expect(await removeSubmission(scripts, approved)).toBe("newer-pending");
    expect(await readSubmission(scripts, "probe")).toEqual(newer);
  });
});
