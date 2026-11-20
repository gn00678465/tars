import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { utf8Bytes } from "../../../src/features/agent/bytes.ts";
import type { SkillEntry } from "../../../src/features/agent/prompt.ts";
import { runTool, type ReadToolContext } from "../../../src/features/agent/tools.ts";
import { OUTPUT_LIMIT } from "../../../src/features/script/metadata.ts";
import { isolatedPaths } from "./db-fixture.ts";

const SKILLS: SkillEntry[] = [
  { name: "demo", description: "a demo", localOnly: false },
  { name: "other", description: "another", localOnly: false },
];

function put(path: string, content: string | Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function world(toolResultBytes = 16384) {
  const paths = isolatedPaths();
  for (const root of [paths.skills, paths.playbooks, paths.outRoot])
    mkdirSync(root, { recursive: true });
  put(join(paths.skills, "demo", "SKILL.md"), "---\nname: demo\n---\nhello\n");
  const ctx: ReadToolContext = { paths, skills: SKILLS, toolResultBytes };
  return { paths, ctx };
}

const lines = (n: number, make = (i: number) => `line ${i}`) =>
  Array.from({ length: n }, (_, i) => `${make(i + 1)}\n`).join("");

const read = (ctx: ReadToolContext, path: string, more: Record<string, unknown> = {}) =>
  runTool("file_read", { path, ...more }, ctx);

const header = (text: string) => text.split("\n")[0];

describe("file_read roots", () => {
  test("files under skills, playbooks and workspace/out are read", async () => {
    const { paths, ctx } = world();
    for (const root of [paths.skills, paths.playbooks, join(paths.outRoot, "files")]) {
      const file = put(join(root, "note.md"), "one\ntwo\n");
      const r = await read(ctx, file);
      expect(r).toEqual({
        status: "done",
        text: `${file} 第 1–2 行，共 2 行\none\ntwo`,
        truncated: false,
      });
    }
  });

  test("a relative path is taken from the skills directory", async () => {
    const { ctx } = world();
    const r = await read(ctx, "demo/SKILL.md");
    expect(r.status).toBe("done");
    expect(r.text).toEndWith("hello");
  });

  test("a symlink inside a root that points outside is refused", async () => {
    const { paths, ctx } = world();
    put(paths.soul, "soul\n");
    symlinkSync(paths.soul, join(paths.skills, "soul-link.md"));
    const r = await read(ctx, join(paths.skills, "soul-link.md"));
    expect(r.status).toBe("failed");
    expect(r.text).toContain("不在可讀的範圍");
  });

  test("a sibling whose name only starts like a root is refused", async () => {
    const { paths, ctx } = world();
    const evil = put(`${paths.skills}-evil/x.md`, "x\n");
    expect((await read(ctx, evil)).text).toContain("不在可讀的範圍");
    expect((await read(ctx, "../skills-evil/x.md")).text).toContain("不在可讀的範圍");
  });

  test("files elsewhere in the data directory are refused", async () => {
    const { paths, ctx } = world();
    put(paths.memory, "memory\n");
    put(join(paths.workspace, ".evidence", "x.txt"), "x\n");
    expect((await read(ctx, paths.memory)).status).toBe("failed");
    expect((await read(ctx, join(paths.workspace, ".evidence", "x.txt"))).status).toBe("failed");
    expect((await read(ctx, "../MEMORY.md")).status).toBe("failed");
  });

  test("a missing file, a directory, an oversized file and a binary file are refused", async () => {
    const { paths, ctx } = world();
    expect((await read(ctx, join(paths.skills, "nope.md"))).text).toContain("不存在");
    expect((await read(ctx, join(paths.skills, "demo"))).text).toContain("不是一般檔案");
    const big = put(join(paths.playbooks, "big.md"), "x".repeat(OUTPUT_LIMIT + 1));
    expect((await read(ctx, big)).text).toContain("超過");
    const bin = put(join(paths.playbooks, "bin.dat"), new Uint8Array([104, 0, 105]));
    expect((await read(ctx, bin)).text).toContain("二進位檔");
  });

  test("a path that is not a non-empty string, or holds NUL, is refused", async () => {
    const { ctx } = world();
    for (const path of ["", 3, undefined, "demo/\0SKILL.md"]) {
      const r = await runTool("file_read", { path }, ctx);
      expect(r).toEqual({ status: "failed", text: "path 必須是非空的字串", truncated: false });
    }
  });
});

describe("paging", () => {
  test("by default 400 lines, with the next page's offset in the header", async () => {
    const { paths, ctx } = world();
    const file = put(join(paths.playbooks, "long.md"), lines(500));
    const first = await read(ctx, file);
    expect(header(first.text)).toBe(`${file} 第 1–400 行，共 500 行；下一頁 offset=401`);
    expect(first.text.split("\n")).toHaveLength(401);
    expect(first.truncated).toBe(false);
    const second = await read(ctx, file, { offset: 401 });
    expect(header(second.text)).toBe(`${file} 第 401–500 行，共 500 行`);
    expect(second.text.split("\n")[1]).toBe("line 401");
    expect(second.text.split("\n").at(-1)).toBe("line 500");
  });

  test("limit sets the page size, up to 2000", async () => {
    const { paths, ctx } = world();
    const file = put(join(paths.playbooks, "long.md"), lines(30));
    expect(header((await read(ctx, file, { offset: 5, limit: 10 })).text)).toBe(
      `${file} 第 5–14 行，共 30 行；下一頁 offset=15`,
    );
    for (const bad of [
      { limit: 0 },
      { limit: 2001 },
      { limit: 1.5 },
      { offset: 0 },
      { offset: "2" },
    ])
      expect((await read(ctx, file, bad)).status).toBe("failed");
  });

  test("an offset past the last line is refused with the line count", async () => {
    const { paths, ctx } = world();
    const file = put(join(paths.playbooks, "short.md"), lines(3));
    const r = await read(ctx, file, { offset: 4 });
    expect(r.status).toBe("failed");
    expect(r.text).toContain("共 3 行");
  });

  test("a page stops at whole lines within tool_result_bytes", async () => {
    const { paths, ctx } = world(1000);
    const file = put(
      join(paths.playbooks, "wide.md"),
      lines(100, (i) => `第 ${i} 行：${"中文內容".repeat(10)}`),
    );
    let offset = 1;
    let seen = 0;
    for (let page = 0; page < 100 && offset > 0; page++) {
      const r = await read(ctx, file, { offset });
      expect(r.status).toBe("done");
      expect(utf8Bytes(r.text)).toBeLessThanOrEqual(1000);
      const body = r.text.split("\n").slice(1);
      expect(body[0]).toBe(`第 ${offset} 行：${"中文內容".repeat(10)}`);
      seen += body.length;
      const next = /下一頁 offset=(\d+)/.exec(header(r.text) ?? "");
      offset = next ? Number(next[1]) : 0;
    }
    expect(seen).toBe(100);
  });

  test("a first line longer than the budget comes back cut, and says so", async () => {
    const { paths, ctx } = world(1000);
    const file = put(join(paths.playbooks, "one.md"), `${"字".repeat(2000)}\nsecond\n`);
    const r = await read(ctx, file);
    expect(r.status).toBe("done");
    expect(r.truncated).toBe(true);
    expect(header(r.text)).toBe(
      `${file} 第 1–1 行，共 2 行；第 1 行太長，只有前段；下一頁 offset=2`,
    );
    expect(utf8Bytes(r.text)).toBeLessThanOrEqual(1000);
    expect(r.text.split("\n")[1]).toMatch(/^字+$/);
  });
});

describe("skill_load", () => {
  test("reads <skills>/<name>/SKILL.md", async () => {
    const { paths, ctx } = world();
    const r = await runTool("skill_load", { name: "demo" }, ctx);
    expect(r).toEqual({
      status: "done",
      text: `${join(paths.skills, "demo", "SKILL.md")} 第 1–4 行，共 4 行\n---\nname: demo\n---\nhello`,
      truncated: false,
    });
  });

  test("an unknown name lists the available ones", async () => {
    const { ctx } = world();
    const r = await runTool("skill_load", { name: "missing" }, ctx);
    expect(r.status).toBe("failed");
    expect(r.text).toContain("demo, other");
  });

  test("a name that is not a slug is refused before any path is built", async () => {
    const { ctx } = world();
    for (const name of ["../demo", "Demo", "", 1])
      expect((await runTool("skill_load", { name }, ctx)).status).toBe("failed");
  });

  test("pages like file_read", async () => {
    const { paths, ctx } = world();
    put(join(paths.skills, "other", "SKILL.md"), lines(10));
    expect(header((await runTool("skill_load", { name: "other", limit: 3 }, ctx)).text)).toBe(
      `${join(paths.skills, "other", "SKILL.md")} 第 1–3 行，共 10 行；下一頁 offset=4`,
    );
  });
});
