import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { run } from "../../../src/main.ts";
import { tempHome, testDeps, type TestDeps } from "../../helpers.ts";
import {
  loadScript,
  recentRuns,
  retireScript,
  addNote,
  scriptsLayout,
} from "../../../src/features/script/library.ts";
import {
  attachReview,
  readEvidence,
  readSubmission,
} from "../../../src/features/script/pending.ts";
import { approveCommand } from "../../../src/features/script/runtime.ts";
import { draftDir, plainScript, submitted } from "./gates.ts";
import { installSample, sampleScript } from "./sample.ts";

function setup() {
  const home = tempHome();
  const data = join(home, "data");
  const scripts = join(data, "scripts");
  const deps = testDeps({ env: { HOME: home, TARS_DATA_DIR: data } });
  return { scripts, deps };
}

const tars = (deps: TestDeps, ...args: string[]) => run(["script", ...args], deps);

describe("tars script list", () => {
  test("lists approved scripts and warns about a broken one without failing", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    installSample(scripts, "broken", "print('no metadata')\n");
    expect(await tars(deps, "list", "--json")).toBe(0);
    expect(JSON.parse(deps.io.stdout.join(""))).toEqual([
      {
        name: "bark-push",
        summary: "推播一則通知到手機",
        secret: "bark",
        effects: "external-write",
        version: "0123456789abcdef",
        state: "approved",
      },
    ]);
    expect(deps.io.stderr.join("\n")).toContain("broken");
  });

  test("lists each script once with the state of its newest version, and only approved versions run", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    await attachReview(await submitted(scripts, plainScript("bark-push")), "tried x\n", new Date());
    await submitted(scripts, plainScript("gcal-day"));
    await attachReview(await submitted(scripts, plainScript("finmind")), "tried y\n", new Date());
    mkdirSync(join(scripts, "pending", "download"), { recursive: true });
    symlinkSync("20990101T000000-000000", join(scripts, "pending", "download", "current"));

    expect(await tars(deps, "list", "--json")).toBe(0);
    const listed = JSON.parse(deps.io.stdout.join(""));
    expect(listed.map((s: { name: string; state: string }) => [s.name, s.state])).toEqual([
      ["bark-push", "awaiting-approve"],
      ["finmind", "awaiting-approve"],
      ["gcal-day", "awaiting-review"],
    ]);
    expect(deps.io.stderr).toEqual([]);

    deps.io.stdout.length = 0;
    expect(await tars(deps, "list")).toBe(0);
    const bark = listed[0] as { version: string };
    expect(bark.version).toMatch(/^[0-9a-f]{16}$/);
    expect(bark.version).not.toBe("0123456789abcdef");
    expect(deps.io.stdout[0]).toStartWith(`bark-push\t${bark.version}\tawaiting-approve\t`);
    expect(await tars(deps, "search", "prints", "--json")).toBe(0);
    expect(JSON.parse(deps.io.stdout.at(-1) ?? "").map((s: { name: string }) => s.name)).toEqual(
      [],
    );
    expect(await tars(deps, "show", "bark-push")).toBe(0);

    deps.io.stderr.length = 0;
    expect(await tars(deps, "run", "finmind")).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("finmind is not approved yet (awaiting-approve)");
    expect(deps.io.stderr.join("\n")).toContain("approve finmind");
    expect(await tars(deps, "show", "gcal-day")).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain(
      "gcal-day is not approved yet (awaiting-review): its adversarial review is not attached",
    );
    expect(deps.io.stderr.join("\n")).not.toContain("no script named");
    expect(await tars(deps, "run", "download")).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("no script named download");
  });

  test("an empty library lists nothing", async () => {
    const { deps } = setup();
    expect(await tars(deps, "list")).toBe(0);
    expect(deps.io.stdout).toEqual([]);
  });

  test("a script whose current points outside its versions is skipped", async () => {
    const { scripts, deps } = setup();
    const dir = installSample(scripts, "bark-push");
    const outside = installSample(scripts, "other");
    rmSync(join(dir, "current"));
    symlinkSync(join(outside, "versions", "0123456789abcdef"), join(dir, "current"));
    expect(await tars(deps, "list", "--json")).toBe(0);
    expect(JSON.parse(deps.io.stdout.join("")).map((s: { name: string }) => s.name)).toEqual([
      "other",
    ]);
    expect(deps.io.stderr.join("\n")).toContain("points outside");
  });
});

describe("tars script search", () => {
  test("ranks by matched words, searches notes, and logs every search", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    const dl = installSample(
      scripts,
      "download",
      sampleScript({
        tarsLines: [
          'name = "download"',
          'summary = "把網址的檔案存下來"',
          'domains = ["*"]',
          'effects = "local-write"',
          'args = "<網址>"',
          'outputs = "存檔路徑"',
          'exit = { 0 = "ok" }',
        ],
      }),
    );
    writeFileSync(join(dl, "NOTES.md"), "- 2026-11-16 大檔案也能推播完成通知\n");
    expect(await tars(deps, "search", "推播", "通知", "網址", "--json")).toBe(0);
    const hits = JSON.parse(deps.io.stdout.join(""));
    expect(hits.map((h: { name: string; matched: number }) => [h.name, h.matched])).toEqual([
      ["download", 3],
      ["bark-push", 2],
    ]);
    const log = readFileSync(join(scripts, "searches.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(log[0] ?? "")).toMatchObject({
      terms: ["推播", "通知", "網址"],
      hits: ["download", "bark-push"],
    });
  });

  test("finds the user's playbooks by file name and summary only, and warns about one without a summary", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    const dir = join(scripts, "..", "playbooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "trip-plan.md"),
      "---\nsummary: 排旅行行程、檢查已存的行程\n---\n# 旅行規劃\n推播\n",
    );
    writeFileSync(join(dir, "notes.md"), "# 行程筆記\n");
    writeFileSync(join(dir, "README.txt"), "行程");
    expect(await tars(deps, "search", "行程", "推播", "--json")).toBe(0);
    expect(JSON.parse(deps.io.stdout.join(""))).toEqual([
      {
        kind: "script",
        name: "bark-push",
        summary: "推播一則通知到手機",
        secret: "bark",
        effects: "external-write",
        matched: 1,
      },
      {
        kind: "playbook",
        name: "trip-plan",
        summary: "排旅行行程、檢查已存的行程",
        path: join(dir, "trip-plan.md"),
        matched: 1,
      },
    ]);
    expect(deps.io.stderr.join("\n")).toContain("skipped playbook notes");
    expect(deps.io.stderr.join("\n")).toContain("summary:");
    expect(readFileSync(join(scripts, "searches.jsonl"), "utf8")).toContain(
      '"hits":["bark-push","playbook:trip-plan"]',
    );
  });

  test("no match exits 0, prints nothing on stdout, and is still logged", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    expect(await tars(deps, "search", "calendar")).toBe(0);
    expect(deps.io.stdout).toEqual([]);
    expect(readFileSync(join(scripts, "searches.jsonl"), "utf8")).toContain('"hits":[]');
  });
});

describe("tars script show", () => {
  test("prints the call, exit codes, notes and recent runs", async () => {
    const { scripts, deps } = setup();
    const dir = installSample(scripts, "bark-push");
    writeFileSync(join(dir, "NOTES.md"), "- 2026-11-16 標題太長會被截斷\n");
    writeFileSync(
      join(dir, "runs.jsonl"),
      '{"time":"2026-11-16T01:00:00.000Z","version":"0123456789abcdef","argsSha256":"00","exit":0,"ms":321}\n',
    );
    expect(await tars(deps, "show", "bark-push")).toBe(0);
    const out = deps.io.stdout.join("\n");
    expect(out).toContain("tars script run bark-push -- --title <文字> --body <文字>");
    expect(out).toContain("  3  金鑰被拒");
    expect(out).toContain("124 timed out");
    expect(out).toContain("標題太長會被截斷");
    expect(out).toContain("exit 0 321 ms");
  });

  test("--source prints the current script.py", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    expect(await tars(deps, "show", "bark-push", "--source")).toBe(0);
    expect(deps.io.stdout.join("\n")).toBe(sampleScript({ name: "bark-push" }).trimEnd());
  });

  test("an unknown script exits 1 and says how to search", async () => {
    const { deps } = setup();
    expect(await tars(deps, "show", "nope")).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("tars script search");
  });

  test("a path as the name is a usage error", async () => {
    const { deps } = setup();
    expect(await tars(deps, "show", "../library")).toBe(2);
  });
});

describe("tars script note", () => {
  test("appends one dated line and keeps earlier notes", async () => {
    const { scripts, deps } = setup();
    const dir = installSample(scripts, "bark-push");
    writeFileSync(join(dir, "NOTES.md"), "- 2026-11-01 舊的\n");
    expect(await tars(deps, "note", "bark-push", "  新的  ")).toBe(0);
    expect(readFileSync(join(dir, "NOTES.md"), "utf8")).toMatch(
      /^- 2026-11-01 舊的\n- \d{4}-\d{2}-\d{2} 新的\n$/,
    );
  });

  test("a multi-line note is a usage error", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    expect(await tars(deps, "note", "bark-push", "a\nb")).toBe(2);
  });
});

describe("tars script retire", () => {
  test("moves the script with its history out of the library, twice without a name clash", async () => {
    const { scripts, deps } = setup();
    for (let i = 0; i < 2; i++) {
      const dir = installSample(scripts, "bark-push");
      writeFileSync(join(dir, "NOTES.md"), `- note ${i}\n`);
      const evidence = join(scripts, "..", "workspace", ".evidence", "bark-push");
      mkdirSync(evidence, { recursive: true });
      expect(await tars(deps, "retire", "bark-push")).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(evidence)).toBe(false);
    }
    const retired = readdirSync(join(scripts, "retired"));
    expect(retired).toHaveLength(2);
    expect(retired.every((n) => n.startsWith("bark-push-"))).toBe(true);
    expect(await tars(deps, "show", "bark-push")).toBe(1);
  });
});

describe("tars script withdraw", () => {
  test("takes back a submission, complete or broken, and leaves the library version running", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    await submitted(scripts, plainScript("bark-push"));
    const broken = await submitted(scripts, plainScript("probe"));
    rmSync(join(broken.dir, "gate1.json"));
    const evidence = join(scripts, "..", "workspace", ".evidence", "probe");
    mkdirSync(evidence, { recursive: true });

    expect(await tars(deps, "withdraw", "probe")).toBe(0);
    expect(deps.io.stdout.at(-1)).toBe("withdrew probe");
    expect(existsSync(broken.dir)).toBe(false);
    expect(existsSync(evidence)).toBe(false);
    expect(await tars(deps, "withdraw", "bark-push")).toBe(0);
    expect(deps.io.stdout.at(-1)).toBe("withdrew bark-push; the library keeps 0123456789abcdef");

    deps.io.stdout.length = 0;
    expect(await tars(deps, "list", "--json")).toBe(0);
    expect(
      JSON.parse(deps.io.stdout.join("")).map((s: { name: string; state: string }) => [
        s.name,
        s.state,
      ]),
    ).toEqual([["bark-push", "approved"]]);
    expect(await tars(deps, "withdraw", "probe")).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("nothing is submitted for probe");
  });
});

describe("library boundaries", () => {
  test("library/<name> as a symlink is refused, even to a valid script", async () => {
    const { scripts, deps } = setup();
    const elsewhere = installSample(join(scripts, "..", "elsewhere"), "bark-push");
    mkdirSync(join(scripts, "library"), { recursive: true });
    symlinkSync(elsewhere, join(scripts, "library", "bark-push"));
    expect(await tars(deps, "show", "bark-push")).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("is not a directory");
  });

  test("a script.py that declares another name is skipped by list", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push", sampleScript({ name: "other" }));
    expect(await tars(deps, "list", "--json")).toBe(0);
    expect(JSON.parse(deps.io.stdout.join(""))).toEqual([]);
    expect(deps.io.stderr.join("\n")).toContain("declares name other");
  });

  test("a version without script.py is listed as broken instead of failing list", async () => {
    const { scripts, deps } = setup();
    const dir = installSample(scripts, "bark-push");
    installSample(scripts, "other");
    rmSync(join(dir, "versions", "0123456789abcdef", "script.py"));
    expect(await tars(deps, "list", "--json")).toBe(0);
    expect(JSON.parse(deps.io.stdout.join("")).map((s: { name: string }) => s.name)).toEqual([
      "other",
    ]);
  });

  test("retire and note after another session retired the script fail with exit 1", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    const layout = scriptsLayout(scripts);
    const script = await loadScript(layout, "bark-push");
    await retireScript(layout, script, new Date());
    await expect(retireScript(layout, script, new Date())).rejects.toThrow(
      "no script named bark-push",
    );
    await expect(addNote(script, "late", new Date())).rejects.toThrow("no script named bark-push");
    expect(await tars(deps, "list")).toBe(0);
  });

  test("a partial line in runs.jsonl does not hide the other runs", async () => {
    const { scripts } = setup();
    const dir = installSample(scripts, "bark-push");
    writeFileSync(
      join(dir, "runs.jsonl"),
      '{"time":"t1","version":"v","exit":0,"ms":1}\n{"time":"t2","version":"v","exit":3,"ms":2}\n{"time":"t3","ver',
    );
    const runs = await recentRuns(await loadScript(scriptsLayout(scripts), "bark-push"), 5);
    expect(runs.map((r) => r.time)).toEqual(["t1", "t2"]);
  });

  test("loadScript refuses a path as the name", async () => {
    const { scripts } = setup();
    await expect(loadScript(scriptsLayout(scripts), "../pending/x")).rejects.toThrow(
      "invalid script name",
    );
  });
});

describe("tars script submit", () => {
  test("a draft gate 1 refuses exits 1 with each problem on stderr and nothing on stdout", async () => {
    const { scripts, deps } = setup();
    const draft = draftDir(sampleScript({ name: "bark-push", extraTop: "[tool.uv]" }));
    expect(await tars(deps, "submit", draft)).toBe(1);
    expect(deps.io.stdout).toEqual([]);
    expect(deps.io.stderr.join("\n")).toContain("gate 1: ");
    expect(deps.io.stderr.join("\n")).toContain("tool.uv");
    expect(existsSync(join(scripts, "pending"))).toBe(false);
  });

  test("a directory without script.py exits 1", async () => {
    const { deps } = setup();
    expect(await tars(deps, "submit", tempHome())).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("no script.py");
  });
});

describe("approveCommand", () => {
  test("is the bare command when the data directory is the account's default", () => {
    expect(approveCommand("bark-push", "/home/u/.local/share/tars", "/home/u")).toBe(
      "tars script approve bark-push",
    );
  });

  test("pins any other data directory, quoted for a shell", () => {
    expect(approveCommand("bark-push", "/srv/it's here/tars", "/home/u")).toBe(
      "TARS_DATA_DIR='/srv/it'\\''s here/tars' tars script approve bark-push",
    );
  });
});

describe("tars script review", () => {
  const reportFile = (content: string | Uint8Array) => {
    const path = join(tempHome(), "review.md");
    writeFileSync(path, content);
    return path;
  };

  test("attaches the report to the submission under review", async () => {
    const { scripts, deps } = setup();
    const made = await submitted(scripts, plainScript("bark-push"));
    expect(await tars(deps, "review", "bark-push", "--report", reportFile("tried x\n"))).toBe(0);
    expect((await readEvidence(made)).review).toMatchObject({
      kind: "attached",
      report: "tried x\n",
    });
    expect(deps.io.stdout.join("\n")).toContain(made.scriptSha.slice(0, 12));
  });

  test("refuses a report that is too large, not UTF-8, or empty, and attaches nothing", async () => {
    const { scripts, deps } = setup();
    const made = await submitted(scripts, plainScript("bark-push"));
    for (const bad of ["x".repeat(32 * 1024 + 1), new Uint8Array([0xff, 0xfe, 0x41]), " \n"])
      expect(await tars(deps, "review", "bark-push", "--report", reportFile(bad))).toBe(1);
    expect(await tars(deps, "review", "bark-push", "--report", "/no/such/file")).toBe(1);
    expect((await readEvidence(made)).review).toEqual({ kind: "missing" });
  });

  test("with nothing submitted it exits 1", async () => {
    const { deps } = setup();
    expect(await tars(deps, "review", "bark-push", "--report", reportFile("r\n"))).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("nothing is submitted");
  });

  test("without --report it is a usage error", async () => {
    const { deps } = setup();
    expect(await tars(deps, "review", "bark-push")).toBe(2);
  });
});

describe("tars script show --pending", () => {
  test("prints the submission's dossier on stdout", async () => {
    const { scripts, deps } = setup();
    const source = plainScript("bark-push", "print('pending body')");
    await submitted(scripts, source);
    expect(await tars(deps, "show", "bark-push", "--pending")).toBe(0);
    const out = deps.io.stdout.join("\n");
    expect(out).toContain("  | print('pending body')");
    expect(out).toContain("== gate 1 ==");
    expect(out).toContain("!! no gate 2 report is attached");
    expect((await readSubmission(scripts, "bark-push")).source).toBe(source);
  });

  test("shows the submission, not the library version of the same name", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push", plainScript("bark-push", "print('in library')"));
    await submitted(scripts, plainScript("bark-push", "print('pending body')"));
    expect(await tars(deps, "show", "bark-push", "--pending")).toBe(0);
    expect(deps.io.stdout.join("\n")).toContain("  | +print('pending body')");
  });

  test("with nothing submitted it exits 1", async () => {
    const { scripts, deps } = setup();
    installSample(scripts, "bark-push");
    expect(await tars(deps, "show", "bark-push", "--pending")).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("nothing is submitted");
  });

  test("with --source or --json it is a usage error", async () => {
    const { scripts, deps } = setup();
    await submitted(scripts, plainScript("bark-push"));
    expect(await tars(deps, "show", "bark-push", "--pending", "--source")).toBe(2);
    expect(await tars(deps, "show", "bark-push", "--pending", "--json")).toBe(2);
    expect(deps.io.stdout).toEqual([]);
  });
});
