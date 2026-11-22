import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUMMARY_HEADINGS, SUMMARY_PREFIX } from "../../src/features/agent/compaction.ts";
import { CONFIG_TEMPLATE } from "../../src/features/agent/config.ts";
import { E2E_BASE_URL_VAR } from "../../src/features/agent/provider.ts";
import {
  capabilities,
  startFakeAnthropic,
  tarsCall,
  text,
  toolUse,
  type FakeReply,
} from "../fakes/anthropic.ts";
import { historyProblems } from "../features/agent/engine-fixture.ts";
import { runDialog } from "./pty.ts";
import { finishChecks, printChecks, type Check } from "./sandbox.ts";
import { enterScriptNetns, install, scriptHost } from "./script-host.ts";

const INNER = "TARS_E2E_CHAT_INNER";
const MODEL = "model-e2e";
const KEY = "sk-e2e-fake-key";
const PROMPT = "> ";
const APPROVE = "核准？輸入 yes 或 no：";

const script = (
  name: string,
  effects: string,
  body: string,
  domain = "example.com",
) => `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "${name}"
# summary = "e2e ${name}"
# domains = ["${domain}"]
# effects = "${effects}"
# args = "<anything>"
# outputs = "one line"
# exit = { 0 = "ok" }
# ///
${body}
`;

const summaryText = (tag: string) => SUMMARY_HEADINGS.map((h) => `## ${h}\n- ${tag}`).join("\n\n");

/** A reply whose usage says the prompt was `input` tokens, so the next turn sees a full context. */
const sized = (reply: FakeReply, input: number): FakeReply =>
  reply.kind === "message" ? { ...reply, usage: { input, output: 20 } } : reply;

type Body = Record<string, unknown>;
type Message = { role: string; content: { type: string; text?: string; content?: string }[] };

const messagesOf = (body: Body | undefined) => (body?.messages ?? []) as Message[];
const lastToolResult = (body: Body | undefined) =>
  messagesOf(body)
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result")
    .at(-1)?.content ?? "";
const firstText = (body: Body | undefined) => messagesOf(body)[0]?.content[0]?.text ?? "";

async function inner(): Promise<number> {
  const { host, python, step } = scriptHost("tars-e2e-chat-");
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
  const env = { [E2E_BASE_URL_VAR]: fake.url };
  // The sleeper reports each start here: a count of its runs that does not depend on catching
  // its processes alive.
  let sleeperRuns = 0;
  const runLog = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      sleeperRuns++;
      return new Response("ok");
    },
  });
  const run = (name: string, command: string, extra: Record<string, string> = {}) =>
    step(name, command, { ...env, ...extra });
  const dialog = (name: string, command: string, turns: { expect: string; send: string }[]) =>
    runDialog(host, { name, command, tty: true, turns, env, waitMs: 30_000 });
  const data = join(host.fakeHome, ".local/share/tars");
  const db = () => new Database(join(data, "agent/agent.db"), { readonly: true });
  const query = <T>(sql: string, ...params: string[]) => {
    const conn = db();
    try {
      return conn.query(sql).all(...params) as T[];
    } finally {
      conn.close();
    }
  };
  const lastConv = () =>
    query<{ id: string }>("SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1")[0]?.id ??
    "";
  const lastBody = () => fake.messages().at(-1)?.body;
  const checks: Check[] = [];
  const check = (id: string, claim: string, pass: boolean, evidence: string) =>
    checks.push({ id, claim, pass, evidence });
  const brief = (r: { exitCode: number | null; stdout: string; stderr: string }) =>
    `exit ${r.exitCode}; stdout ${JSON.stringify(r.stdout.slice(0, 200))}; stderr ${JSON.stringify(r.stderr.slice(-400))}`;

  try {
    // --- Setup: tars installed, four approved scripts with their venvs.
    const fixtures = join(host.work, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, "SOUL.md"), "# Soul\nE2E soul\n");
    writeFileSync(join(fixtures, "MEMORY.md"), "# Memory\nE2E memory\n");
    const installed = await run(
      "install",
      `tars install --soul ${fixtures}/SOUL.md --memory ${fixtures}/MEMORY.md --no-modify-path`,
    );
    if (installed.exitCode !== 0) throw new Error(`install failed: ${brief(installed)}`);
    const dbPath = `${host.home}/.local/share/tars/agent/agent.db`;
    const scripts = [
      install(
        host,
        "weather",
        script("weather", "read-only", 'import sys\nprint("WEATHER-OK", *sys.argv[1:])'),
      ),
      install(host, "pusher", script("pusher", "external-write", 'print("PUSHED")')),
      install(
        host,
        "sleeper",
        script(
          "sleeper",
          "read-only",
          [
            "import time, urllib.request",
            `urllib.request.urlopen("http://127.0.0.1:${runLog.port}/ran", timeout=5).read()`,
            'print("SLEEPING", flush=True)',
            "time.sleep(60)",
          ].join("\n"),
          `127.0.0.1:${runLog.port}`,
        ),
      ),
      install(
        host,
        "dbreader",
        script(
          "dbreader",
          "read-only",
          `try:\n    open(${JSON.stringify(dbPath)}, "rb").read(16)\n    print("DB-READ")\nexcept Exception as e:\n    print("DB-DENIED", type(e).__name__)`,
        ),
      ),
    ];
    const venvs = await run(
      "venvs",
      scripts.map((v) => `python3 -m venv --without-pip ${v}/venv-${python}`).join(" && "),
    );
    if (venvs.exitCode !== 0) throw new Error(`venvs failed: ${brief(venvs)}`);

    // --- 1. CUJ 1: first setup.
    const early = await run("chat-before-setup", "tars chat --message hi");
    check(
      "cuj1-missing",
      "before setup, tars chat exits 1 and names the command to run",
      early.exitCode === 1 && early.stderr.includes("tars config init"),
      brief(early),
    );
    const init = await run("config-init", "tars config init");
    const key = await runDialog(host, {
      name: "llm-key-set",
      command: "tars llm key set anthropic",
      tty: true,
      env,
      turns: [{ expect: "API 金鑰：", send: `${KEY}\n` }],
    });
    const refresh = await run("models-refresh", "tars models refresh");
    const set = await run(
      "models-set",
      `tars models set anthropic/${MODEL} --input 3 --output 15 --cache-read 0.3 --cache-write 3.75 && tars models enable anthropic/${MODEL} && tars models default anthropic/${MODEL}`,
    );
    const list = await run("models-list", "tars models list --json");
    const listed = (() => {
      try {
        return (
          JSON.parse(list.stdout) as {
            models: { id: string; status: string; default?: boolean; pricedAt?: string }[];
          }
        ).models;
      } catch {
        return [];
      }
    })();
    const today = new Date().toISOString().slice(0, 10);
    const entry = listed.find((m) => m.id === MODEL);
    check(
      "cuj1",
      "config init, key set (pty), refresh, set, enable, default: the model is active, default and priced today",
      [init, key, refresh, set, list].every((r) => r.exitCode === 0) &&
        entry?.status === "active" &&
        entry.default === true &&
        entry.pricedAt === today &&
        !(key.transcript + key.stdout + key.stderr).includes(KEY),
      `exits ${[init, key, refresh, set, list].map((r) => r.exitCode).join("/")}; ${JSON.stringify(entry)}`,
    );

    // --- 2. One turn, reply on stdout only.
    fake.reply(text("E2E-REPLY"));
    const once = await run("message", "tars chat --message hello");
    check(
      "message",
      "tars chat --message completes a turn; stdout holds only the reply",
      once.exitCode === 0 && once.stdout === "E2E-REPLY\n" && once.stderr.includes("用量："),
      brief(once),
    );

    // --- 3. Effort.
    fake.reply(text("high ok"));
    const high = await run("effort-high", "tars chat --effort high --message hi");
    const highBody = lastBody() as { output_config?: { effort?: string } } | undefined;
    const max = await run("effort-max", "tars chat --effort max --message hi");
    check(
      "effort",
      "--effort high is sent; a level the model does not support exits 1",
      high.exitCode === 0 &&
        highBody?.output_config?.effort === "high" &&
        max.exitCode === 1 &&
        max.stderr.includes("low, medium, high"),
      `high: ${brief(high)} body ${JSON.stringify(highBody?.output_config)}; max: ${brief(max)}`,
    );

    // --- 4. A free script.
    fake.reply(tarsCall("w1", ["script", "run", "weather", "--", "Taipei"]), text("weather done"));
    const free = await run("free-script", "tars chat --message weather");
    check(
      "free-script",
      "a read-only script with one exact host runs without approval",
      free.exitCode === 0 &&
        lastToolResult(lastBody()).includes("WEATHER-OK Taipei") &&
        free.stderr.includes("→ tars script run weather"),
      `${brief(free)}; result ${JSON.stringify(lastToolResult(lastBody()).slice(0, 200))}`,
    );

    // --- 5. Approval on the pty; without a terminal it is denied.
    fake.reply(tarsCall("p1", ["script", "run", "pusher", "--", "x"]), text("pushed"));
    const approved = await dialog("approve-pty", "tars chat --message push", [
      { expect: APPROVE, send: "yes\n" },
    ]);
    const approvedResult = lastToolResult(lastBody());
    check(
      "approve-pty",
      "the approval card shows on /dev/tty; yes runs the script",
      approved.exitCode === 0 &&
        approved.transcript.includes("腳本：pusher") &&
        approvedResult.includes("PUSHED"),
      `exit ${approved.exitCode}; missed ${approved.missed}; result ${JSON.stringify(approvedResult.slice(0, 200))}`,
    );
    fake.reply(tarsCall("p2", ["script", "run", "pusher", "--", "x"]), text("not pushed"));
    const noTty = await run("approve-no-tty", "tars chat --message push");
    const noTtyResult = lastToolResult(lastBody());
    check(
      "approve-no-tty",
      "--message without a terminal records an approval-needing script as denied",
      noTty.exitCode === 0 &&
        noTty.stderr.includes("沒有終端可以核准") &&
        noTtyResult.includes("擁有者拒絕") &&
        !noTtyResult.includes("PUSHED"),
      `${brief(noTty)}; result ${JSON.stringify(noTtyResult)}`,
    );

    // --- 6. kill -9 while a script runs, then --resume, in one step: each step has its own pid
    // namespace, so only within it can the script's process be seen to outlive tars chat.
    fake.reply(text("ready"));
    await run("kill-9-setup", "tars chat --message start");
    const sleepConv = lastConv();
    // The script's own processes carry MARK-SLEEP; the bracket keeps pgrep off this shell.
    const count = "pgrep -fc 'MARK-[S]LEEP'";
    fake.reply(tarsCall("s1", ["script", "run", "sleeper", "--", "MARK-SLEEP"]));
    fake.reply(text("after the crash"));
    const killed = await run(
      "kill-9-resume",
      [
        `tars chat --resume ${sleepConv} --message sleep >/dev/null 2>&1 & p=$!`,
        `i=0; while [ "$(${count})" = 0 ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`,
        "sleep 1",
        `echo "running=$(${count})"`,
        "kill -9 $p; wait $p",
        `tars chat --resume ${sleepConv.slice(-8)} --message again; echo "rc=$?"`,
        "sleep 1",
        `echo "after=$(${count})"`,
      ].join("\n"),
    );
    const sleeperCalls = query<{ state: string }>(
      "SELECT state FROM tool_calls WHERE conv_id = ? AND input LIKE '%sleeper%'",
      sleepConv,
    );
    const interruptedText = query<{ body: string }>(
      "SELECT body FROM items WHERE conv_id = ? AND kind = 'tool_result'",
      sleepConv,
    ).map((r) => r.body);
    check(
      "kill-resume",
      "after kill -9 the script's processes outlive tars chat; --resume stops their group, marks the call unknown, and the script ran exactly once",
      /running=[1-9]/.test(killed.stdout) &&
        killed.stderr.includes("清掉 1 個留下的子行程") &&
        killed.stdout.includes("rc=0") &&
        killed.stdout.includes("after=0") &&
        sleeperRuns === 1 &&
        sleeperCalls.length === 1 &&
        sleeperCalls[0]?.state === "interrupted" &&
        interruptedText.some((b) => b.includes("中斷，結果不明")) &&
        historyProblems(messagesOf(lastBody())).length === 0,
      `${brief(killed)}; runs ${sleeperRuns}; calls ${JSON.stringify(sleeperCalls)}`,
    );

    // --- 7. Inside a tars session.
    const inSession = await run("in-session", "tars chat --message hi", { TARS_IN_SESSION: "1" });
    check(
      "in-session",
      "TARS_IN_SESSION=1 tars chat is refused",
      inSession.exitCode === 1 && inSession.stderr.includes("只給你自己終端的 tars chat 用"),
      brief(inSession),
    );

    // --- 8. Two tars chat in one step.
    fake.reply({ kind: "hang" });
    const two = await run(
      "two-chats",
      'tars chat --message first >/dev/null 2>&1 & p=$!; sleep 3; tars chat --message second; echo "rc=$? first=$p"; kill $p; wait $p',
    );
    const firstPid = /first=(\d+)/.exec(two.stdout)?.[1] ?? "?";
    check(
      "lock",
      "a second tars chat is refused and names the first one's pid",
      two.stdout.includes("rc=1") && two.stderr.includes(`pid ${firstPid}`),
      brief(two),
    );

    // --- 9. A script cannot read agent.db.
    fake.reply(tarsCall("d1", ["script", "run", "dbreader"]), text("db done"));
    const dbRead = await run("db-read", "tars chat --message db");
    const dbResult = lastToolResult(lastBody());
    check(
      "agent-db",
      "a script run through the loop cannot read agent.db",
      dbRead.exitCode === 0 && dbResult.includes("DB-DENIED") && !dbResult.includes("DB-READ"),
      `${brief(dbRead)}; result ${JSON.stringify(dbResult.slice(0, 200))}`,
    );

    // --- 10. tars memory is blocked.
    const memory = join(data, "MEMORY.md");
    const sha = () => createHash("sha256").update(readFileSync(memory)).digest("hex");
    const before = sha();
    fake.reply(
      tarsCall("m1", [
        "memory",
        "remember",
        "--id",
        "x",
        "--section",
        "偏好",
        "--text",
        "y",
        "--source",
        "user",
      ]),
      text("ok"),
    );
    const blocked = await run("memory-blocked", "tars chat --message remember");
    check(
      "memory-blocked",
      "tars memory remember through the tool is blocked and MEMORY.md is unchanged",
      blocked.exitCode === 0 && blocked.stderr.includes("已擋下") && sha() === before,
      brief(blocked),
    );

    // --- 11. A base URL that is not plain loopback.
    const badUrl = { [E2E_BASE_URL_VAR]: "http://127.0.0.1:80@x" };
    const badChat = await run("bad-url-chat", "tars chat --message hi", badUrl);
    const badRefresh = await run("bad-url-refresh", "tars models refresh", badUrl);
    check(
      "bad-url",
      "tars chat and tars models refresh refuse a base URL that is not plain loopback",
      badChat.exitCode === 1 && badRefresh.exitCode === 1,
      `chat ${brief(badChat)}; refresh ${brief(badRefresh)}`,
    );

    // --- 11b. 429 to the last retry, and a keyring that cannot be reached: each named as it is.
    const limited = {
      kind: "http_error",
      status: 429,
      type: "rate_limit_error",
      retryAfter: "0",
    } as const;
    fake.reply(limited, limited, limited);
    const rate = await run("rate-limited", "tars chat --message rate");
    const rateErrors = query<{ body: string }>(
      "SELECT body FROM items WHERE kind = 'error' ORDER BY rowid DESC LIMIT 1",
    ).map((r) => JSON.parse(r.body) as { code: string; data?: { attempts?: number } });
    check(
      "rate-limited",
      "429 to the last retry ends as rate_limited, in the terminal and in the error item",
      rate.stderr.includes("失敗：provider 的流量限制（HTTP 429），重試用完了") &&
        rateErrors[0]?.code === "rate_limited" &&
        rateErrors[0]?.data?.attempts === 3,
      `${brief(rate)}; error ${JSON.stringify(rateErrors[0])}`,
    );
    const keyring = await run(
      "keyring-unreachable",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/bus tars chat --message hi",
    );
    check(
      "keyring-unreachable",
      "a keyring that cannot be reached is said as such, not as a missing key",
      keyring.exitCode === 1 &&
        keyring.stderr.includes("讀不到本機的系統金鑰庫") &&
        !keyring.stderr.includes("沒有 anthropic 的 API 金鑰"),
      brief(keyring),
    );

    // --- 12. Q5: /tmp/claude exists.
    fake.reply(tarsCall("q1", ["script", "run", "weather", "--", "q5"]), text("q5 done"));
    const q5 = await run("q5", "mkdir -p /tmp/claude && tars chat --message q5");
    const q5Result = lastToolResult(lastBody());
    const q5Calls = query<{ state: string }>(
      "SELECT state FROM tool_calls WHERE input LIKE '%\"q5\"%'",
    );
    check(
      "q5",
      "with /tmp/claude present the script is refused, the call ends failed, and the turn completes",
      q5.exitCode === 0 &&
        q5Result.includes("/tmp/claude exists") &&
        !q5Result.includes("WEATHER-OK") &&
        q5.stderr.includes("← failed") &&
        q5Calls.length === 1 &&
        q5Calls[0]?.state === "failed",
      `${brief(q5)}; calls ${JSON.stringify(q5Calls)}; tool result ${JSON.stringify(q5Result.slice(0, 300))}`,
    );

    // --- 13. Compaction.
    writeFileSync(
      join(host.fakeHome, ".config/tars/config.toml"),
      CONFIG_TEMPLATE.replace(/^max_input_tokens = .*$/m, "max_input_tokens = 20000")
        .replace(/^compact_keep_recent_tokens = .*$/m, "compact_keep_recent_tokens = 1000")
        .replace(/^compact_max_output_tokens = .*$/m, "compact_max_output_tokens = 1024")
        .replace(/^context_warn_ratio = .*$/m, "context_warn_ratio = 0.40")
        .replace(/^context_compact_ratio = .*$/m, "context_compact_ratio = 0.50"),
    );
    const big = (n: number) => `第 ${n} 段：${"天氣資料".repeat(250)}`;
    fake.reply(sized(text("one"), 3000));
    const c1 = await run("compact-1", `tars chat --message "${big(1)}"`);
    const conv = lastConv();
    const resume = (name: string, message: string) =>
      run(name, `tars chat --resume ${conv} --message "${message}"`);
    fake.reply(tarsCall("cw", ["script", "run", "weather", "--", "c2"]), sized(text("two"), 11000));
    const c2 = await resume("compact-2", big(2));
    const itemsBefore = query<{ seq: number; body: string }>(
      "SELECT seq, body FROM items WHERE conv_id = ? ORDER BY seq",
      conv,
    );
    const auto0 = fake.messages().length;
    fake.reply(text(summaryText("first")), sized(text("three"), 4000));
    const c3 = await resume("compact-auto", big(3));
    const autoSummaryBody = fake.messages()[auto0]?.body;
    const afterAuto = lastBody();
    const manual0 = fake.messages().length;
    fake.reply(text(summaryText("second")));
    const manual = await dialog("compact-manual", `tars chat --resume ${conv}`, [
      { expect: PROMPT, send: "/compact 保留天氣\n" },
      { expect: PROMPT, send: "\u0004" },
    ]);
    const manualBody = fake.messages()[manual0]?.body;
    fake.reply(sized(text("four"), 3000));
    const c4 = await resume("compact-4", "after compaction one");
    const body4 = lastBody();
    fake.reply(sized(text("five"), 11000));
    const c5 = await resume("compact-5", big(5));
    const body5 = lastBody();
    // Auto compaction starts on the next message; its summary request never answers.
    fake.reply({ kind: "hang" });
    const killedCompact = await run(
      "compact-kill-9",
      `tars chat --resume ${conv} --message "${big(6)}" >/dev/null 2>&1 & p=$!; sleep 4; kill -9 $p; wait $p; echo killed`,
    );
    fake.reply(text(summaryText("third")), sized(text("six"), 3000));
    const c6 = await resume("compact-after-kill", big(6));
    const compactions = query<{ body: string }>(
      "SELECT body FROM items WHERE conv_id = ? AND kind = 'compaction' ORDER BY seq",
      conv,
    );
    const interruptedCompactions = query<{ id: string }>(
      "SELECT id FROM turns WHERE conv_id = ? AND kind = 'compaction' AND state = 'interrupted'",
      conv,
    );
    const itemsAfter = query<{ seq: number; body: string }>(
      "SELECT seq, body FROM items WHERE conv_id = ? AND seq <= ? ORDER BY seq",
      conv,
      String(itemsBefore.at(-1)?.seq ?? 0),
    );
    const laterBodies = [afterAuto, body4, body5, lastBody()];
    check(
      "compaction",
      "auto compaction, /compact with a focus, kill -9 during a summary: three compactions, valid history, old rows unchanged",
      [c1, c2, c3, c4, c5, c6].every((r) => r.exitCode === 0) &&
        manual.exitCode === 0 &&
        killedCompact.stdout.includes("killed") &&
        compactions.length === 3 &&
        interruptedCompactions.length === 1 &&
        firstText(autoSummaryBody).includes("<conversation>") &&
        !firstText(autoSummaryBody).includes("<previous-summary>") &&
        firstText(manualBody).includes("<previous-summary>") &&
        firstText(manualBody).includes("Additional focus: 保留天氣") &&
        laterBodies.every(
          (b) =>
            firstText(b).startsWith(SUMMARY_PREFIX) && historyProblems(messagesOf(b)).length === 0,
        ) &&
        JSON.stringify(itemsAfter) === JSON.stringify(itemsBefore),
      `exits ${[c1, c2, c3, c4, c5, c6].map((r) => r.exitCode).join("/")} manual ${manual.exitCode} (missed ${manual.missed}); compactions ${compactions.length}; interrupted ${interruptedCompactions.length}; stderr ${JSON.stringify(c3.stderr.slice(-300))}`,
    );

    // --- 14. Slash commands on the pty.
    const slash0 = fake.messages().length;
    fake.reply(toolUse("sk", "skill_load", { name: "socratic-tutor" }), text("tutor"));
    const slash = await dialog("slash", "tars chat", [
      { expect: PROMPT, send: "/socratic-tutor 我想學線性代數\n" },
      { expect: PROMPT, send: "/memory 記住這個\n" },
      { expect: PROMPT, send: "/model\n" },
      { expect: PROMPT, send: "/cost\n" },
      { expect: PROMPT, send: "\u0004" },
    ]);
    const sent = fake.messages().slice(slash0);
    const skillText = firstText(sent[0]?.body);
    check(
      "slash",
      "/socratic-tutor sends the fixed text and the model loads the skill; /memory, /model, /cost send nothing",
      slash.exitCode === 0 &&
        sent.length === 2 &&
        skillText ===
          "請用 skill「socratic-tutor」處理下面的內容。先用 skill_load 讀它。\n\n我想學線性代數" &&
        slash.stderr.includes("要在 tars claude 裡用") &&
        slash.stderr.includes(`目前的模型：anthropic/${MODEL}`) &&
        slash.stderr.includes("anthropic: 本期已用"),
      `exit ${slash.exitCode}; missed ${slash.missed}; requests ${sent.length}; text ${JSON.stringify(skillText)}; stderr ${JSON.stringify(slash.stderr.slice(-400))}`,
    );

    // --- 15. Archive: out of the list, kept apart, not resumable, taken back.
    const convList = await run("arch-list", "tars chat --list");
    const archiveId = convList.stdout.split("\n")[0]?.split("\t")[0] ?? "";
    const countsBefore = query<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM usage) AS n",
    )[0]?.n;
    const archivedRun = await run("arch-archive", `tars chat --archive ${archiveId}`);
    const listAfter = await run("arch-list-after", "tars chat --list");
    const listArchived = await run("arch-list-archived", "tars chat --list --archived");
    const requestsBefore = fake.messages().length;
    const resumeArchived = await run(
      "arch-resume",
      `tars chat --resume ${archiveId} --message again`,
    );
    const dry = await run("arch-dry", "tars chat --archive-older-than 1 --dry-run");
    const unarchived = await run("arch-unarchive", `tars chat --unarchive ${archiveId}`);
    const listBack = await run("arch-list-back", "tars chat --list");
    const countsAfter = query<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM usage) AS n",
    )[0]?.n;
    check(
      "archive",
      "--archive takes a conversation out of --list into --list --archived; --resume refuses it; --unarchive brings it back; no data is lost",
      archiveId !== "" &&
        archivedRun.exitCode === 0 &&
        !listAfter.stdout.includes(archiveId) &&
        listArchived.stdout.startsWith(archiveId) &&
        resumeArchived.exitCode === 1 &&
        resumeArchived.stderr.includes("--unarchive") &&
        fake.messages().length === requestsBefore &&
        dry.exitCode === 0 &&
        unarchived.exitCode === 0 &&
        listBack.stdout.includes(archiveId) &&
        countsBefore === countsAfter,
      `exits ${[archivedRun, resumeArchived, dry, unarchived].map((r) => r.exitCode).join("/")}; resume stderr ${JSON.stringify(resumeArchived.stderr.slice(-200))}; counts ${countsBefore}/${countsAfter}`,
    );
  } finally {
    await fake.stop();
    await runLog.stop(true);
  }
  printChecks(checks);
  return finishChecks(checks, host.work);
}

if (import.meta.main)
  process.exitCode = process.env[INNER]
    ? await inner()
    : enterScriptNetns(import.meta.path, INNER, "e2e:chat");
