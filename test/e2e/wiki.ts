import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { E2E_BASE_URL_VAR } from "../../src/features/agent/provider.ts";
import { REFUSAL_TEXT } from "../../src/features/agent/tars-tool.ts";
import { CONSOLIDATE_SYSTEM, EXTRACT_SYSTEM } from "../../src/features/wiki/sync.ts";
import {
  capabilities,
  startFakeAnthropic,
  tarsCall,
  text,
  type FakeReply,
} from "../fakes/anthropic.ts";
import { runDialog } from "./pty.ts";
import { finishChecks, printChecks, type Check } from "./sandbox.ts";
import { enterScriptNetns, install, scriptHost } from "./script-host.ts";

const INNER = "TARS_E2E_WIKI_INNER";
const MODEL = "model-e2e";
const KEY = "sk-" + "e2e-fake-key";

const script = (name: string, body: string) => `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "${name}"
# summary = "e2e ${name}"
# domains = ["example.com"]
# effects = "read-only"
# args = "<anything>"
# outputs = "one line"
# exit = { 0 = "ok" }
# ///
${body}
`;

/** What the fake extraction finds: a turn whose owner text holds `match` yields this candidate. */
interface Fact {
  readonly match: string;
  readonly page: string;
  readonly title: string;
  readonly text: string;
  readonly quote: string;
  readonly alias?: string;
}

const FACTS: readonly Fact[] = [
  {
    match: "搬到台中西屯",
    page: "people/wang-xiaoming",
    title: "王小明",
    text: "王小明搬到台中西屯。",
    quote: "搬到台中西屯",
    alias: "小明",
  },
  {
    match: "Q3財報毛利率上升",
    page: "investment/tsmc",
    title: "台積電",
    text: "Q3財報毛利率上升。",
    quote: "Q3財報毛利率上升",
    alias: "TSMC",
  },
  {
    match: "下個月要去日本出差",
    page: "people/wang-xiaoming",
    title: "王小明",
    text: "王小明下個月要去日本出差。",
    quote: "下個月要去日本出差",
  },
  {
    match: "法說會延到十二月",
    page: "investment/tsmc",
    title: "台積電",
    text: "法說會延到十二月。",
    quote: "法說會延到十二月",
  },
  {
    match: "開始學大提琴",
    page: "learning/cello",
    title: "大提琴",
    text: "開始學大提琴。",
    quote: "開始學大提琴",
  },
  {
    match: "陳大文是我的大學同學",
    page: "people/chen-dawen",
    title: "陳大文",
    text: "陳大文是大學同學。",
    quote: "陳大文是我的大學同學",
  },
  {
    match: "王小明養了一隻柴犬",
    page: "people/wang-xiaoming",
    title: "王小明",
    text: "王小明養了一隻柴犬。",
    quote: "王小明養了一隻柴犬",
  },
];

type Body = Record<string, unknown>;
type Block = { type: string; text?: string; content?: string };
type Message = { role: string; content: Block[] | string };

const blocksText = (v: unknown) =>
  typeof v === "string" ? v : ((v ?? []) as Block[]).map((b) => b.text ?? "").join("\n");
const systemOf = (body: Body) => blocksText(body.system);
const messagesOf = (body: Body | undefined) => (body?.messages ?? []) as Message[];
const promptOf = (body: Body) => blocksText(messagesOf(body)[0]?.content);
const lastToolResult = (body: Body | undefined) =>
  messagesOf(body)
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .filter((b) => b.type === "tool_result")
    .at(-1)?.content ?? "";
const strip = (v: unknown) =>
  JSON.stringify(v, (k, value: unknown) => (k === "cache_control" ? undefined : value));
const json = (v: unknown): FakeReply => text(JSON.stringify(v));

function extractReply(prompt: string): FakeReply {
  const candidates = [
    ...prompt.matchAll(/<turn source="([^"]+)"[^>]*>\n<owner>\n([\s\S]*?)\n<\/owner>/g),
  ].flatMap(([, source, owner]) =>
    FACTS.filter((f) => owner?.includes(f.match)).map((f) => ({
      source,
      page: f.page,
      title: f.title,
      section: "facts",
      text: f.text,
      speaker: "owner",
      quote: f.quote,
    })),
  );
  return json({ candidates });
}

function consolidateReply(prompt: string, bad: ReadonlySet<string>): FakeReply {
  const page = /<page path="([^"]+)">/.exec(prompt)?.[1] ?? "";
  const cands = [...prompt.matchAll(/^- \[(c\d+)\] [^\n]*\n {2}(.*)$/gm)].map(([, id, t]) => ({
    id: id as string,
    text: t as string,
  }));
  if (bad.has(page))
    return json({
      summary: { keep: true },
      facts: [{ op: "update", id: "i99", text: "不存在的條目", from: cands.map((c) => c.id) }],
      open: [],
    });
  const aliases = FACTS.filter((f) => f.page === page && f.alias !== undefined).map((f) => f.alias);
  return json({
    summary: { keep: true },
    facts: cands.map((c) => ({ op: "add", text: c.text, from: [c.id] })),
    open: [],
    aliases,
  });
}

/** Every file under `dir` with its sha256, sorted: equal strings mean nothing changed. */
function tree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        out.push(
          `${relative(dir, p)} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`,
        );
    }
  };
  walk(dir);
  return out.toSorted().join("\n");
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function inner(): Promise<number> {
  const { host, python, step } = scriptHost("tars-e2e-wiki-");
  const fake = startFakeAnthropic();
  fake.models = [
    {
      id: MODEL,
      display_name: "Model E2E",
      max_input_tokens: 200000,
      max_tokens: 32000,
      capabilities: capabilities(["low", "medium", "high"]),
    },
  ];
  // Sync's requests are answered from their prompt; chat turns take the queued replies first.
  const bad = new Set<string>();
  let hang: "consolidate" | undefined;
  fake.handler = (body) => {
    const system = systemOf(body);
    if (system === EXTRACT_SYSTEM) return extractReply(promptOf(body));
    if (system === CONSOLIDATE_SYSTEM)
      return hang === "consolidate" ? { kind: "hang" } : consolidateReply(promptOf(body), bad);
    return text("(no reply queued)");
  };
  const env = { [E2E_BASE_URL_VAR]: fake.url };
  const run = (name: string, command: string, extra: Record<string, string> = {}) =>
    step(name, command, { ...env, ...extra });
  const data = join(host.fakeHome, ".local/share/tars");
  const wikiDir = join(data, "wiki");
  const query = <T>(file: string, sql: string, ...params: string[]) => {
    const conn = new Database(join(data, "agent", file), { readonly: true });
    try {
      return conn.query(sql).all(...params) as T[];
    } finally {
      conn.close();
    }
  };
  const lastConv = () =>
    query<{ id: string }>(
      "agent.db",
      "SELECT id FROM conversations ORDER BY updated_at DESC, rowid DESC LIMIT 1",
    )[0]?.id ?? "";
  const lastBody = () => fake.messages().at(-1)?.body;
  const page = (path: string) => readFileSync(join(wikiDir, `${path}.md`), "utf8");
  const checks: Check[] = [];
  const check = (id: string, claim: string, pass: boolean, evidence: string) =>
    checks.push({ id, claim, pass, evidence });
  const brief = (r: { exitCode: number | null; stdout: string; stderr: string }) =>
    `exit ${r.exitCode}; stdout ${JSON.stringify(r.stdout.slice(0, 300))}; stderr ${JSON.stringify(r.stderr.slice(-300))}`;
  const say = (name: string, message: string, conv?: string) =>
    run(name, `tars chat ${conv === undefined ? "" : `--resume ${conv} `}--message '${message}'`);
  const sync = (name: string) => run(name, "tars wiki sync");

  try {
    // --- Setup: installed, a key, a priced default model, two approved scripts.
    const fixtures = join(host.work, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, "SOUL.md"), "# Soul\nE2E soul\n");
    writeFileSync(join(fixtures, "MEMORY.md"), "# Memory\nE2E memory\n");
    const installed = await run(
      "install",
      `tars install --soul ${fixtures}/SOUL.md --memory ${fixtures}/MEMORY.md --no-modify-path && tars config init`,
    );
    if (installed.exitCode !== 0) throw new Error(`install failed: ${brief(installed)}`);
    const key = await runDialog(host, {
      name: "llm-key-set",
      command: "tars llm key set anthropic",
      tty: true,
      env,
      turns: [{ expect: "API 金鑰：", send: `${KEY}\n` }],
    });
    const models = await run(
      "models",
      `tars models refresh && tars models set anthropic/${MODEL} --input 3 --output 15 --cache-read 0.3 --cache-write 3.75 && tars models enable anthropic/${MODEL} && tars models default anthropic/${MODEL}`,
    );
    if (key.exitCode !== 0 || models.exitCode !== 0)
      throw new Error(`setup failed: key ${key.exitCode}; ${brief(models)}`);
    const dataInBox = `${host.home}/.local/share/tars`;
    const reader = (path: string, tag: string) =>
      `try:\n    open(${JSON.stringify(path)}, "rb").read(16)\n    print("${tag}-READ")\nexcept Exception as e:\n    print("${tag}-DENIED", type(e).__name__)`;
    const scripts = [
      install(host, "weather", script("weather", 'print("WEATHER-OK")')),
      install(
        host,
        "wikireader",
        script(
          "wikireader",
          [
            reader(`${dataInBox}/wiki/people/wang-xiaoming.md`, "PAGE"),
            reader(`${dataInBox}/agent/wiki.db`, "WIKIDB"),
          ].join("\n"),
        ),
      ),
    ];
    const venvs = await run(
      "venvs",
      scripts.map((v) => `python3 -m venv --without-pip ${v}/venv-${python}`).join(" && "),
    );
    if (venvs.exitCode !== 0) throw new Error(`venvs failed: ${brief(venvs)}`);

    // --- 1. Two turns, one running a script that needs no approval.
    fake.reply(text("記下了"));
    const t1 = await say("turn-1", "王小明上個月搬到台中西屯了");
    fake.reply(tarsCall("w1", ["script", "run", "weather"]), text("天氣查好了"));
    const t2 = await say("turn-2", "台積電（TSMC）Q3財報毛利率上升，順便查天氣");
    check(
      "turns",
      "two tars chat turns complete; the second runs a script without approval",
      t1.exitCode === 0 &&
        t2.exitCode === 0 &&
        lastToolResult(fake.messages().at(-1)?.body).includes("WEATHER-OK"),
      `${brief(t1)} | ${brief(t2)}`,
    );

    // --- 2. The first sync writes the pages, index.md and status.
    const s1 = await sync("sync-1");
    const status1 = await run("status-1", "tars wiki status");
    const wang1 = page("people/wang-xiaoming");
    const index1 = readFileSync(join(wikiDir, "index.md"), "utf8");
    const turn1 = query<{ conv_id: string; id: string }>(
      "agent.db",
      "SELECT conv_id, id FROM turns ORDER BY rowid LIMIT 1",
    )[0];
    const ref1 = turn1 === undefined ? "?" : `${turn1.conv_id.slice(-8)}/${turn1.id.slice(-8)}`;
    check(
      "sync-1",
      "the first sync writes both pages with their sources, index.md lists them, status counts them",
      s1.exitCode === 0 &&
        wang1.includes(`- [i1] 王小明搬到台中西屯。 [[source:${ref1}]]`) &&
        page("investment/tsmc").includes("Q3財報毛利率上升。") &&
        index1.includes("- [[people/wang-xiaoming]] 王小明｜小明｜") &&
        index1.includes("- [[investment/tsmc]] 台積電｜TSMC｜") &&
        status1.exitCode === 0 &&
        status1.stdout.includes(
          "頁面：people 1、projects 0、topics 0、life 0、learning 0、investment 1",
        ) &&
        /上次同步：.*completed/.test(status1.stdout),
      `${brief(s1)} | status ${JSON.stringify(status1.stdout.slice(0, 400))}`,
    );

    // --- 3. A second sync keeps the first one's entries and sources.
    fake.reply(text("好"));
    const t3 = await say("turn-3", "王小明下個月要去日本出差");
    const s2 = await sync("sync-2");
    const wang2 = page("people/wang-xiaoming");
    check(
      "sync-2",
      "the second sync adds to the page; the first entry and its source are still there",
      t3.exitCode === 0 &&
        s2.exitCode === 0 &&
        wang2.includes(`- [i1] 王小明搬到台中西屯。 [[source:${ref1}]]`) &&
        /- \[i2\] 王小明下個月要去日本出差。 \[\[source:/.test(wang2),
      `${brief(s2)} | page ${JSON.stringify(wang2)}`,
    );

    // --- 4. A patch that breaks the rules leaves the page byte for byte.
    const tsmcBefore = sha(join(wikiDir, "investment/tsmc.md"));
    bad.add("investment/tsmc");
    fake.reply(text("好"));
    await say("turn-4", "台積電法說會延到十二月");
    const s3 = await sync("sync-bad");
    bad.clear();
    const pending = query<{ n: number }>(
      "wiki.db",
      "SELECT COUNT(*) AS n FROM candidates WHERE page = 'investment/tsmc' AND state = 'pending' AND attempts = 1",
    )[0]?.n;
    check(
      "bad-patch",
      "a rejected patch leaves the page's sha256 unchanged and its candidate pending",
      s3.exitCode === 0 && sha(join(wikiDir, "investment/tsmc.md")) === tsmcBefore && pending === 1,
      `${brief(s3)}; pending ${pending}`,
    );

    // --- 5. A tiny daily cap stops the sync with exit 0; back at 1 USD it goes on.
    const configFile = join(host.fakeHome, ".config/tars/config.toml");
    const config = readFileSync(configFile, "utf8");
    writeFileSync(configFile, config.replace(/^daily_cap_usd = 1 /m, "daily_cap_usd = 0.0001 "));
    fake.reply(text("好"));
    await say("turn-5", "我開始學大提琴");
    const capped = await sync("sync-capped");
    const cappedSent = fake.messages().length;
    writeFileSync(configFile, config);
    const resumed = await sync("sync-resumed");
    check(
      "daily-cap",
      "at the daily cap the sync stops with exit 0; with the cap restored it finishes the work",
      capped.exitCode === 0 &&
        capped.stdout.includes("停下") &&
        resumed.exitCode === 0 &&
        fake.messages().length > cappedSent &&
        page("learning/cello").includes("開始學大提琴。") &&
        page("investment/tsmc").includes("法說會延到十二月。"),
      `${brief(capped)} | ${brief(resumed)}`,
    );

    // --- 6. wiki sync is refused through the tool and in a session; wiki/ is untouched.
    const treeBefore = tree(wikiDir);
    fake.reply(tarsCall("s1", ["wiki", "sync"]), text("不能同步"));
    const viaTool = await say("tool-sync", "幫我同步知識庫");
    const toolResult = lastToolResult(lastBody());
    const inSession = await run("in-session-sync", "tars wiki sync", { TARS_IN_SESSION: "1" });
    check(
      "refuse-sync",
      "wiki sync through the tars tool is refused; under TARS_IN_SESSION it exits 1; wiki/ is unchanged",
      viaTool.exitCode === 0 &&
        toolResult.startsWith(REFUSAL_TEXT) &&
        inSession.exitCode === 1 &&
        tree(wikiDir) === treeBefore,
      `tool ${JSON.stringify(toolResult.slice(0, 200))}; ${brief(inSession)}`,
    );

    // --- 7. Chinese, English and mixed queries each give both groups; an alias finds its page.
    const search = async (q: string) => {
      const r = await run(`search-${q}`, `tars wiki search '${q}' --json`);
      try {
        return JSON.parse(r.stdout) as {
          pages: { results: { path: string; section: string }[] };
          records: { results: unknown[] };
        };
      } catch {
        return { pages: { results: [] }, records: { results: [] } };
      }
    };
    const found = {
      zh: await search("台中西屯"),
      en: await search("TSMC"),
      mixed: await search("Q3財報"),
    };
    check(
      "search",
      "Chinese, English and mixed queries each return pages and records; TSMC finds 台積電 by its alias",
      Object.values(found).every(
        (r) => r.pages.results.length > 0 && r.records.results.length > 0,
      ) &&
        found.en.pages.results[0]?.path === "investment/tsmc" &&
        found.en.pages.results[0]?.section === "meta",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(found).map(([k, r]) => [
            k,
            [r.pages.results.length, r.records.results.length, r.pages.results[0]],
          ]),
        ),
      ),
    );

    // --- 8. A sync between two turns of one conversation leaves the sent prefix as it was.
    fake.reply(text("記下了"));
    await say("prefix-a", "陳大文是我的大學同學");
    const a = lastBody() as Body;
    const conv = lastConv();
    const s8 = await sync("sync-prefix");
    fake.reply(text("好"));
    await say("prefix-b", "再說一次", conv);
    const b = lastBody() as Body;
    fake.reply(text("好"));
    await say("prefix-new", "新的對話");
    const fresh = promptOf(lastBody() as Body);
    check(
      "prefix",
      "after a sync, the same conversation sends the same system, tools and first message; a new one carries the new index",
      s8.exitCode === 0 &&
        page("people/chen-dawen").includes("陳大文是大學同學。") &&
        strip(b.system) === strip(a.system) &&
        strip(b.tools) === strip(a.tools) &&
        strip(messagesOf(b)[0]) === strip(messagesOf(a)[0]) &&
        !promptOf(a).includes("陳大文｜") &&
        fresh.includes("- people/chen-dawen｜陳大文｜｜"),
      `${brief(s8)}; first A ${JSON.stringify(promptOf(a).slice(0, 300))}; new ${JSON.stringify(fresh.slice(0, 300))}`,
    );

    // --- 9. An approved script reads neither a page nor wiki.db.
    fake.reply(tarsCall("r1", ["script", "run", "wikireader"]), text("讀完了"));
    const read = await say("script-read", "讀知識庫");
    const readResult = lastToolResult(lastBody());
    check(
      "sandbox",
      "an approved script can read neither <data>/wiki/people/x.md nor <data>/agent/wiki.db",
      read.exitCode === 0 &&
        readResult.includes("PAGE-DENIED") &&
        readResult.includes("WIKIDB-DENIED") &&
        !readResult.includes("-READ"),
      `${brief(read)}; result ${JSON.stringify(readResult.slice(0, 300))}`,
    );

    // --- 10. kill -9 while a page is being consolidated, then sync again.
    fake.reply(text("好"));
    await say("turn-kill", "王小明養了一隻柴犬");
    hang = "consolidate";
    const killed = await run(
      "sync-kill-9",
      "tars wiki sync >/dev/null 2>&1 & p=$!; sleep 4; kill -9 $p; wait $p; echo killed",
    );
    hang = undefined;
    const again = await sync("sync-after-kill");
    const status2 = await run("status-2", "tars wiki status");
    const wang3 = page("people/wang-xiaoming");
    const entries = wang3.split("\n").filter((l) => /^- \[i\d+\]/.test(l));
    const texts = entries.map((l) => l.replace(/^- \[i\d+\] /, "").replace(/ \[\[source:.*$/, ""));
    check(
      "kill-9",
      "after kill -9 mid-sync, the next sync finishes: no repeated entries, and the last run is not left running",
      killed.stdout.includes("killed") &&
        again.exitCode === 0 &&
        texts.filter((t) => t === "王小明養了一隻柴犬。").length === 1 &&
        new Set(texts).size === texts.length &&
        /上次同步：.*completed/.test(status2.stdout) &&
        !/上次同步：.*running/.test(status2.stdout),
      `${brief(again)}; entries ${JSON.stringify(texts)}; status ${JSON.stringify(status2.stdout.slice(0, 400))}`,
    );
  } finally {
    await fake.stop();
  }
  printChecks(checks);
  return finishChecks(checks, host.work);
}

if (import.meta.main)
  process.exitCode = process.env[INNER]
    ? await inner()
    : enterScriptNetns(import.meta.path, INNER, "e2e:wiki");
