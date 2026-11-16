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
      },
    ]);
    expect(deps.io.stderr.join("\n")).toContain("broken");
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
      expect(await tars(deps, "retire", "bark-push")).toBe(0);
      expect(existsSync(dir)).toBe(false);
    }
    const retired = readdirSync(join(scripts, "retired"));
    expect(retired).toHaveLength(2);
    expect(retired.every((n) => n.startsWith("bark-push-"))).toBe(true);
    expect(await tars(deps, "show", "bark-push")).toBe(1);
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
