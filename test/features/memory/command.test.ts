import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseMemory } from "../../../src/features/memory/document.ts";
import { LockTimeoutError, updateMemoryFile } from "../../../src/features/memory/store.ts";
import { SAMPLE, sampleMemoryFile } from "./sample.ts";

const CLI = join(import.meta.dir, "cli.ts");
const lockOf = (memoryPath: string) => join(dirname(memoryPath), ".MEMORY.md.lock");

function tars(memoryPath: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, memoryPath, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const remember = (path: string, id: string, section: string, text: string, ...rest: string[]) =>
  tars(
    path,
    "remember",
    "--id",
    id,
    "--section",
    section,
    "--text",
    text,
    "--source",
    "user",
    "--date",
    "2026-02-01",
    ...rest,
  );

describe("tars memory remember", () => {
  test("adds a new active entry at the end of its section and keeps every other byte", () => {
    const path = sampleMemoryFile();
    chmodSync(path, 0o600);
    const out = remember(path, "pref-new", "偏好", "新的偏好。");
    expect(out).toMatchObject({ code: 0, stdout: "added pref-new\n" });
    expect(readFileSync(path, "utf8")).toBe(
      SAMPLE.replace(
        "- 回覆先講結論。\n",
        "- 回覆先講結論。\n\n<!-- id: pref-new | observed: 2026-02-01 | status: active | source: user -->\n- 新的偏好。\n",
      ),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("creates a missing section at the end of the file", () => {
    const path = sampleMemoryFile();
    expect(remember(path, "fact-city", "長期事實", "住在台北。").code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(
      `${SAMPLE}\n## 長期事實\n\n<!-- id: fact-city | observed: 2026-02-01 | status: active | source: user -->\n- 住在台北。\n`,
    );
  });

  test("an existing active id becomes superseded and the new entry goes directly below it", () => {
    const path = sampleMemoryFile();
    const out = remember(path, "pref-tabs", "偏好", "縮排用四個空白。");
    expect(out).toMatchObject({ code: 0, stdout: "replaced pref-tabs\n" });
    expect(readFileSync(path, "utf8")).toBe(
      SAMPLE.replace(
        "<!-- id: pref-tabs | observed: 2026-01-05 | status: active -->\n- 縮排用兩個空白。\n",
        "<!-- id: pref-tabs | observed: 2026-01-05 | status: superseded -->\n- 縮排用兩個空白。\n\n" +
          "<!-- id: pref-tabs | observed: 2026-02-01 | status: active | source: user -->\n- 縮排用四個空白。\n",
      ),
    );
  });

  test("repeating the same remember is a no-op that exits 0", () => {
    const path = sampleMemoryFile();
    expect(remember(path, "pref-new", "偏好", "新的偏好。").stdout).toBe("added pref-new\n");
    const after = readFileSync(path, "utf8");
    expect(remember(path, "pref-new", "偏好", "新的偏好。")).toMatchObject({
      code: 0,
      stdout: "unchanged pref-new\n",
    });
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  test("an id that lives in another section is a usage error", () => {
    const path = sampleMemoryFile();
    const out = remember(path, "pref-tabs", "決定", "縮排用四個空白。");
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--section 偏好");
    expect(readFileSync(path, "utf8")).toBe(SAMPLE);
  });

  test("--json prints the result as an object", () => {
    const path = sampleMemoryFile();
    const out = remember(path, "pref-new", "偏好", "新的偏好。", "--json");
    expect(JSON.parse(out.stdout)).toEqual({
      result: "added",
      id: "pref-new",
      section: "偏好",
      status: "active",
    });
  });
});

describe("tars memory forget", () => {
  test("--id marks the active entry superseded and keeps its text", () => {
    const path = sampleMemoryFile();
    expect(tars(path, "forget", "--id", "pref-short")).toMatchObject({
      code: 0,
      stdout: "forgotten pref-short\n",
    });
    expect(readFileSync(path, "utf8")).toBe(
      SAMPLE.replace(
        "pref-short | observed: 2026-01-03 | status: active",
        "pref-short | observed: 2026-01-03 | status: superseded",
      ),
    );
  });

  test("forgetting an id that is already superseded is a no-op that exits 0", () => {
    const path = sampleMemoryFile();
    expect(tars(path, "forget", "--id", "pref-short").code).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(tars(path, "forget", "--id", "pref-short")).toMatchObject({
      code: 0,
      stdout: "unchanged pref-short\n",
    });
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  test("an unknown id exits 1", () => {
    const path = sampleMemoryFile();
    expect(tars(path, "forget", "--id", "pref-nope").code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(SAMPLE);
  });

  test("--match that hits one active entry forgets it, ignoring case", () => {
    const path = sampleMemoryFile();
    const out = tars(path, "forget", "--match", "helix", "--json");
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      result: "forgotten",
      id: "dec-editor",
      section: "決定",
      status: "superseded",
    });
    expect(readFileSync(path, "utf8")).toContain(
      "<!-- id: dec-editor | observed: 2026-01-04 | status: superseded -->",
    );
  });

  test("--match that hits several active entries refuses and lists their ids", () => {
    const path = sampleMemoryFile();
    const out = tars(path, "forget", "--match", "用");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("pref-tabs");
    expect(out.stderr).toContain("dec-editor");
    expect(out.stderr).not.toContain("pref-short");
    expect(readFileSync(path, "utf8")).toBe(SAMPLE);
  });

  test("--match that hits no active entry exits 1, superseded entries do not count", () => {
    const path = sampleMemoryFile();
    const out = tars(path, "forget", "--match", "tab");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("no active entry");
    expect(readFileSync(path, "utf8")).toBe(SAMPLE);
  });
});

describe("failures and usage errors", () => {
  test("a missing memory file exits 1 and points to tars install", () => {
    const path = sampleMemoryFile();
    rmSync(path);
    const out = remember(path, "pref-new", "偏好", "新的偏好。");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("tars install");
    expect(existsSync(path)).toBe(false);
  });

  test.each([
    ["remember without --id", ["remember", "--section", "偏好", "--text", "x", "--source", "user"]],
    [
      "remember with a bad id",
      ["remember", "--id", "Pref Bad", "--section", "偏好", "--text", "x", "--source", "user"],
    ],
    [
      "remember with an unknown source",
      ["remember", "--id", "pref-x", "--section", "偏好", "--text", "x", "--source", "web"],
    ],
    [
      "remember with a bad date",
      [
        "remember",
        "--id",
        "pref-x",
        "--section",
        "偏好",
        "--text",
        "x",
        "--source",
        "user",
        "--date",
        "2026-2-1",
      ],
    ],
    ["forget with neither --id nor --match", ["forget"]],
    ["forget with both --id and --match", ["forget", "--id", "pref-short", "--match", "結論"]],
  ])("%s exits 2 and changes nothing", (_name, args) => {
    const path = sampleMemoryFile();
    expect(tars(path, ...args).code).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(SAMPLE);
  });
});

describe("concurrency", () => {
  test("concurrent writer processes all land", async () => {
    const path = sampleMemoryFile();
    const writers = ["w0", "w1", "w2", "w3", "w4", "w5"];
    const perWriter = 15;
    const procs = writers.map((w) =>
      Bun.spawn(["bun", join(import.meta.dir, "remember-many.ts"), path, w, String(perWriter)], {
        stderr: "pipe",
      }),
    );
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual(writers.map(() => 0));

    const ids = parseMemory(readFileSync(path, "utf8")).blocks.flatMap((b) =>
      b.kind === "entry" && b.entry.status === "active" ? [b.entry.id] : [],
    );
    const expected = writers.flatMap((w) =>
      Array.from({ length: perWriter }, (_, i) => `${w}-${i}`),
    );
    expect(ids.filter((id) => /^w\d-/.test(id)).toSorted()).toEqual(expected.toSorted());
    expect(ids).toContain("pref-short");
    expect(existsSync(lockOf(path))).toBe(false);
  }, 30_000);

  test("a lock left by a dead process is recovered", async () => {
    const path = sampleMemoryFile();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(lockOf(path), `${dead.pid}\n`);
    expect(remember(path, "pref-new", "偏好", "新的偏好。")).toMatchObject({
      code: 0,
      stdout: "added pref-new\n",
    });
    expect(existsSync(lockOf(path))).toBe(false);
  });

  test("a lock held by a live process makes the writer give up after the timeout", async () => {
    const path = sampleMemoryFile();
    writeFileSync(lockOf(path), `${process.pid}\n`);
    const op = { kind: "forget-id", id: "pref-short" } as const;
    const started = Date.now();
    const error = await updateMemoryFile(path, op, 200).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readFileSync(path, "utf8")).toBe(SAMPLE);
    expect(readFileSync(lockOf(path), "utf8")).toBe(`${process.pid}\n`);
  });
});
