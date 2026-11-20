import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { resolvePaths, type Env, type TarsPaths } from "../../../src/core/paths.ts";
import type { SecretName } from "../../../src/core/secrets.ts";
import type { ModelEntry } from "../../../src/features/agent/catalog.ts";
import { CONFIG_TEMPLATE } from "../../../src/features/agent/config.ts";
import type { WikiSpend } from "../../../src/features/wiki/db.ts";
import { openDb } from "../../../src/features/agent/db.ts";
import { createEngine, type Engine } from "../../../src/features/agent/engine.ts";
import type { Frontend, FrontendEvent } from "../../../src/features/agent/frontend.ts";
import { createLog } from "../../../src/features/agent/log.ts";
import { adapterFor, E2E_BASE_URL_VAR } from "../../../src/features/agent/provider.ts";
import type { ApprovalRecord, NoticeCode } from "../../../src/features/agent/types.ts";
import { startFakeAnthropic, type FakeAnthropic } from "../../fakes/anthropic.ts";
import { fakeSecrets, tempHome, TEST_NOW, type FakeSecrets } from "../../helpers.ts";

export const MODEL_ID = "model-a";
export const REPO = resolvePath(import.meta.dir, "../../..");

export const MODEL_ENTRY: ModelEntry = {
  provider: "anthropic",
  id: MODEL_ID,
  label: "Model A",
  status: "active",
  default: true,
  contextWindow: 200000,
  maxOutput: 32000,
  effortLevels: ["low", "medium", "high"],
  thinkingTypes: ["adaptive", "disabled"],
  price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  pricedAt: "2026-11-19",
  firstSeen: "2026-11-19",
  lastSeen: "2026-11-19",
};

export type Answer = "approved" | "denied" | "cancelled";

export interface RecordingFrontend extends Frontend {
  readonly events: FrontendEvent[];
  readonly approvals: ApprovalRecord[];
  notices(): NoticeCode[];
  /** Answers askApproval; by default "denied". It may wait on the signal. */
  answer: (approval: ApprovalRecord, signal: AbortSignal) => Promise<Answer>;
}

export function recordingFrontend(): RecordingFrontend {
  const events: FrontendEvent[] = [];
  const approvals: ApprovalRecord[] = [];
  const fe: RecordingFrontend = {
    events,
    approvals,
    notices: () => events.flatMap((e) => (e.type === "notice" ? [e.code] : [])),
    answer: async () => "denied",
    emit: (e) => void events.push(e),
    askApproval: (approval, signal) => {
      approvals.push(approval);
      return fe.answer(approval, signal);
    },
  };
  return fe;
}

/** A clock the test moves; the engine reads it for every timestamp and expiry. */
export interface Clock {
  now(): Date;
  advance(ms: number): void;
}

export function testClock(start = TEST_NOW): Clock {
  let t = start;
  return { now: () => new Date(t), advance: (ms) => void (t += ms) };
}

export interface EngineHarness {
  readonly paths: TarsPaths;
  readonly env: Env;
  readonly db: Database;
  readonly fake: FakeAnthropic;
  readonly engine: Engine;
  readonly frontend: RecordingFrontend;
  readonly clock: Clock;
  readonly secrets: FakeSecrets;
  /** Every wait the engine asked for, in ms; the fake sleep returns at once. */
  readonly sleeps: number[];
  readonly warnings: string[];
  /** What otherSpend returns: wiki sync's spend, all zero unless a test sets it. */
  otherSpend: WikiSpend | undefined;
  /** Rebuilds the engine on the same database, as a restart of tars chat would. */
  restart(): Engine;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  /** Fields replacing the default model entry's. */
  readonly model?: Partial<ModelEntry>;
  /** The whole config.toml; CONFIG_TEMPLATE by default. */
  readonly config?: string;
  readonly selfCommand?: readonly string[];
  /** Entries listed after the default model's. */
  readonly extraModels?: readonly ModelEntry[];
  readonly extraEnv?: Env;
  readonly extraSecrets?: Partial<Record<SecretName, string>>;
}

/** config.toml text with some `key = value` lines of the template replaced. */
export function configWith(values: Readonly<Record<string, string | number | boolean>>): string {
  let text = CONFIG_TEMPLATE;
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^${key} = .*$`, "m");
    if (!line.test(text)) throw new Error(`no ${key} in CONFIG_TEMPLATE`);
    text = text.replace(
      line,
      `${key} = ${typeof value === "string" ? JSON.stringify(value) : value}`,
    );
  }
  return text;
}

export function writeCatalog(paths: TarsPaths, models: readonly ModelEntry[]): void {
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(paths.modelsFile, `${JSON.stringify({ version: 1, models }, null, 2)}\n`);
}

/**
 * An installed-looking data dir under a temp HOME, a fake Anthropic server, and an engine wired
 * to both. The child tars is this checkout's src/main.ts unless `selfCommand` says otherwise.
 */
export async function engineHarness(opts: HarnessOptions = {}): Promise<EngineHarness> {
  const home = tempHome();
  const fake = startFakeAnthropic();
  const env: Env = {
    HOME: home,
    TARS_DATA_DIR: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    [E2E_BASE_URL_VAR]: fake.url,
    ...opts.extraEnv,
  };
  const paths = resolvePaths(env);
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(paths.configFile, opts.config ?? CONFIG_TEMPLATE);
  writeCatalog(paths, [{ ...MODEL_ENTRY, ...opts.model }, ...(opts.extraModels ?? [])]);
  mkdirSync(join(paths.skills, "demo"), { recursive: true });
  writeFileSync(
    join(paths.skills, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\n---\n# Demo\nstep one\n",
  );
  writeFileSync(paths.soul, "# Soul\n");
  writeFileSync(paths.memory, "# Memory\n");
  const db = await openDb(paths);
  const frontend = recordingFrontend();
  const clock = testClock();
  const secrets = fakeSecrets({ "llm:anthropic": "sk-test", ...opts.extraSecrets });
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const spend = {
    value: { period: 0, today: 0, rawToday: 0, rawMonth: 0 } as WikiSpend | undefined,
  };
  const build = () =>
    createEngine({
      db,
      paths,
      env,
      secrets,
      adapterFor,
      selfCommand: opts.selfCommand ?? [process.execPath, join(REPO, "src/main.ts")],
      approveCommand: (name) => `tars script approve ${name}`,
      now: () => clock.now(),
      sleep: async (ms) => void sleeps.push(ms),
      log: createLog(paths.agentLog, () => clock.now()),
      warn: (w) => void warnings.push(w),
      otherSpend: () => spend.value,
    });
  return {
    paths,
    env,
    db,
    fake,
    engine: build(),
    frontend,
    clock,
    secrets,
    sleeps,
    warnings,
    get otherSpend() {
      return spend.value;
    },
    set otherSpend(value) {
      spend.value = value;
    },
    restart: build,
    stop: async () => {
      db.close();
      await fake.stop();
    },
  };
}

interface Block {
  type: string;
  id?: string;
  tool_use_id?: string;
}

/**
 * The structure Anthropic requires of `messages`: roles alternate starting with user, every
 * tool_use is answered by exactly one tool_result in the next message, and no result is orphaned.
 * Returns the problems found; empty means valid.
 */
export function historyProblems(messages: unknown): string[] {
  const problems: string[] = [];
  const list = messages as { role: string; content: Block[] }[];
  if (list[0]?.role !== "user") problems.push("first message is not from the user");
  list.forEach((m, i) => {
    if (i > 0 && list[i - 1]?.role === m.role)
      problems.push(`messages ${i - 1} and ${i} share a role`);
    if (m.content.length === 0) problems.push(`message ${i} is empty`);
    const uses = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    const next = list[i + 1]?.content ?? [];
    const results = next.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    for (const id of uses)
      if (results.filter((r) => r === id).length !== 1)
        problems.push(`tool_use ${id} in message ${i} has no single result`);
    if (m.role === "user") {
      const prev = list[i - 1]?.content ?? [];
      const asked = new Set(prev.filter((b) => b.type === "tool_use").map((b) => b.id));
      for (const b of m.content)
        if (b.type === "tool_result" && !asked.has(b.tool_use_id))
          problems.push(`tool_result ${b.tool_use_id} in message ${i} answers nothing`);
    }
  });
  return problems;
}
