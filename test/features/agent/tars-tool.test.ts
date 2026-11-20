import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { TarsPaths } from "../../../src/core/paths.ts";
import {
  childEnv,
  classify,
  REFUSAL_TEXT,
  toolText,
  type Classified,
  type ClassifyContext,
} from "../../../src/features/agent/tars-tool.ts";
import { attachReview } from "../../../src/features/script/pending.ts";
import { plainScript, submitted } from "../script/gates.ts";
import { installSample, sampleScript } from "../script/sample.ts";
import { isolatedPaths } from "./db-fixture.ts";

const VERSION = "0123456789abcdef";
const approveCommand = (name: string) => `tars script approve ${name}`;

interface Shape {
  readonly effects?: string;
  readonly domains?: string;
  readonly secret?: string;
}

function source(name: string, shape: Shape = {}): string {
  return sampleScript({
    dependencies: [],
    tarsLines: [
      `name = "${name}"`,
      'summary = "查天氣"',
      ...(shape.secret === undefined ? [] : [`secret = "${shape.secret}"`]),
      `domains = ${shape.domains ?? '["api.example.com"]'}`,
      `effects = "${shape.effects ?? "read-only"}"`,
      'args = "--city <名稱>"',
      'outputs = "一行 JSON"',
      'exit = { 0 = "ok" }',
    ],
  });
}

function world(): { paths: TarsPaths; ctx: ClassifyContext } {
  const paths = isolatedPaths();
  mkdirSync(paths.outRoot, { recursive: true });
  return { paths, ctx: { paths, approveCommand } };
}

function withScript(name = "weather", shape: Shape = {}) {
  const w = world();
  installSample(w.paths.scripts, name, source(name, shape));
  return w;
}

const runArgv = (name: string, rest: string[] = [], args: string[] = []) => [
  "script",
  "run",
  name,
  "--expect-version",
  VERSION,
  "--timeout",
  "120",
  ...rest,
  "--",
  ...args,
];

const reasonOf = (c: Classified) => (c.kind === "refuse" ? c.reason : "");

describe("classify: read-only subcommands", () => {
  const rows: [string[], string[]][] = [
    [
      ["script", "search", "天氣"],
      ["script", "search", "天氣"],
    ],
    [
      ["script", "search", "天氣", "預報", "--json"],
      ["script", "search", "天氣", "預報", "--json"],
    ],
    [
      ["script", "search", "--json", "天氣"],
      ["script", "search", "天氣", "--json"],
    ],
    [
      ["script", "list"],
      ["script", "list"],
    ],
    [
      ["script", "list", "--json"],
      ["script", "list", "--json"],
    ],
    [
      ["script", "show", "weather"],
      ["script", "show", "weather"],
    ],
    [
      ["script", "show", "--json", "weather"],
      ["script", "show", "weather", "--json"],
    ],
    [
      ["secret", "list"],
      ["secret", "list"],
    ],
    [
      ["secret", "list", "--json"],
      ["secret", "list", "--json"],
    ],
    [["cost"], ["cost"]],
    [
      ["cost", "--json"],
      ["cost", "--json"],
    ],
    [
      ["models", "list"],
      ["models", "list"],
    ],
    [
      ["models", "list", "--json"],
      ["models", "list", "--json"],
    ],
  ];

  for (const [argv, canonicalArgv] of rows)
    test(`${argv.join(" ")} is allowed as ${canonicalArgv.join(" ")}`, async () => {
      expect(await classify(argv, world().ctx)).toEqual({
        kind: "allow",
        canonicalArgv,
        timeoutMs: 30_000,
      });
    });
});

describe("classify: refusals", () => {
  const refused: [string, unknown][] = [
    ["memory remember", ["memory", "remember", "x"]],
    ["script approve", ["script", "approve", "weather"]],
    ["script note", ["script", "note", "weather", "x"]],
    ["script submit", ["script", "submit", "./draft"]],
    ["secret set", ["secret", "set", "bark"]],
    ["install", ["install"]],
    ["models refresh", ["models", "refresh"]],
    ["cost adjust", ["cost", "adjust", "anthropic", "--spent", "1"]],
    ["script list --pending", ["script", "list", "--pending"]],
    ["script show --pending", ["script", "show", "weather", "--pending"]],
    ["script show --source", ["script", "show", "weather", "--source"]],
    ["script show of two names", ["script", "show", "a", "b"]],
    ["script show without a name", ["script", "show"]],
    ["script show of a non-slug", ["script", "show", "../x"]],
    ["script search without words", ["script", "search", "--json"]],
    ["script search with an option", ["script", "search", "-x", "天氣"]],
    ["--json twice", ["script", "list", "--json", "--json"]],
    ["cost --json=1", ["cost", "--json=1"]],
    ["an empty argv", []],
    ["argv that is not an array", "script list"],
    ["a non-string element", ["script", "list", 1]],
    ["a NUL", ["script", "search", "a\0b"]],
  ];

  for (const [label, argv] of refused)
    test(`${label} is refused`, async () => {
      expect((await classify(argv, world().ctx)).kind).toBe("refuse");
    });

  const runRefused: [string, string[]][] = [
    ["--timeout=5", ["script", "run", "weather", "--timeout=5"]],
    ["--timeout 301", ["script", "run", "weather", "--timeout", "301"]],
    ["--timeout 0", ["script", "run", "weather", "--timeout", "0"]],
    ["--timeout 1.5", ["script", "run", "weather", "--timeout", "1.5"]],
    ["--timeout without a value", ["script", "run", "weather", "--timeout"]],
    ["--timeout twice", ["script", "run", "weather", "--timeout", "5", "--timeout", "6"]],
    ["an unknown option", ["script", "run", "weather", "--force"]],
    ["a short option", ["script", "run", "weather", "-t", "5"]],
    ["--expect-version from the model", ["script", "run", "weather", "--expect-version", VERSION]],
    ["a second name", ["script", "run", "weather", "other"]],
    ["no name", ["script", "run"]],
    ["a name that is not a slug", ["script", "run", "Weather"]],
  ];

  for (const [label, argv] of runRefused)
    test(`script run with ${label} is refused`, async () => {
      expect((await classify(argv, withScript().ctx)).kind).toBe("refuse");
    });

  test("a script not in the library is refused with the library's reason", async () => {
    const r = await classify(["script", "run", "nope"], world().ctx);
    expect(r.kind).toBe("refuse");
    expect(reasonOf(r)).toContain("nope");
  });

  test("a script still under review is refused, and the reason names who approves it and how", async () => {
    const { paths, ctx } = world();
    await attachReview(
      await submitted(paths.scripts, plainScript("finmind")),
      "tried\n",
      new Date(),
    );
    const r = await classify(["script", "run", "finmind"], ctx);
    expect(r.kind).toBe("refuse");
    expect(reasonOf(r)).toContain("awaiting-approve");
    expect(reasonOf(r)).toContain(approveCommand("finmind"));
  });

  test("REFUSAL_TEXT says nothing happened", () => {
    expect(REFUSAL_TEXT).toContain("沒有任何動作發生");
  });
});

describe("classify: script run", () => {
  test("a read-only script on one fixed host runs without approval, timeout default 120 s", async () => {
    const r = await classify(["script", "run", "weather"], withScript().ctx);
    expect(r).toEqual({ kind: "allow", canonicalArgv: runArgv("weather"), timeoutMs: 150_000 });
  });

  test("--timeout is kept and the child gets 30 s more; arguments after -- pass verbatim", async () => {
    const args = ["--city", "Taipei", "--timeout=5", "--json", "--"];
    const r = await classify(
      ["script", "run", "weather", "--timeout", "5", "--", ...args],
      withScript().ctx,
    );
    expect(r).toEqual({
      kind: "allow",
      canonicalArgv: [
        "script",
        "run",
        "weather",
        "--expect-version",
        VERSION,
        "--timeout",
        "5",
        "--",
        ...args,
      ],
      timeoutMs: 35_000,
    });
  });

  test("options may come before the name", async () => {
    const r = await classify(["script", "run", "--timeout", "300", "weather"], withScript().ctx);
    expect(r.kind).toBe("allow");
    expect(r.kind === "allow" && r.timeoutMs).toBe(330_000);
  });

  const needApproval: [string, Shape][] = [
    ["an external-write script", { effects: "external-write" }],
    ["a local-write script", { effects: "local-write" }],
    ["a script on two hosts", { domains: '["api.example.com", "cdn.example.com"]' }],
    ["a script on a wildcard host", { domains: '["*.example.com"]' }],
    ["a script reaching the secret's url", { domains: '["secret:url"]', secret: "bark" }],
    ["a script reaching any host", { domains: '["*"]' }],
    ["a script with no domains", { domains: "[]" }],
  ];

  for (const [label, shape] of needApproval)
    test(`${label} needs approval`, async () => {
      expect(
        (await classify(["script", "run", "weather"], withScript("weather", shape).ctx)).kind,
      ).toBe("approve");
    });

  test("--out needs approval and carries the real path; the card shows the script's fields", async () => {
    const { paths, ctx } = withScript("weather", { effects: "external-write", secret: "bark" });
    const r = await classify(
      ["script", "run", "weather", "--out", "out/files", "--", "--city", "台北"],
      ctx,
    );
    const real = join(realpathSync(paths.outRoot), "files");
    const canonicalArgv = runArgv("weather", ["--out", real], ["--city", "台北"]);
    expect(r).toEqual({
      kind: "approve",
      canonicalArgv,
      timeoutMs: 150_000,
      fields: {
        action: "run_script",
        script: "weather",
        version: VERSION,
        summary: "查天氣",
        effects: "external-write",
        domains: ["api.example.com"],
        secret: "bark",
        argv: canonicalArgv,
      },
    });
  });

  test("a free script with --out still needs approval", async () => {
    expect(
      (await classify(["script", "run", "weather", "--out", "out/x"], withScript().ctx)).kind,
    ).toBe("approve");
  });

  test("the card's secret is null for a script without one", async () => {
    const r = await classify(
      ["script", "run", "weather"],
      withScript("weather", { effects: "external-write" }).ctx,
    );
    expect(r.kind === "approve" && r.fields.secret).toBeNull();
  });
});

describe("classify: --out", () => {
  const outRefused = ["../x", ".hidden/x", "out", "out/", "out/.hidden/x", "/etc", "x"];

  for (const out of outRefused)
    test(`--out ${out} is refused`, async () => {
      const r = await classify(["script", "run", "weather", "--out", out], withScript().ctx);
      expect(r.kind).toBe("refuse");
      expect(reasonOf(r)).toContain("workspace/out");
    });

  test("--out through a symlink to workspace/.evidence is refused", async () => {
    const { paths, ctx } = withScript();
    mkdirSync(join(paths.workspace, ".evidence"), { recursive: true });
    symlinkSync("../.evidence", join(paths.outRoot, "link"));
    for (const out of ["out/link", "out/link/sub"])
      expect((await classify(["script", "run", "weather", "--out", out], ctx)).kind).toBe("refuse");
  });

  test("a workspace that is a link elsewhere is refused", async () => {
    const { paths, ctx } = withScript();
    const elsewhere = `${paths.data}-elsewhere`;
    mkdirSync(join(elsewhere, "out"), { recursive: true });
    rmSync(paths.workspace, { recursive: true, force: true });
    symlinkSync(elsewhere, paths.workspace);
    const r = await classify(["script", "run", "weather", "--out", "out/x"], ctx);
    expect(r.kind).toBe("refuse");
  });

  test("an absolute path inside workspace/out is accepted as its real path", async () => {
    const { paths, ctx } = withScript();
    const r = await classify(
      ["script", "run", "weather", "--out", join(paths.outRoot, "a", "b")],
      ctx,
    );
    expect(r.kind).toBe("approve");
    expect(r.kind === "approve" && r.canonicalArgv).toContain(
      join(realpathSync(paths.outRoot), "a", "b"),
    );
  });
});

describe("childEnv", () => {
  test("only the listed variables pass, and tars sets its own four", () => {
    const paths = isolatedPaths();
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
      ANTHROPIC_API_KEY: "sk-leak",
      ANTHROPIC_BASE_URL: "http://evil.example",
      TARS_E2E_ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      RANDOM_VAR: "x",
      TARS_IN_SESSION: "",
    };
    expect(childEnv(env, paths)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
      TARS_DATA_DIR: paths.data,
      TARS_LAUNCH_DIR: paths.outRoot,
      TARS_IN_SESSION: "1",
      TARS_OUT_ROOT_ONLY: "1",
    });
  });
});

describe("toolText", () => {
  test("exit 0 is done, anything else failed; stdout and stderr are both shown", () => {
    const ok = toolText({ exit: 0, stdout: "out\n", stderr: "", truncated: false, ms: 1 });
    expect(ok).toEqual({
      status: "done",
      text: "exit 0\n--- stdout ---\nout\n\n--- stderr ---\n",
      truncated: false,
      exit: 0,
    });
    const bad = toolText({ exit: 2, stdout: "", stderr: "boom", truncated: true, ms: 1 });
    expect(bad.status).toBe("failed");
    expect(bad.truncated).toBe(true);
    expect(bad.text).toContain("boom");
  });
});

describe("classify: wiki", () => {
  const allowed: [string[], string[]][] = [
    [
      ["wiki", "search", "王小明", "--also", "小明", "--since", "2026-11-01", "--json"],
      ["wiki", "search", "--also", "小明", "--since", "2026-11-01", "--json", "--", "王小明"],
    ],
    [
      ["wiki", "search", "--limit", "5", "--", "-5% 那天"],
      ["wiki", "search", "--limit", "5", "--", "-5% 那天"],
    ],
    [
      ["wiki", "list"],
      ["wiki", "list"],
    ],
    [
      ["wiki", "list", "people", "--json"],
      ["wiki", "list", "people", "--json"],
    ],
    [
      ["wiki", "show", "people/wang-xiaoming"],
      ["wiki", "show", "people/wang-xiaoming"],
    ],
    [
      ["wiki", "source", "a1b2c3d4/9f8e7d6c", "--json"],
      ["wiki", "source", "a1b2c3d4/9f8e7d6c", "--json"],
    ],
    [
      ["wiki", "status"],
      ["wiki", "status"],
    ],
  ];
  for (const [argv, canonicalArgv] of allowed)
    test(`${argv.join(" ")} is allowed`, async () => {
      expect(await classify(argv, world().ctx)).toEqual({
        kind: "allow",
        canonicalArgv,
        timeoutMs: 30_000,
      });
    });

  const also = (n: number) => Array.from({ length: n }, (_, i) => ["--also", `w${i}`]).flat();
  const refused: [string, string[]][] = [
    ["a seventh --also", ["wiki", "search", "q", ...also(7)]],
    ["--also -x", ["wiki", "search", "q", "--also", "-x"]],
    ["a date that does not exist", ["wiki", "search", "q", "--since", "2026-02-30"]],
    [
      "--since after --until",
      ["wiki", "search", "q", "--since", "2026-11-02", "--until", "2026-11-01"],
    ],
    ["--limit 0", ["wiki", "search", "q", "--limit", "0"]],
    ["--limit 51", ["wiki", "search", "q", "--limit", "51"]],
    ["a query starting with - outside --", ["wiki", "search", "-x"]],
    ["no query", ["wiki", "search", "--json"]],
    ["an unknown category", ["wiki", "list", "notes"]],
    ["a path with capitals", ["wiki", "show", "people/Wang"]],
    ["a path outside the categories", ["wiki", "show", "../agent/wiki"]],
    ["a short ref that is too short", ["wiki", "source", "a1b/9f8e7d6c"]],
    ["wiki sync", ["wiki", "sync"]],
    ["wiki sync --reindex", ["wiki", "sync", "--reindex"]],
    ["wiki reindex", ["wiki", "reindex"]],
    ["wiki status --json", ["wiki", "status", "--json"]],
    ["wiki alone", ["wiki"]],
  ];
  for (const [name, argv] of refused)
    test(`${name} is refused`, async () => {
      expect((await classify(argv, world().ctx)).kind).toBe("refuse");
    });

  test("six --also pass", async () => {
    expect((await classify(["wiki", "search", "q", ...also(6)], world().ctx)).kind).toBe("allow");
  });
});
