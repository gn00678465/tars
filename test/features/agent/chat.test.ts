import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import { resolvePaths } from "../../../src/core/paths.ts";
import type { Terminal } from "../../../src/core/terminal.ts";
import { BUILTINS, parseSlash } from "../../../src/features/agent/chat.ts";
import { SUMMARY_HEADINGS } from "../../../src/features/agent/compaction.ts";
import { acquireLock, openDb } from "../../../src/features/agent/db.ts";
import {
  LOCAL_ONLY_SKILLS,
  skillInvocationText,
  type SkillEntry,
} from "../../../src/features/agent/prompt.ts";
import { adapterFor } from "../../../src/features/agent/provider.ts";
import { appendItems, beginTurn, createConversation } from "../../../src/features/agent/store.ts";
import { text, toolUse, type FakeReply } from "../../fakes/anthropic.ts";
import { fakeSecrets, scriptedTerminal, tempHome, testDeps, TEST_NOW } from "../../helpers.ts";
import { run } from "../../../src/main.ts";
import { resetReconcileWarnings } from "../../../src/features/agent/openrouter-key.ts";
import { compatText } from "../../fakes/openai-compat.ts";
import { compatHarness, OPENROUTER_ENTRY, type CompatHarness } from "./compat-fixture.ts";
import {
  configWith,
  engineHarness,
  MODEL_ENTRY,
  MODEL_ID,
  REPO,
  writeCatalog,
  type EngineHarness,
  type HarnessOptions,
} from "./engine-fixture.ts";

const harnesses: EngineHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.fake.stop();
});

/** A data dir and fake server; the harness's own connection is closed so chat opens its own. */
async function setup(opts: HarnessOptions = {}): Promise<EngineHarness> {
  const h = await engineHarness(opts);
  h.db.close();
  harnesses.push(h);
  return h;
}

type Answer = Parameters<typeof scriptedTerminal>[0][number];

function chatDeps(
  h: EngineHarness,
  opts: { answers?: readonly Answer[]; env?: Record<string, string> } = {},
) {
  const signals = new EventEmitter();
  const terminal = opts.answers === undefined ? undefined : scriptedTerminal(opts.answers);
  const deps = testDeps({
    env: { ...h.env, ...opts.env },
    secrets: fakeSecrets({ "llm:anthropic": "sk-test" }),
    adapterFor,
    selfCommand: [process.execPath, join(REPO, "src/main.ts")],
    signals,
    ...(terminal === undefined ? {} : { openTerminal: (): Terminal => terminal }),
  });
  return { deps, signals, terminal };
}

const err = (d: { io: { stderr: string[] } }) => d.io.stderr.join("\n");
const out = (d: { io: { stdout: string[] } }) => d.io.stdout.join("");

function query<T>(h: EngineHarness, sql: string, ...params: string[]): T[] {
  const db = new Database(h.paths.agentDb, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const counts = (h: EngineHarness) =>
  ["conversations", "turns", "items", "usage"].map(
    (t) => query<{ n: number }>(h, `SELECT COUNT(*) AS n FROM ${t}`)[0]?.n,
  );

/** The text of the first block of the last user message of request `i` (default: the last). */
function lastUserText(h: EngineHarness, i = -1): string {
  const body = h.fake.messages().at(i)?.body as
    | { messages: { role: string; content: { type: string; text?: string }[] }[] }
    | undefined;
  const user = body?.messages.filter((m) => m.role === "user").at(-1);
  return user?.content.find((b) => b.type === "text")?.text ?? "";
}

const summary = SUMMARY_HEADINGS.map((h) => `## ${h}\n- kept`).join("\n\n");
const big = (n: number) => `turn ${n} ${"x".repeat(2600)}`;

describe("options", () => {
  test.each([
    [["--model", `anthropic/${MODEL_ID}`, "--resume", "abcd"]],
    [["--list", "--model", `anthropic/${MODEL_ID}`]],
    [["--list", "--effort", "low"]],
    [["--list", "--resume", "abcd"]],
    [["--list", "--message", "hi"]],
    [["--effort", "extreme"]],
    [["--model", "no-slash"]],
  ])("chat %p is a usage error", async (args) => {
    const h = await setup();
    const { deps } = chatDeps(h);
    expect(await run(["chat", ...args], deps)).toBe(2);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("inside a tars session it is refused", async () => {
    const h = await setup();
    const { deps } = chatDeps(h, { env: { TARS_IN_SESSION: "1" } });
    expect(await run(["chat", "--message", "hi"], deps)).toBe(1);
    expect(err(deps)).toContain("只給你自己終端的 tars chat 用");
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("--list without a database lists nothing and creates nothing", async () => {
    const home = tempHome();
    const env = { HOME: home, TARS_DATA_DIR: join(home, "data"), XDG_CONFIG_HOME: join(home, "c") };
    const deps = testDeps({ env });
    expect(await run(["chat", "--list"], deps)).toBe(0);
    expect(deps.io.stdout).toEqual([]);
    expect(existsSync(resolvePaths(env).agentDb)).toBe(false);
  });

  test("--list works while another tars chat holds the lock", async () => {
    const h = await setup();
    h.fake.reply(text("hello"));
    expect(await run(["chat", "--message", "first message"], chatDeps(h).deps)).toBe(0);
    const lock = await acquireLock(h.paths, new Date(TEST_NOW));
    try {
      const { deps } = chatDeps(h);
      expect(await run(["chat", "--list"], deps)).toBe(0);
      const [line] = deps.io.stdout;
      const cols = line?.split("\t") ?? [];
      expect(cols).toHaveLength(6);
      expect(cols[1]).toBe("first message");
      expect(cols[2]).toBe(`anthropic/${MODEL_ID}`);
      expect(cols[3]).toBe("medium");
      expect(cols[4]).toBe(new Date(TEST_NOW).toISOString());
      expect(cols[5]).toBe("");
    } finally {
      lock.release();
    }
  });

  test("a second tars chat is refused while the lock is held", async () => {
    const h = await setup();
    const lock = await acquireLock(h.paths, new Date(TEST_NOW));
    try {
      const { deps } = chatDeps(h);
      expect(await run(["chat", "--message", "hi"], deps)).toBe(1);
      expect(err(deps)).toContain(`pid ${process.pid}`);
      expect(h.fake.messages()).toHaveLength(0);
    } finally {
      lock.release();
    }
  });

  test("without a default model it exits 1, listing the active models and the fix", async () => {
    const h = await setup();
    writeCatalog(h.paths, [{ ...MODEL_ENTRY, default: false }]);
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--message", "hi"], deps)).toBe(1);
    expect(err(deps)).toContain(`anthropic/${MODEL_ID}`);
    expect(err(deps)).toContain("tars models default");
    expect(existsSync(h.paths.agentLockInfo)).toBe(false);
  });

  test("without a key it exits 1 before the database is touched", async () => {
    const h = await setup();
    const deps = testDeps({ env: h.env, secrets: fakeSecrets(), adapterFor });
    expect(await run(["chat", "--message", "hi"], deps)).toBe(1);
    expect(err(deps)).toContain("tars llm key set anthropic");
    expect(existsSync(h.paths.agentLockInfo)).toBe(false);
  });

  test("a keyring that cannot be reached exits 1 saying so, not as a missing key", async () => {
    const h = await setup();
    const secrets = {
      ...fakeSecrets(),
      get: async () => {
        throw new Error("cannot reach the OS keyring: no session bus");
      },
    };
    const deps = testDeps({ env: h.env, secrets, adapterFor });
    expect(await run(["chat", "--message", "hi"], deps)).toBe(1);
    expect(err(deps)).toContain("讀不到本機的系統金鑰庫：cannot reach the OS keyring");
    expect(err(deps)).not.toContain("tars llm key set");
    expect(existsSync(h.paths.agentLockInfo)).toBe(false);
  });

  test("--effort with a level the model lacks exits 1 and lists the levels", async () => {
    const h = await setup();
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--effort", "max", "--message", "hi"], deps)).toBe(1);
    expect(err(deps)).toContain("low, medium, high");
  });
});

describe("--message", () => {
  test("a completed turn exits 0 with only the reply on stdout", async () => {
    const h = await setup();
    h.fake.reply(text("the reply"));
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--message", "hi"], deps)).toBe(0);
    expect(out(deps)).toBe("the reply\n");
    expect(err(deps)).toContain("用量：");
  });

  test("a bookkeeping message goes to the model, whose prompt offers fava-ledger for it", async () => {
    const h = await setup();
    h.fake.reply(text("先用 --dry-run 給你看預覽"));
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--message", "幫我記一筆午餐 120 元"], deps)).toBe(0);
    const requests = h.fake.messages();
    expect(requests).toHaveLength(1);
    const blocks = (requests[0]?.body.system ?? []) as { text: string }[];
    const system = blocks.map((b) => b.text).join("\n");
    const refused = system.split("\n").find((l) => l.startsWith("這個入口不提供")) ?? "";
    expect(refused).not.toContain("記帳");
    expect(system).toContain("記帳與查帳在這裡用入庫的 fava-ledger 腳本");
    expect(lastUserText(h, 0)).toBe("幫我記一筆午餐 120 元");
  });

  test("a turn that does not complete exits 1", async () => {
    const h = await setup();
    h.fake.reply({ kind: "http_error", status: 401, type: "authentication_error" });
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--message", "hi"], deps)).toBe(1);
    expect(query<{ state: string }>(h, "SELECT state FROM turns")).toEqual([{ state: "failed" }]);
  });

  test("SIGTERM during a turn aborts it and exits 143", async () => {
    const h = await setup();
    const { deps, signals } = chatDeps(h);
    h.fake.handler = () => {
      setTimeout(() => signals.emit("SIGTERM"), 50);
      return { kind: "hang" };
    };
    expect(await run(["chat", "--message", "hi"], deps)).toBe(143);
    expect(query<{ state: string }>(h, "SELECT state FROM turns")).toEqual([{ state: "aborted" }]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});

describe("--resume", () => {
  async function conversations(h: EngineHarness, ids: readonly string[]) {
    const db = await openDb(h.paths);
    try {
      for (const id of ids)
        createConversation(db, {
          id,
          text: `title ${id}`,
          provider: "anthropic",
          model: MODEL_ID,
          effort: "low",
          now: TEST_NOW,
        });
    } finally {
      db.close();
    }
  }

  test("a tail of the id resumes; the recent items show the compaction line", async () => {
    const h = await setup();
    const id = "01a1f461-0000-7000-8000-00000000abcd";
    await conversations(h, [id]);
    const db = await openDb(h.paths);
    beginTurn(db, { id: "turn-1", convId: id, kind: "chat", effort: "low", now: TEST_NOW });
    appendItems(
      db,
      id,
      "turn-1",
      [
        { kind: "user", step: 0, body: { text: "earlier question" } },
        {
          kind: "assistant",
          step: 1,
          body: { text: "earlier answer", state: "complete", native: null },
        },
        { kind: "user", step: 0, body: { text: "kept question" } },
        {
          kind: "compaction",
          step: 1,
          body: {
            firstKeptSeq: 3,
            summary,
            tokensBefore: 100,
            replacedCount: 2,
            trigger: "manual",
            usageId: 0,
          },
        },
      ],
      TEST_NOW,
    );
    db.close();
    h.fake.reply(text("resumed"));
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--resume", "abcd", "--message", "again"], deps)).toBe(0);
    expect(err(deps)).toContain(`接續對話 ${id}`);
    expect(err(deps)).toContain("（這之前的內容已壓縮成摘要）");
    expect(err(deps)).toContain("你：kept question");
    // The seeded turn was left running, so reconcile settles it before the new one runs.
    expect(
      query<{ id: string; state: string }>(
        h,
        "SELECT id, state FROM turns WHERE conv_id = ? ORDER BY rowid",
        id,
      ).map((t) => t.state),
    ).toEqual(["interrupted", "completed"]);
    // The conversation's own level, not the config default.
    expect(h.fake.messages()[0]?.body.output_config).toEqual({ effort: "low" });
  });

  test("--resume with --effort changes the conversation's level", async () => {
    const h = await setup();
    const id = "01a1f461-0000-7000-8000-00000000beef";
    await conversations(h, [id]);
    h.fake.reply(text("ok"));
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--resume", id, "--effort", "high", "--message", "x"], deps)).toBe(0);
    expect(query<{ effort: string }>(h, "SELECT effort FROM conversations")).toEqual([
      { effort: "high" },
    ]);
  });

  test("a tail naming two conversations exits 1 and lists both", async () => {
    const h = await setup();
    const ids = ["01a1f461-0000-7000-8000-0000aaaa1234", "01a1f461-0000-7000-8000-0000bbbb1234"];
    await conversations(h, ids);
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--resume", "1234", "--message", "x"], deps)).toBe(1);
    for (const id of ids) expect(err(deps)).toContain(id);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("a tail shorter than 4 characters is refused", async () => {
    const h = await setup();
    await conversations(h, ["01a1f461-0000-7000-8000-00000000abcd"]);
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--resume", "bcd", "--message", "x"], deps)).toBe(1);
    expect(err(deps)).toContain("至少要 4 碼");
  });
});

describe("parseSlash", () => {
  const skill = (name: string, localOnly = false): SkillEntry => ({
    name,
    description: `${name} skill`,
    localOnly,
  });
  const demo = skill("demo");
  const memory = skill("memory", true);
  const skills = [demo, skill("model"), memory];

  test("plain text is a message; // sends the rest with one slash", () => {
    expect(parseSlash("hello /there", skills)).toEqual({ kind: "message", text: "hello /there" });
    expect(parseSlash("//etc/hosts 是什麼", skills)).toEqual({
      kind: "message",
      text: "/etc/hosts 是什麼",
    });
  });

  test("a built-in command wins over a skill of the same name", () => {
    expect(parseSlash("/model", skills)).toEqual({ kind: "builtin", name: "model", arg: "" });
    expect(parseSlash("/wiki 財報", skills)).toEqual({
      kind: "builtin",
      name: "wiki",
      arg: "財報",
    });
    expect(parseSlash("/compact   keep the weather  ", skills)).toEqual({
      kind: "builtin",
      name: "compact",
      arg: "keep the weather",
    });
  });

  test("a skill in the index, with or without content", () => {
    expect(parseSlash("/demo 我想學\n線性代數", skills)).toEqual({
      kind: "skill",
      skill: demo,
      content: "我想學\n線性代數",
    });
    expect(parseSlash("/demo", skills)).toEqual({ kind: "skill", skill: demo, content: "" });
  });

  test("a local-only skill is not a skill to send", () => {
    expect(parseSlash("/memory 記住這個", skills)).toEqual({
      kind: "local_only",
      skill: memory,
    });
  });

  test("an unknown or malformed name is unknown", () => {
    expect(parseSlash("/nope", skills)).toEqual({ kind: "unknown", name: "nope" });
    expect(parseSlash("/Demo", skills)).toEqual({ kind: "unknown", name: "Demo" });
    expect(parseSlash("/../x", skills)).toEqual({ kind: "unknown", name: "../x" });
    expect(parseSlash("/", skills)).toEqual({ kind: "unknown", name: "" });
  });
});

describe("interactive", () => {
  function addSkill(h: EngineHarness, name: string, description = `${name} skill`) {
    mkdirSync(join(h.paths.skills, name), { recursive: true });
    writeFileSync(
      join(h.paths.skills, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
    );
  }

  test("end of input at the prompt exits 0", async () => {
    const h = await setup();
    const { deps, terminal } = chatDeps(h, { answers: [] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(terminal?.transcript).toEqual(["> "]);
    expect(terminal?.closed).toBe(true);
  });

  test("Ctrl-C at the prompt exits 0 without an error", async () => {
    const h = await setup();
    const cancel = () => Promise.reject(new TarsError("cancelled"));
    const { deps } = chatDeps(h, { answers: [cancel] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).not.toContain("error");
  });

  test("blank lines are ignored; /quit exits 0", async () => {
    const h = await setup();
    const { deps } = chatDeps(h, { answers: ["   ", "/quit", "never reached"] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("/<skill> sends the fixed text, with and without content, after a 使用 skill line", async () => {
    const h = await setup();
    h.fake.reply(toolUse("s1", "skill_load", { name: "demo" }), text("ok"), text("ok"));
    const { deps } = chatDeps(h, { answers: ["/demo 我想學線性代數", "/demo", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain("使用 skill：demo — a demo skill");
    const requests = h.fake.messages();
    expect(requests).toHaveLength(3);
    expect(lastUserText(h, 0)).toBe(skillInvocationText("demo", "我想學線性代數"));
    expect(lastUserText(h, 2)).toBe(skillInvocationText("demo", ""));
    expect(skillInvocationText("demo", "")).not.toContain("\n");
  });

  test("local-only skills and unknown commands send nothing", async () => {
    const h = await setup();
    for (const name of Object.keys(LOCAL_ONLY_SKILLS)) addSkill(h, name);
    const { deps } = chatDeps(h, {
      answers: ["/memory 記住這個", "/beancount-ledger", "/nope", undefined],
    });
    expect(await run(["chat"], deps)).toBe(0);
    expect(h.fake.messages()).toHaveLength(0);
    for (const [name, why] of Object.entries(LOCAL_ONLY_SKILLS))
      expect(err(deps)).toContain(`${name} 要在 tars claude 裡用（${why}）`);
    expect(err(deps)).toContain("不認得的指令 /nope");
  });

  test("a skill named like a built-in is not reachable by slash", async () => {
    const h = await setup();
    addSkill(h, "cost");
    const { deps } = chatDeps(h, { answers: ["/cost", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain("anthropic: 本期已用");
    expect(err(deps)).not.toContain("使用 skill");
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("// sends a message that starts with a slash", async () => {
    const h = await setup();
    h.fake.reply(text("ok"));
    const { deps } = chatDeps(h, { answers: ["//etc/hosts", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(lastUserText(h)).toBe("/etc/hosts");
  });

  test("/model and /cost print, send nothing and change nothing", async () => {
    const h = await setup();
    h.fake.reply(text("first"));
    expect(await run(["chat", "--message", "hi"], chatDeps(h).deps)).toBe(0);
    const before = counts(h);
    const { deps } = chatDeps(h, { answers: ["/model", "/cost", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain(`目前的模型：anthropic/${MODEL_ID}`);
    expect(err(deps)).toContain(`anthropic/${MODEL_ID}  Model A`);
    expect(err(deps)).toContain("換模型：/model <provider>/<id>");
    expect(err(deps)).toContain("anthropic: 本期已用");
    expect(h.fake.messages()).toHaveLength(1);
    expect(counts(h)).toEqual(before);
  });

  test("/wiki searches in-process: no request, no new rows, output on stderr", async () => {
    const h = await setup();
    h.fake.reply(text("first"));
    expect(await run(["chat", "--message", "台積電 財報"], chatDeps(h).deps)).toBe(0);
    expect(await run(["wiki", "sync", "--reindex"], chatDeps(h).deps)).toBe(0);
    const before = counts(h);
    const { deps } = chatDeps(h, { answers: ["/wiki 財報", "/wiki", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toMatch(/^原始對話紀錄（1）｜索引到 /m);
    expect(err(deps)).toMatch(/^頁面：people 0、/m);
    expect(deps.io.stdout).toEqual([]);
    expect(h.fake.messages()).toHaveLength(1);
    expect(counts(h)).toEqual(before);
  });

  test("/help lists the commands and the skill names", async () => {
    const h = await setup();
    const { deps } = chatDeps(h, { answers: ["/help", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    for (const name of BUILTINS) expect(err(deps)).toMatch(new RegExp(`^  /${name} `, "m"));
    expect(err(deps)).toContain("//");
    expect(err(deps)).toContain("demo");
  });

  test("/new makes the next message start another conversation", async () => {
    const h = await setup();
    h.fake.reply(text("a"), text("b"), text("c"));
    const { deps } = chatDeps(h, { answers: ["one", "two", "/new", "three", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain("下一則訊息開新對話");
    expect(query<{ title: string }>(h, "SELECT title FROM conversations ORDER BY title")).toEqual([
      { title: "one" },
      { title: "three" },
    ]);
  });

  test("/effort shows, sets, and refuses a level the model lacks", async () => {
    const h = await setup();
    h.fake.reply(text("a"), text("b"));
    const { deps } = chatDeps(h, {
      answers: [
        "/effort",
        "hi",
        "/effort high",
        "/effort max",
        "/effort bogus",
        "again",
        undefined,
      ],
    });
    expect(await run(["chat"], deps)).toBe(0);
    const e = err(deps);
    expect(e).toContain("推理強度：medium；這個模型支援：low, medium, high");
    expect(e).toContain("推理強度改成 high，下一則訊息起生效");
    expect(e).toContain("可選：low, medium, high");
    expect(e).toContain("推理強度是 low | medium | high | xhigh | max 之一");
    const efforts = h.fake
      .messages()
      .map((r) => (r.body.output_config as { effort: string }).effort);
    expect(efforts).toEqual(["medium", "high"]);
    expect(query<{ effort: string }>(h, "SELECT effort FROM conversations")).toEqual([
      { effort: "high" },
    ]);
  });

  test("SIGINT during a turn aborts it and returns to the prompt", async () => {
    const h = await setup();
    const { deps, signals, terminal } = chatDeps(h, { answers: ["slow", "fast", undefined] });
    let first = true;
    h.fake.handler = (): FakeReply => {
      if (!first) return text("fast reply");
      first = false;
      setTimeout(() => signals.emit("SIGINT"), 50);
      return { kind: "hang" };
    };
    expect(await run(["chat"], deps)).toBe(0);
    expect(
      query<{ state: string }>(h, "SELECT state FROM turns ORDER BY started_at, rowid"),
    ).toEqual([{ state: "aborted" }, { state: "completed" }]);
    expect(terminal?.transcript.filter((t) => t === "> ")).toHaveLength(3);
    expect(out(deps)).toContain("fast reply");
  });

  test("a rejected message prints why and stays at the prompt", async () => {
    const h = await setup();
    const { deps } = chatDeps(h, {
      answers: [
        () => {
          writeCatalog(h.paths, [{ ...MODEL_ENTRY, status: "retired" }]);
          return Promise.resolve("hi");
        },
        undefined,
      ],
    });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain("沒有送出：");
    expect(counts(h)).toEqual([0, 0, 0, 0]);
  });
});

describe("/compact", () => {
  const options = { config: configWith({ compact_keep_recent_tokens: 1000 }) };

  test("without a conversation it says so and sends nothing", async () => {
    const h = await setup(options);
    const { deps } = chatDeps(h, { answers: ["/compact", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain("還沒有對話");
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("compacted with the focus text, then skipped right after", async () => {
    const h = await setup(options);
    h.fake.reply(text("one"), text("two"), text(summary));
    const { deps } = chatDeps(h, {
      answers: [big(1), big(2), "/compact keep the weather", "/compact", undefined],
    });
    expect(await run(["chat"], deps)).toBe(0);
    const requests = h.fake.messages();
    expect(requests).toHaveLength(3);
    expect(lastUserText(h, 2)).toEndWith("Additional focus: keep the weather");
    const e = err(deps);
    expect(e).toMatch(/已壓縮 2 個項目。壓縮前約 \d+ tokens，花費 [\d.]+ USD/);
    expect(e).toContain("上下文太短，沒有可以壓縮的部分");
    expect(
      query<{ n: number }>(h, "SELECT COUNT(*) AS n FROM items WHERE kind = 'compaction'")[0]?.n,
    ).toBe(1);
  });

  test("a failed compaction prints the reason and the detail", async () => {
    const h = await setup(options);
    h.fake.reply(text("one"), text("two"), {
      kind: "http_error",
      status: 400,
      type: "invalid_request_error",
      message: "prompt is broken",
    });
    const { deps } = chatDeps(h, { answers: [big(1), big(2), "/compact", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain("壓縮失敗：provider 拒絕了這個請求");
    expect(err(deps)).toContain("prompt is broken");
  });

  test("Ctrl-C during a compaction cancels it and leaves the context alone", async () => {
    const h = await setup(options);
    const { deps, signals } = chatDeps(h, { answers: [big(1), big(2), "/compact", undefined] });
    h.fake.reply(text("one"), text("two"));
    h.fake.handler = () => {
      setTimeout(() => signals.emit("SIGINT"), 50);
      return { kind: "hang" };
    };
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain("已取消");
    expect(
      query<{ n: number }>(h, "SELECT COUNT(*) AS n FROM items WHERE kind = 'compaction'")[0]?.n,
    ).toBe(0);
    expect(
      query<{ state: string }>(h, "SELECT state FROM turns WHERE kind = 'compaction'"),
    ).toEqual([{ state: "aborted" }]);
  });
});

describe("OpenRouter's key limit after a turn", () => {
  const compats: CompatHarness[] = [];
  afterEach(async () => {
    for (const h of compats.splice(0)) {
      await h.fake.stop();
      await h.gemini.stop();
      await h.openrouter.stop();
    }
  });
  async function compat() {
    resetReconcileWarnings();
    const h = await compatHarness();
    h.db.close();
    compats.push(h);
    const deps = testDeps({
      env: h.env,
      secrets: fakeSecrets({ "llm:anthropic": "sk-test", "llm:openrouter": "or-test" }),
      adapterFor,
      selfCommand: [process.execPath, join(REPO, "src/main.ts")],
      signals: new EventEmitter(),
    });
    return { h, deps };
  }
  const keyRequests = (h: CompatHarness) => h.openrouter.requests.filter((r) => r.path === "/key");
  const OPENROUTER = `openrouter/${OPENROUTER_ENTRY.id}`;

  test("--message on OpenRouter: one /key request, its adjustment in the database before chat returns", async () => {
    const { h, deps } = await compat();
    h.openrouter.key = { limit: 10, limit_remaining: 5 };
    h.openrouter.reply(compatText("hello", { cost: 0.001 }));
    expect(await run(["chat", "--model", OPENROUTER, "--message", "hi"], deps)).toBe(0);
    expect(keyRequests(h)).toHaveLength(1);
    expect(query(h, "SELECT provider, spent_usd, note FROM adjustments")).toEqual([
      { provider: "openrouter", spent_usd: 5, note: "auto: /key" },
    ]);
  });

  test("an Anthropic turn asks nothing of /key", async () => {
    const { h, deps } = await compat();
    h.fake.reply(text("hello"));
    expect(await run(["chat", "--message", "hi"], deps)).toBe(0);
    expect(keyRequests(h)).toHaveLength(0);
  });

  test("a /key that hangs: chat goes on after 5 seconds", async () => {
    const { h, deps } = await compat();
    h.openrouter.key = "hang";
    h.openrouter.reply(compatText("hello", { cost: 0.001 }));
    const started = performance.now();
    expect(await run(["chat", "--model", OPENROUTER, "--message", "hi"], deps)).toBe(0);
    expect(performance.now() - started).toBeLessThan(6000);
    expect(keyRequests(h)).toHaveLength(1);
    expect(query(h, "SELECT * FROM adjustments")).toEqual([]);
  }, 10000);
});

describe("continuing with another model", () => {
  const { default: _isDefault, ...notDefault } = MODEL_ENTRY;
  const MODEL_B = { ...notDefault, id: "model-b", label: "Model B" };
  const B = `anthropic/${MODEL_B.id}`;
  const withB = (opts: HarnessOptions = {}) => setup({ extraModels: [MODEL_B], ...opts });
  const convs = (h: EngineHarness) =>
    query<{ id: string; model: string; parent_id: string | null }>(
      h,
      "SELECT id, model, parent_id FROM conversations ORDER BY rowid",
    );
  async function first(h: EngineHarness) {
    h.fake.reply(text("first answer"));
    expect(await run(["chat", "--message", "first question"], chatDeps(h).deps)).toBe(0);
    return convs(h)[0]?.id as string;
  }
  const lastModel = (h: EngineHarness) => h.fake.messages().at(-1)?.body.model;

  test("/model <ref> with messages: a preview with bytes and dropped turns, then a new conversation", async () => {
    const h = await withB();
    const old = await first(h);
    h.fake.reply(text("again"), text("third"));
    const { deps } = chatDeps(h, {
      answers: [`/model ${B} --keep-last 1`, "繼續", "再一則", undefined],
    });
    expect(await run(["chat", "--resume", old], deps)).toBe(0);
    expect(err(deps)).toMatch(
      new RegExp(`下一則訊息會開新對話，用 ${B}，帶入對話 ${old.slice(-8)} 的文字 \\d+ 位元組`),
    );
    const all = convs(h);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ model: "model-b", parent_id: old });
    expect(lastModel(h)).toBe("model-b");
    // The message after the first one stays in the new conversation.
    expect(
      query<{ n: number }>(
        h,
        "SELECT COUNT(*) AS n FROM turns WHERE conv_id = ?",
        all[1]?.id as string,
      )[0]?.n,
    ).toBe(2);
  });

  test("the preview counts the turns left out", async () => {
    const h = await withB();
    h.fake.reply(text("a1"), text("a2"));
    const { deps: d1 } = chatDeps(h, { answers: ["q1", "q2", undefined] });
    expect(await run(["chat"], d1)).toBe(0);
    const old = convs(h)[0]?.id as string;
    const { deps } = chatDeps(h, { answers: [`/model ${B} --keep-last 1`, undefined] });
    expect(await run(["chat", "--resume", old], deps)).toBe(0);
    expect(err(deps)).toContain("，丟掉 1 個較早的回合");
  });

  test("text that cannot be carried: no pending continuation, the next message stays put", async () => {
    const h = await withB({ config: configWith({ max_input_tokens: 10000 }) });
    h.fake.reply(text("ok"));
    expect(await run(["chat", "--message", "x".repeat(8000)], chatDeps(h).deps)).toBe(0);
    const old = convs(h)[0]?.id as string;
    h.fake.reply(text("same"));
    const { deps } = chatDeps(h, { answers: [`/model ${B}`, "next", undefined] });
    expect(await run(["chat", "--resume", old], deps)).toBe(0);
    expect(err(deps)).toContain("沒有換模型：最近一個回合就超過");
    expect(convs(h)).toHaveLength(1);
    expect(lastModel(h)).toBe(MODEL_ID);
  });

  test("/model <ref> without messages switches; the next message opens a plain conversation", async () => {
    const h = await withB();
    h.fake.reply(text("hi"));
    const { deps } = chatDeps(h, { answers: [`/model ${B}`, "hello", undefined] });
    expect(await run(["chat"], deps)).toBe(0);
    expect(err(deps)).toContain(`下一則訊息用 ${B} 開新對話`);
    expect(convs(h)).toEqual([expect.objectContaining({ model: "model-b", parent_id: null })]);
  });

  test("a check that fails changes nothing", async () => {
    const h = await withB();
    const old = await first(h);
    h.fake.reply(text("same"));
    const { deps } = chatDeps(h, {
      answers: ["/model anthropic/nope", "/model gemini/x", "next", undefined],
    });
    expect(await run(["chat", "--resume", old], deps)).toBe(0);
    expect(err(deps)).toContain("沒有換模型：");
    expect(err(deps)).toContain("gemini 沒有啟用");
    expect(convs(h)).toHaveLength(1);
    expect(lastModel(h)).toBe(MODEL_ID);
  });

  test("a rejected message keeps the continuation pending; the next one continues", async () => {
    const h = await withB();
    const old = await first(h);
    h.fake.reply(text("continued"));
    const { deps } = chatDeps(h, {
      answers: [
        `/model ${B}`,
        "/compact",
        async () => {
          adjust95(h);
          return "rejected";
        },
        async () => {
          clearAdjust(h);
          return "accepted";
        },
        undefined,
      ],
    });
    expect(await run(["chat", "--resume", old], deps)).toBe(0);
    expect(err(deps)).toContain("還沒有訊息");
    expect(err(deps)).toContain("沒有送出：");
    expect(convs(h).at(-1)).toMatchObject({ model: "model-b", parent_id: old });
    expect(convs(h)).toHaveLength(2);
  });

  test("/new drops the pending continuation", async () => {
    const h = await withB();
    const old = await first(h);
    h.fake.reply(text("fresh"));
    const { deps } = chatDeps(h, { answers: [`/model ${B}`, "/new", "hello", undefined] });
    expect(await run(["chat", "--resume", old], deps)).toBe(0);
    expect(convs(h).at(-1)).toMatchObject({ model: "model-b", parent_id: null });
  });

  test("/effort while pending sets the level the new conversation starts with", async () => {
    const h = await withB();
    const old = await first(h);
    h.fake.reply(text("ok"));
    const { deps } = chatDeps(h, { answers: [`/model ${B}`, "/effort high", "go", undefined] });
    expect(await run(["chat", "--resume", old], deps)).toBe(0);
    expect(
      query<{ effort: string }>(h, "SELECT effort FROM conversations ORDER BY rowid DESC LIMIT 1"),
    ).toEqual([{ effort: "high" }]);
  });

  test("--continue: a new conversation on --model, carrying the old one; the old one unchanged", async () => {
    const h = await withB();
    const old = await first(h);
    const before = query(h, "SELECT * FROM items WHERE conv_id = ?", old);
    h.fake.reply(text("continued"));
    const { deps } = chatDeps(h);
    expect(
      await run(["chat", "--continue", old.slice(-8), "--model", B, "--message", "go on"], deps),
    ).toBe(0);
    expect(err(deps)).toContain("下一則訊息會開新對話");
    expect(convs(h).at(-1)).toMatchObject({ model: "model-b", parent_id: old });
    expect(query(h, "SELECT * FROM items WHERE conv_id = ?", old)).toEqual(before);
    const sent = h.fake.messages().at(-1)?.body.messages as {
      content: { type: string; text?: string }[];
    }[];
    const blocks = sent[0]?.content.filter((b) => b.type === "text").map((b) => b.text) ?? [];
    expect(blocks[0]).toStartWith("<previous-conversation>");
    expect(blocks.at(-1)).toBe("go on");
  });

  test.each([
    [["--continue", "abcd1234"]],
    [["--continue", "abcd1234", "--resume", "abcd1234", "--model", `anthropic/${MODEL_ID}`]],
    [["--list", "--continue", "abcd1234"]],
    [["--keep-last", "2"]],
    [["--continue", "abcd1234", "--model", `anthropic/${MODEL_ID}`, "--keep-last", "0"]],
  ])("chat %p is a usage error", async (args) => {
    const h = await setup();
    const { deps } = chatDeps(h);
    expect(await run(["chat", ...args], deps)).toBe(2);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("[chat] provider on a provider not enabled: an error naming the enabled ones", async () => {
    const h = await setup({ config: configWith({ provider: "gemini" }) });
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--message", "hi"], deps)).toBe(1);
    expect(err(deps)).toContain("gemini 沒有啟用");
    expect(err(deps)).toContain("啟用的：anthropic");
  });

  describe("the continuation hint on a rejection", () => {
    const HINT = "用 /model <provider>/<id> 以另一個模型接續";

    test.each([
      ["budget_stopped", (h: EngineHarness) => adjust95(h)],
      ["unknown_model", (h: EngineHarness) => writeCatalog(h.paths, [])],
      [
        "conv_too_long",
        (h: EngineHarness) =>
          writeFileSync(h.paths.configFile, configWith({ max_input_tokens: 10000 })),
      ],
    ])("%s: the hint", async (_, change) => {
      const h = await setup();
      const { deps } = chatDeps(h, {
        answers: [
          async () => {
            change(h);
            return "x".repeat(20000);
          },
          undefined,
        ],
      });
      expect(await run(["chat"], deps)).toBe(0);
      expect(err(deps)).toContain("沒有送出：");
      expect(err(deps)).toContain(HINT);
    });

    test("another reason: no hint", async () => {
      const h = await setup();
      const { deps } = chatDeps(h, {
        answers: [
          async () => {
            writeFileSync(h.paths.configFile, configWith({ enabled: false }));
            return "hi";
          },
          undefined,
        ],
      });
      expect(await run(["chat"], deps)).toBe(0);
      expect(err(deps)).toContain("沒有送出：");
      expect(err(deps)).not.toContain("以另一個模型接續");
    });

    test("--message on a conversation: the hint names --continue", async () => {
      const h = await setup();
      const old = await first(h);
      adjust95(h);
      const { deps } = chatDeps(h);
      expect(await run(["chat", "--resume", old, "--message", "more"], deps)).toBe(1);
      expect(err(deps)).toContain(
        `用 tars chat --continue ${old.slice(-8)} --model <provider>/<id> 以另一個模型接續`,
      );
    });
  });

  test("--resume of a continued conversation shows where its text came from", async () => {
    const h = await withB();
    const old = await first(h);
    h.fake.reply(text("continued"));
    expect(
      await run(["chat", "--continue", old, "--model", B, "--message", "go"], chatDeps(h).deps),
    ).toBe(0);
    const child = convs(h).at(-1)?.id as string;
    const { deps } = chatDeps(h, { answers: [undefined] });
    expect(await run(["chat", "--resume", child], deps)).toBe(0);
    expect(err(deps)).toContain(`（帶入自對話 ${old.slice(-8)}）`);
    expect(err(deps)).not.toContain("previous-conversation");
  });

  test("--list shows the parent's short id in column 6", async () => {
    const h = await withB();
    const old = await first(h);
    h.fake.reply(text("continued"));
    await run(["chat", "--continue", old, "--model", B, "--message", "go"], chatDeps(h).deps);
    const { deps } = chatDeps(h);
    expect(await run(["chat", "--list"], deps)).toBe(0);
    const cols = deps.io.stdout.map((l) => l.split("\t")[5]);
    expect(cols.sort()).toEqual(["", old.slice(-8)]);
  });
});

/** Puts Anthropic at its stop line, in its own connection. */
function adjust95(h: EngineHarness) {
  const db = new Database(h.paths.agentDb);
  try {
    db.run(
      "INSERT INTO adjustments (provider, at, month, spent_usd, note, usage_upto, usage_pending) VALUES ('anthropic', ?, '2026-11', 95, 'test', (SELECT COALESCE(MAX(id), 0) FROM usage), '[]')",
      [TEST_NOW],
    );
  } finally {
    db.close();
  }
}
function clearAdjust(h: EngineHarness) {
  const db = new Database(h.paths.agentDb);
  try {
    db.run("DELETE FROM adjustments");
  } finally {
    db.close();
  }
}

describe("archive", () => {
  const DAY = 86_400_000;

  /** Conversations made through chat, oldest first, each `ageDays` old by the test's clock. */
  async function conversations(ages: number[]) {
    const h = await setup();
    const ids: string[] = [];
    for (const [i, age] of ages.entries()) {
      h.fake.reply(text(`reply ${i}`));
      expect(await run(["chat", "--message", `question ${i}`], chatDeps(h).deps)).toBe(0);
      const id = query<{ id: string }>(h, "SELECT id FROM conversations ORDER BY created_at, id")[i]
        ?.id as string;
      ids.push(id);
      const db = new Database(h.paths.agentDb);
      db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [TEST_NOW - age * DAY, id]);
      db.close();
    }
    return { h, ids };
  }

  const archivedAt = (h: EngineHarness, id: string) =>
    query<{ a: number | null }>(h, "SELECT archived_at AS a FROM conversations WHERE id = ?", id)[0]
      ?.a;
  const ran = async (h: EngineHarness, args: string[], opts?: Parameters<typeof chatDeps>[1]) => {
    const d = chatDeps(h, opts);
    const code = await run(["chat", ...args], d.deps);
    return { code, deps: d.deps, terminal: d.terminal };
  };

  test("--archive: the conversation leaves --list, shows in --list --archived, and nothing else changes", async () => {
    const { h, ids } = await conversations([0, 0]);
    const before = counts(h);
    const id = ids[0] as string;
    const a = await ran(h, ["--archive", id.slice(-8)]);
    expect(a.code).toBe(0);
    expect(out(a.deps)).toContain(`已封存 ${id.slice(-8)}`);
    expect(archivedAt(h, id)).toBe(TEST_NOW);
    expect(counts(h)).toEqual(before);
    const list = await ran(h, ["--list"]);
    expect(list.deps.io.stdout.map((l) => l.split("\t")[0])).toEqual([ids[1]]);
    const archived = await ran(h, ["--list", "--archived"]);
    const cols = archived.deps.io.stdout[0]?.split("\t") ?? [];
    expect(cols[0]).toBe(id);
    expect(cols).toHaveLength(7);
    expect(cols[6]).toBe(new Date(TEST_NOW).toISOString());
    expect(cols[4]).toBe(new Date(TEST_NOW).toISOString());
  });

  test("--resume and --continue of an archived conversation are refused, saying how to unarchive", async () => {
    const { h, ids } = await conversations([0]);
    const short = (ids[0] as string).slice(-8);
    await ran(h, ["--archive", short]);
    const requests = h.fake.messages().length;
    const resume = await ran(h, ["--resume", short, "--message", "hi"]);
    expect(resume.code).toBe(1);
    expect(err(resume.deps)).toContain(`已封存`);
    expect(err(resume.deps)).toContain(`tars chat --unarchive ${short}`);
    const cont = await ran(h, [
      "--continue",
      short,
      "--model",
      `anthropic/${MODEL_ID}`,
      "--message",
      "hi",
    ]);
    expect(cont.code).toBe(1);
    expect(err(cont.deps)).toContain("已封存");
    expect(h.fake.messages()).toHaveLength(requests);
  });

  test("--unarchive: back in the list with its old update time, and --resume works again", async () => {
    const { h, ids } = await conversations([3]);
    const id = ids[0] as string;
    await ran(h, ["--archive", id]);
    const u = await ran(h, ["--unarchive", id.slice(-8)]);
    expect(u.code).toBe(0);
    expect(archivedAt(h, id)).toBeNull();
    const list = await ran(h, ["--list"]);
    expect(list.deps.io.stdout[0]?.split("\t")[4]).toBe(new Date(TEST_NOW - 3 * DAY).toISOString());
    h.fake.reply(text("again"));
    expect((await ran(h, ["--resume", id, "--message", "more"])).code).toBe(0);
  });

  test("archiving an archived one, or unarchiving one in use, says so and exits 0", async () => {
    const { h, ids } = await conversations([0]);
    const id = ids[0] as string;
    expect(out((await ran(h, ["--unarchive", id])).deps)).toContain("沒有封存");
    await ran(h, ["--archive", id]);
    const first = archivedAt(h, id);
    const again = await ran(h, ["--archive", id]);
    expect(again.code).toBe(0);
    expect(out(again.deps)).toContain("已經封存");
    expect(archivedAt(h, id)).toBe(first);
  });

  test("a conversation with a running turn is not archived, and the refusal says why", async () => {
    const { h, ids } = await conversations([0]);
    const db = new Database(h.paths.agentDb);
    db.run(
      "INSERT INTO turns (id, conv_id, kind, state, started_at) VALUES ('t-running', ?, 'chat', 'running', 1)",
      [ids[0] as string],
    );
    db.close();
    const a = await ran(h, ["--archive", ids[0] as string]);
    expect(a.code).toBe(1);
    expect(err(a.deps)).toContain("有進行中的回合");
    expect(archivedAt(h, ids[0] as string)).toBeNull();
  });

  test("while tars serve holds the lock: writes are refused with what to do; reads work", async () => {
    const { h, ids } = await conversations([40, 0]);
    const lock = await acquireLock(h.paths, new Date(TEST_NOW), "serve");
    try {
      for (const args of [
        ["--archive", ids[1] as string],
        ["--unarchive", ids[1] as string],
        ["--archive-older-than", "30", "--yes"],
      ]) {
        const r = await ran(h, args);
        expect(r.code).toBe(1);
        expect(err(r.deps)).toContain("對話資料庫正由 tars serve 使用");
        expect(err(r.deps)).toContain("請先停止 tars serve（Ctrl-C）");
        expect(err(r.deps)).toContain("60 秒內的「復原」");
        expect(err(r.deps)).toContain(args[0] as string);
      }
      expect(archivedAt(h, ids[0] as string)).toBeNull();
      expect((await ran(h, ["--list", "--archived"])).code).toBe(0);
      const dry = await ran(h, ["--archive-older-than", "30", "--dry-run"]);
      expect(dry.code).toBe(0);
      expect(out(dry.deps)).toContain("將封存 1 個對話");
    } finally {
      lock.release();
    }
  });

  test("--archive-older-than --dry-run lists what would go and changes nothing", async () => {
    const { h, ids } = await conversations([40, 31, 5]);
    const dry = await ran(h, ["--archive-older-than", "30", "--dry-run"]);
    expect(dry.code).toBe(0);
    const text = dry.deps.io.stdout.join("\n");
    expect(text).toContain("將封存 2 個對話（最後更新早於 30 天前）");
    expect(text).toContain((ids[0] as string).slice(-8));
    expect(text).toContain((ids[1] as string).slice(-8));
    expect(text).not.toContain((ids[2] as string).slice(-8));
    expect(text).toContain("這只會做標記，不刪任何資料");
    for (const id of ids) expect(archivedAt(h, id)).toBeNull();
  });

  test("--archive-older-than asks on the terminal; yes archives, no leaves everything", async () => {
    const { h, ids } = await conversations([40, 31, 5]);
    const no = await ran(h, ["--archive-older-than", "30"], { answers: ["no"] });
    expect(no.code).toBe(1);
    expect(err(no.deps)).toContain("沒有確認");
    for (const id of ids) expect(archivedAt(h, id)).toBeNull();
    const yes = await ran(h, ["--archive-older-than", "30"], { answers: ["yes"] });
    expect(yes.code).toBe(0);
    expect(out(yes.deps)).toContain("封存了 2 個對話");
    expect(yes.terminal?.transcript.join("\n")).toContain("將封存 2 個對話");
    expect(ids.map((id) => archivedAt(h, id) !== null)).toEqual([true, true, false]);
  });

  test("--yes archives without asking; no terminal and no --yes stops before anything changes", async () => {
    const { h, ids } = await conversations([40, 5]);
    const d = chatDeps(h).deps;
    const noTty = {
      deps: d,
      code: await run(["chat", "--archive-older-than", "30"], {
        ...d,
        openTerminal: () => {
          throw new TarsError("沒有控制終端");
        },
      }),
    };
    expect(noTty.code).toBe(1);
    expect(err(noTty.deps)).toContain("--yes");
    expect(archivedAt(h, ids[0] as string)).toBeNull();
    const yes = await ran(h, ["--archive-older-than", "30", "--yes"]);
    expect(yes.code).toBe(0);
    expect(out(yes.deps)).toContain("封存了 1 個對話");
    expect(archivedAt(h, ids[0] as string)).toBe(TEST_NOW);
    expect(archivedAt(h, ids[1] as string)).toBeNull();
  });

  test("--archive-older-than skips a conversation that waits, and says which", async () => {
    const { h, ids } = await conversations([40, 41]);
    const db = new Database(h.paths.agentDb);
    db.run(
      "INSERT INTO turns (id, conv_id, kind, state, started_at) VALUES ('t-running', ?, 'chat', 'running', 1)",
      [ids[1] as string],
    );
    db.close();
    const r = await ran(h, ["--archive-older-than", "30", "--yes"]);
    expect(r.code).toBe(0);
    expect(out(r.deps)).toContain("略過 1 個");
    expect(out(r.deps)).toContain("有進行中的回合");
    expect(archivedAt(h, ids[0] as string)).toBe(TEST_NOW);
    expect(archivedAt(h, ids[1] as string)).toBeNull();
  });

  test("nothing older than the days: says so and exits 0", async () => {
    const { h } = await conversations([1]);
    const r = await ran(h, ["--archive-older-than", "30", "--yes"]);
    expect(r.code).toBe(0);
    expect(out(r.deps)).toContain("沒有最後更新早於 30 天前的對話");
  });

  test.each([
    [["--archived"]],
    [["--archived", "--archive", "abcd"]],
    [["--yes"]],
    [["--dry-run"]],
    [["--archive", "abcd", "--yes"]],
    [["--archive-older-than", "30", "--yes", "--dry-run"]],
    [["--archive", "abcd", "--unarchive", "abcd"]],
    [["--archive", "abcd", "--resume", "abcd"]],
    [["--archive", "abcd", "--message", "hi"]],
    [["--unarchive", "abcd", "--model", `anthropic/${MODEL_ID}`]],
    [["--archive-older-than", "0"]],
    [["--archive-older-than", "x"]],
  ])("chat %p is a usage error", async (args) => {
    const h = await setup();
    expect((await ran(h, args)).code).toBe(2);
    expect(h.fake.messages()).toHaveLength(0);
  });

  test("inside a tars session the archive commands are refused", async () => {
    const { h, ids } = await conversations([0]);
    const r = await ran(h, ["--archive", ids[0] as string], { env: { TARS_IN_SESSION: "1" } });
    expect(r.code).toBe(1);
    expect(archivedAt(h, ids[0] as string)).toBeNull();
  });
});
