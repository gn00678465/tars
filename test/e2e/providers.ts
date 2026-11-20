import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_BASE_URL_VARS } from "../../src/features/agent/provider.ts";
import { capabilities, startFakeAnthropic } from "../fakes/anthropic.ts";
import { compatCall, compatText, startFakeCompat } from "../fakes/openai-compat.ts";
import { runDialog } from "./pty.ts";
import { finishChecks, printChecks, type Check } from "./sandbox.ts";
import { enterScriptNetns, install, lastJson, scriptHost } from "./script-host.ts";

const INNER = "TARS_E2E_PROVIDERS_INNER";
const ANTHROPIC_MODEL = "model-e2e";
const GEMINI_MODEL = "gem-e2e";
const OR_MODEL = "vendor/or-e2e";
const OR_GONE = "vendor/or-gone";
const KEYS = {
  anthropic: "sk-e2e-" + "fake-key",
  gemini: "gm-e2e-" + "fake-key",
  openrouter: "or-e2e-" + "fake-key",
} as const;

const weather = `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "weather"
# summary = "e2e weather"
# domains = ["example.com"]
# effects = "read-only"
# args = "<anything>"
# outputs = "one line"
# exit = { 0 = "ok" }
# ///
import sys
print("WEATHER-OK", *sys.argv[1:])
`;

/** An OpenRouter /models entry with prices per token, as upstream sends them. */
const upstream = (id: string) => ({
  id,
  name: `Name of ${id}`,
  context_length: 100000,
  top_provider: { max_completion_tokens: 8000 },
  supported_parameters: ["reasoning"],
  pricing: { prompt: "0.000002", completion: "0.000008" },
});

type Body = Record<string, unknown>;
type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: { extra_content?: { google?: { thought_signature?: string } } }[];
};
const messagesOf = (body: Body | undefined) => (body?.messages ?? []) as ChatMessage[];
const contentText = (m: ChatMessage | undefined) =>
  typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");

async function inner(): Promise<number> {
  const { host, python, step } = scriptHost("tars-e2e-providers-");
  const anthropic = startFakeAnthropic();
  anthropic.models = [
    {
      id: ANTHROPIC_MODEL,
      display_name: "Model E2E",
      max_input_tokens: 200000,
      max_tokens: 32000,
      capabilities: capabilities(["low", "medium", "high"]),
    },
  ];
  const gemini = startFakeCompat("gemini");
  gemini.models = [{ id: `models/${GEMINI_MODEL}`, object: "model", owned_by: "google" }];
  const openrouter = startFakeCompat("openrouter");
  openrouter.models = [upstream(OR_MODEL), upstream(OR_GONE)];
  const env = {
    [E2E_BASE_URL_VARS.anthropic]: anthropic.url,
    [E2E_BASE_URL_VARS.gemini]: gemini.url,
    [E2E_BASE_URL_VARS.openrouter]: openrouter.url,
  };
  const run = (name: string, command: string, extra: Record<string, string> = {}) =>
    step(name, command, { ...env, ...extra });
  const data = join(host.fakeHome, ".local/share/tars");
  const query = <T>(sql: string, ...params: string[]) => {
    const conn = new Database(join(data, "agent/agent.db"), { readonly: true });
    try {
      return conn.query(sql).all(...params) as T[];
    } finally {
      conn.close();
    }
  };
  const lastUsage = () =>
    query<{ provider: string; state: string; cost_usd: number; cost_source: string }>(
      "SELECT provider, state, cost_usd, cost_source FROM usage ORDER BY id DESC LIMIT 1",
    )[0];
  const lastConv = () =>
    query<{ id: string }>("SELECT id FROM conversations ORDER BY rowid DESC LIMIT 1")[0]?.id ?? "";
  const keyCalls = () => openrouter.requests.filter((r) => r.path === "/key").length;
  const openrouterSpent = async () => {
    const r = await run("cost-json", "tars cost --json");
    const providers = (lastJson(r.stdout).providers ?? []) as {
      provider: string;
      spentUsd: number;
    }[];
    return providers.find((p) => p.provider === "openrouter")?.spentUsd ?? Number.NaN;
  };
  const checks: Check[] = [];
  const check = (id: string, claim: string, pass: boolean, evidence: string) =>
    checks.push({ id, claim, pass, evidence });
  const brief = (r: { exitCode: number | null; stdout: string; stderr: string }) =>
    `exit ${r.exitCode}; stdout ${JSON.stringify(r.stdout.slice(0, 200))}; stderr ${JSON.stringify(r.stderr.slice(-400))}`;

  try {
    // --- Setup: three providers enabled, keys in the sandbox's own keyring, one model each.
    const fixtures = join(host.work, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, "SOUL.md"), "# Soul\nE2E soul\n");
    writeFileSync(join(fixtures, "MEMORY.md"), "# Memory\nE2E memory\n");
    const setup: { exitCode: number | null; stdout: string; stderr: string }[] = [
      await run(
        "install",
        `tars install --soul ${fixtures}/SOUL.md --memory ${fixtures}/MEMORY.md --no-modify-path`,
      ),
      await run("config-init", "tars config init"),
    ];
    const configFile = join(host.fakeHome, ".config/tars/config.toml");
    writeFileSync(
      configFile,
      readFileSync(configFile, "utf8")
        .replace("[providers.gemini]\nenabled = false", "[providers.gemini]\nenabled = true")
        .replace(
          "[providers.openrouter]\nenabled = false",
          "[providers.openrouter]\nenabled = true",
        ),
    );
    for (const provider of ["anthropic", "gemini", "openrouter"] as const) {
      const r = await runDialog(host, {
        name: `llm-key-set-${provider}`,
        command: `tars llm key set ${provider}`,
        tty: true,
        env,
        turns: [{ expect: "API 金鑰：", send: `${KEYS[provider]}\n` }],
      });
      setup.push({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
    }
    const weatherDir = install(host, "weather", weather);
    setup.push(
      await run("venv", `python3 -m venv --without-pip ${weatherDir}/venv-${python}`),
      await run(
        "models-anthropic",
        `tars models refresh && tars models set anthropic/${ANTHROPIC_MODEL} --input 3 --output 15 --cache-read 0.3 --cache-write 3.75 && tars models enable anthropic/${ANTHROPIC_MODEL} && tars models default anthropic/${ANTHROPIC_MODEL}`,
      ),
      await run(
        "models-gemini",
        `tars models refresh --provider gemini && tars models set gemini/${GEMINI_MODEL} --input 1 --output 4 --cache-read 0.25 --cache-write 1 --context-window 100000 --max-output 8000 --effort-levels low,medium,high --thinking-types disabled && tars models enable gemini/${GEMINI_MODEL}`,
      ),
      await run(
        "models-openrouter",
        `tars models refresh --provider openrouter --add ${OR_MODEL} --add ${OR_GONE} && tars models enable openrouter/${OR_MODEL} && tars models enable openrouter/${OR_GONE}`,
      ),
    );
    const failed = setup.find((r) => r.exitCode !== 0);
    if (failed !== undefined) throw new Error(`setup failed: ${brief(failed)}`);

    // --- 1. Gemini: one turn, the request's shape and its usage row.
    gemini.reply(compatText("GEMINI-REPLY", { prompt: 1000, completion: 50, total: 1200 }));
    const g1 = await run("gemini-message", `tars chat --model gemini/${GEMINI_MODEL} --message hi`);
    const g1Req = gemini.chats().at(-1);
    const g1Usage = lastUsage();
    check(
      "gemini-message",
      "Gemini: the reply on stdout; the request streams with usage, sends the effort and the key; the usage row is final",
      g1.exitCode === 0 &&
        g1.stdout === "GEMINI-REPLY\n" &&
        g1Req?.body.model === GEMINI_MODEL &&
        g1Req.body.stream === true &&
        (g1Req.body.stream_options as { include_usage?: boolean } | undefined)?.include_usage ===
          true &&
        g1Req.body.reasoning_effort === "medium" &&
        messagesOf(g1Req.body)[0]?.role === "system" &&
        g1Req.headers.authorization === `Bearer ${KEYS.gemini}` &&
        g1Usage?.provider === "gemini" &&
        g1Usage.state === "final" &&
        g1Usage.cost_source === "table",
      `${brief(g1)}; body ${JSON.stringify({ ...g1Req?.body, messages: undefined })}; usage ${JSON.stringify(g1Usage)}`,
    );

    // --- 2. Gemini: a tool call and back; the signature goes back with the call.
    const g2Before = gemini.chats().length;
    gemini.reply(
      compatCall(
        "g1",
        "tars",
        { argv: ["script", "run", "weather", "--", "Taipei"] },
        { signature: "sig-e2e" },
      ),
      compatText("weather done"),
    );
    const g2 = await run(
      "gemini-tool",
      `tars chat --model gemini/${GEMINI_MODEL} --message weather`,
    );
    const g2Second = gemini.chats()[g2Before + 1];
    const g2Messages = messagesOf(g2Second?.body);
    const g2Call = g2Messages.find((m) => m.role === "assistant" && m.tool_calls !== undefined);
    const g2Result = g2Messages.find((m) => m.role === "tool");
    check(
      "gemini-tool",
      "Gemini: a free script runs; the next request sends the call back with its signature and is not refused",
      g2.exitCode === 0 &&
        g2.stdout.includes("weather done") &&
        g2Call?.tool_calls?.[0]?.extra_content?.google?.thought_signature === "sig-e2e" &&
        contentText(g2Result).includes("WEATHER-OK Taipei"),
      `${brief(g2)}; call ${JSON.stringify(g2Call?.tool_calls)}; result ${contentText(g2Result).slice(0, 200)}`,
    );

    // --- 3. OpenRouter: the amount is the response's cost.
    openrouter.reply(compatText("OR-REPLY", { prompt: 100, completion: 10, cost: 0.0123 }));
    const o1 = await run(
      "openrouter-message",
      `tars chat --model openrouter/${OR_MODEL} --message hi`,
    );
    const cost = await run("cost-json-provider", "tars cost --json");
    const recent = (lastJson(cost.stdout).recent ?? []) as {
      model: string;
      costUsd: number;
      costSource: string;
    }[];
    const orRow = recent.find((r) => r.model === OR_MODEL);
    check(
      "openrouter-cost",
      "OpenRouter: tars cost --json lists the request at the response's cost, costSource provider",
      o1.exitCode === 0 && orRow?.costSource === "provider" && orRow.costUsd === 0.0123,
      `${brief(o1)}; recent ${JSON.stringify(recent.slice(0, 3))}`,
    );

    // --- 4. OpenRouter: 402 fails the turn without a retry.
    const o2Before = openrouter.chats().length;
    openrouter.reply({ kind: "http_error", status: 402, message: "Insufficient credits" });
    const o2 = await run("openrouter-402", `tars chat --model openrouter/${OR_MODEL} --message hi`);
    const o2Turn = query<{ state: string; reason: string }>(
      "SELECT state, reason FROM turns ORDER BY rowid DESC LIMIT 1",
    )[0];
    check(
      "openrouter-402",
      "OpenRouter 402: the turn fails as provider_spend_limit, one request, no retry",
      o2.exitCode === 1 &&
        o2Turn?.state === "failed" &&
        o2Turn.reason === "provider_spend_limit" &&
        openrouter.chats().length === o2Before + 1,
      `${brief(o2)}; turn ${JSON.stringify(o2Turn)}; requests ${openrouter.chats().length - o2Before}`,
    );

    // --- 5. SIGINT mid-stream: the row is an estimate above 0.
    gemini.reply({ kind: "hang", text: "partial" });
    const g3 = await run(
      "gemini-sigint",
      `tars chat --model gemini/${GEMINI_MODEL} --message slow >/dev/null 2>&1 & p=$!; sleep 3; kill -INT $p; wait $p; echo "rc=$?"`,
    );
    const g3Usage = lastUsage();
    check(
      "sigint-estimate",
      "SIGINT while Gemini streams: the usage row is estimated and above 0",
      g3.stdout.includes("rc=") &&
        g3Usage?.provider === "gemini" &&
        g3Usage.state === "estimated" &&
        g3Usage.cost_usd > 0,
      `${brief(g3)}; usage ${JSON.stringify(g3Usage)}`,
    );

    // --- 6. Anthropic at its stop line; Gemini goes ahead.
    const anthropicBefore = anthropic.messages().length;
    const adjusted = await runDialog(host, {
      name: "adjust-anthropic",
      command: "tars cost adjust anthropic --spent 95",
      tty: true,
      env,
      turns: [{ expect: "確定？輸入 yes 或 no：", send: "yes\n" }],
    });
    const stopped = await run("anthropic-stopped", "tars chat --message hi");
    gemini.reply(compatText("STILL-OK"));
    const goes = await run("gemini-goes", `tars chat --model gemini/${GEMINI_MODEL} --message hi`);
    check(
      "one-provider-stopped",
      "Anthropic at its stop line refuses and sends nothing; a Gemini message completes",
      adjusted.exitCode === 0 &&
        stopped.exitCode === 1 &&
        stopped.stderr.includes("沒有送出") &&
        anthropic.messages().length === anthropicBefore &&
        goes.exitCode === 0 &&
        goes.stdout === "STILL-OK\n",
      `adjust exit ${adjusted.exitCode} missed ${adjusted.missed}; stopped ${brief(stopped)}; gemini ${brief(goes)}`,
    );

    // --- 7. A model gone upstream: retired, its conversation refused, continued on Gemini.
    openrouter.reply(compatText("OLD-MODEL-REPLY", { cost: 0.001 }));
    const onGone = await run(
      "on-gone-model",
      `tars chat --model openrouter/${OR_GONE} --message "記下台北的天氣"`,
    );
    const goneConv = lastConv();
    openrouter.models = [upstream(OR_MODEL)];
    const refreshed = await run("refresh-retire", "tars models refresh --provider openrouter");
    const listed = await run("models-list", "tars models list --json");
    const goneEntry = (
      (lastJson(listed.stdout).models ?? []) as { provider: string; id: string; status: string }[]
    ).find((m) => m.provider === "openrouter" && m.id === OR_GONE);
    const refused = await run("resume-retired", `tars chat --resume ${goneConv} --message again`);
    const gBefore = gemini.chats().length;
    gemini.reply(compatText("CONTINUED"));
    const continued = await run(
      "continue-on-gemini",
      `tars chat --continue ${goneConv.slice(-8)} --model gemini/${GEMINI_MODEL} --message "繼續剛才的整理"`,
    );
    const contReq = gemini.chats()[gBefore];
    const firstUser = contentText(messagesOf(contReq?.body).find((m) => m.role === "user"));
    const child = query<{ parent_id: string | null }>(
      "SELECT parent_id FROM conversations ORDER BY rowid DESC LIMIT 1",
    )[0];
    check(
      "retired-continue",
      "refresh retires the model gone upstream; its conversation is refused; --continue on Gemini carries its text",
      onGone.exitCode === 0 &&
        refreshed.exitCode === 0 &&
        goneEntry?.status === "retired" &&
        refused.exitCode === 1 &&
        continued.exitCode === 0 &&
        continued.stdout === "CONTINUED\n" &&
        firstUser.includes("<previous-conversation>") &&
        firstUser.includes("記下台北的天氣") &&
        child?.parent_id === goneConv,
      `gone ${brief(onGone)}; entry ${JSON.stringify(goneEntry)}; refused ${brief(refused)}; continued ${brief(continued)}; first ${firstUser.slice(0, 200)}`,
    );

    // --- 8. After an OpenRouter turn, /key once: a higher amount raises the books, a lower one does not.
    const spentBefore = await openrouterSpent();
    const raisedTo = Math.round((spentBefore + 1) * 100) / 100;
    openrouter.key = { limit: 10, limit_remaining: 10 - raisedTo };
    const keysBefore = keyCalls();
    openrouter.reply(compatText("KEY-UP", { cost: 0.001 }));
    const up = await run("key-up", `tars chat --model openrouter/${OR_MODEL} --message hi`);
    const keysAfterUp = keyCalls();
    const spentUp = await openrouterSpent();
    openrouter.key = { limit: 10, limit_remaining: 9.5 };
    openrouter.reply(compatText("KEY-DOWN", { cost: 0.001 }));
    const down = await run("key-down", `tars chat --model openrouter/${OR_MODEL} --message hi`);
    const spentDown = await openrouterSpent();
    check(
      "key-reconcile",
      "one /key request per OpenRouter turn; a higher key amount raises tars cost, a lower one leaves it",
      up.exitCode === 0 &&
        keysAfterUp === keysBefore + 1 &&
        Math.abs(spentUp - raisedTo) < 1e-9 &&
        down.exitCode === 0 &&
        Math.abs(spentDown - spentUp - 0.001) < 1e-9 &&
        down.stderr.includes("本機的帳比 OpenRouter 的金鑰額度多"),
      `up ${brief(up)}; /key ${keysBefore}->${keysAfterUp}; spent ${spentBefore} -> ${spentUp} -> ${spentDown}; down ${brief(down)}`,
    );

    // --- 9. A base URL that is not loopback is refused before anything is sent.
    const gOff = gemini.chats().length;
    const offHost = await run(
      "non-loopback",
      `tars chat --model gemini/${GEMINI_MODEL} --message hi`,
      { [E2E_BASE_URL_VARS.gemini]: "http://192.0.2.1:9" },
    );
    check(
      "non-loopback",
      "TARS_E2E_GEMINI_BASE_URL off loopback: the command refuses and sends nothing",
      offHost.exitCode === 1 &&
        offHost.stderr.includes(E2E_BASE_URL_VARS.gemini) &&
        gemini.chats().length === gOff,
      brief(offHost),
    );
  } finally {
    await anthropic.stop();
    await gemini.stop();
    await openrouter.stop();
  }
  printChecks(checks);
  return finishChecks(checks, host.work);
}

if (import.meta.main)
  process.exitCode = process.env[INNER]
    ? await inner()
    : enterScriptNetns(import.meta.path, INNER, "e2e:providers");
