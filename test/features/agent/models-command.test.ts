import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../../../src/core/paths.ts";
import type { Catalog, ModelEntry } from "../../../src/features/agent/catalog.ts";
import {
  adapterFor,
  E2E_BASE_URL_VARS,
  ProviderError,
} from "../../../src/features/agent/provider.ts";
import type { ListedModel } from "../../../src/features/agent/types.ts";
import { run } from "../../../src/main.ts";
import { capabilities, startFakeAnthropic, type FakeAnthropic } from "../../fakes/anthropic.ts";
import { fakeSecrets, scriptedTerminal, tempHome, testDeps } from "../../helpers.ts";
import { startFakeCompat, type FakeCompat } from "../../fakes/openai-compat.ts";

const CANDIDATE: ModelEntry = {
  provider: "anthropic",
  id: "model-a",
  label: "Model A",
  status: "candidate",
  contextWindow: 200000,
  maxOutput: 64000,
  firstSeen: "2026-11-01",
  lastSeen: "2026-11-01",
};

const ACTIVE: ModelEntry = {
  ...CANDIDATE,
  id: "model-b",
  status: "active",
  price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  priceSource: "manual",
  pricedAt: "2026-11-01",
};

const PRICES = ["--input", "3", "--output", "15", "--cache-read", "0.3", "--cache-write", "3.75"];

function setup(
  models: ModelEntry[] | string | undefined,
  opts: {
    session?: boolean;
    answers?: Parameters<typeof scriptedTerminal>[0];
    listed?: ListedModel[] | Error | (() => Promise<ListedModel[]>);
    env?: Record<string, string>;
  } = {},
) {
  const home = tempHome();
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "cfg"),
    TARS_DATA_DIR: join(home, "data"),
    ...(opts.session ? { TARS_IN_SESSION: "1" } : {}),
    ...opts.env,
  };
  const paths = resolvePaths(env);
  if (models !== undefined) {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(
      paths.modelsFile,
      typeof models === "string" ? models : JSON.stringify({ version: 1, models }),
    );
  }
  const secrets = fakeSecrets({ "llm:anthropic": "sk-test" });
  const keys: string[] = [];
  const deps = testDeps({
    env,
    secrets,
    openTerminal: () => scriptedTerminal(opts.answers ?? []),
    adapterFor: async (provider, key) => {
      keys.push(key);
      return {
        provider,
        stream: () => {
          throw new Error("not used");
        },
        listModels: async () => {
          if (opts.listed instanceof Error) throw opts.listed;
          if (typeof opts.listed === "function") return opts.listed();
          return opts.listed ?? [];
        },
      };
    },
  });
  const read = (): Catalog => JSON.parse(readFileSync(paths.modelsFile, "utf8"));
  const model = (id: string) => read().models.find((m) => m.id === id);
  return { deps, paths, read, model, keys, secrets };
}

describe("write commands", () => {
  test.each<[string[]]>([
    [["refresh"]],
    [["set", "anthropic/model-a", "--label", "x"]],
    [["confirm-prices"]],
    [["enable", "anthropic/model-a"]],
    [["disable", "anthropic/model-b"]],
    [["default", "anthropic/model-b"]],
  ])("models %p is refused inside a tars session", async (args) => {
    const s = setup([CANDIDATE, ACTIVE], { session: true, answers: ["yes"] });
    const before = readFileSync(s.paths.modelsFile, "utf8");
    expect(await run(["models", ...args], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain("只能在你自己的終端執行");
    expect(readFileSync(s.paths.modelsFile, "utf8")).toBe(before);
  });

  test("an invalid models.json is reported and left alone", async () => {
    const s = setup('{"version": 1, "models": [{"id": 1}]}');
    expect(await run(["models", "enable", "anthropic/model-a"], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain("not a valid model list");
    expect(readFileSync(s.paths.modelsFile, "utf8")).toBe('{"version": 1, "models": [{"id": 1}]}');
  });

  test("a model ref without a slash or with an unknown provider is a usage error", async () => {
    const s = setup([CANDIDATE]);
    expect(await run(["models", "enable", "model-a"], s.deps)).toBe(2);
    expect(await run(["models", "enable", "openai/model-a"], s.deps)).toBe(2);
    expect(await run(["models", "refresh", "--provider", "openai"], s.deps)).toBe(2);
  });
});

describe("tars models set", () => {
  test("a model not in the list is exit 1 and points at refresh", async () => {
    const s = setup([CANDIDATE]);
    expect(await run(["models", "set", "anthropic/nope", ...PRICES], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain("tars models refresh");
  });

  test("all four basic prices date the price today", async () => {
    const s = setup([CANDIDATE]);
    expect(await run(["models", "set", "anthropic/model-a", ...PRICES], s.deps)).toBe(0);
    expect(s.model("model-a")).toMatchObject({
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      priceSource: "manual",
      pricedAt: "2026-11-19",
    });
  });

  test("only some prices change the price without re-dating it", async () => {
    const s = setup([ACTIVE]);
    expect(
      await run(
        ["models", "set", "anthropic/model-b", "--output", "16", "--cache-write-1h", "6"],
        s.deps,
      ),
    ).toBe(0);
    expect(s.model("model-b")).toMatchObject({
      price: { input: 3, output: 16, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      pricedAt: "2026-11-01",
    });
  });

  test("an unusual price is refused without --allow-unusual-price; 0 is fine", async () => {
    for (const value of ["0.003", "600"]) {
      const s = setup([CANDIDATE]);
      expect(await run(["models", "set", "anthropic/model-a", "--input", value], s.deps)).toBe(1);
      expect(s.model("model-a")?.price).toBeUndefined();
      expect(
        await run(
          ["models", "set", "anthropic/model-a", "--input", value, "--allow-unusual-price"],
          s.deps,
        ),
      ).toBe(0);
      expect(s.model("model-a")?.price?.input).toBe(Number(value));
    }
    const s = setup([CANDIDATE]);
    expect(await run(["models", "set", "anthropic/model-a", "--cache-read", "0"], s.deps)).toBe(0);
    expect(s.model("model-a")?.price?.cacheRead).toBe(0);
  });

  test("a negative or non-numeric price is a usage error", async () => {
    const s = setup([CANDIDATE]);
    expect(await run(["models", "set", "anthropic/model-a", "--input", "-1"], s.deps)).toBe(2);
    expect(await run(["models", "set", "anthropic/model-a", "--input", "three"], s.deps)).toBe(2);
  });

  test("abilities: lists, none, limits and label", async () => {
    const s = setup([CANDIDATE]);
    expect(
      await run(
        [
          "models",
          "set",
          "anthropic/model-a",
          "--effort-levels",
          "low,high",
          "--thinking-types",
          "none",
          "--context-window",
          "100000",
          "--max-output",
          "8000",
          "--label",
          "Renamed",
        ],
        s.deps,
      ),
    ).toBe(0);
    expect(s.model("model-a")).toMatchObject({
      effortLevels: ["low", "high"],
      thinkingTypes: [],
      contextWindow: 100000,
      maxOutput: 8000,
      label: "Renamed",
    });
    expect(
      await run(["models", "set", "anthropic/model-a", "--effort-levels", "turbo"], s.deps),
    ).toBe(2);
    expect(await run(["models", "set", "anthropic/model-a", "--max-output", "1.5"], s.deps)).toBe(
      2,
    );
  });
});

describe("enable, disable, default", () => {
  test("enable needs the four prices, the context window and the output limit", async () => {
    const s = setup([CANDIDATE]);
    expect(await run(["models", "enable", "anthropic/model-a"], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain("price.input");
    expect(s.model("model-a")?.status).toBe("candidate");
    expect(await run(["models", "set", "anthropic/model-a", ...PRICES], s.deps)).toBe(0);
    expect(await run(["models", "enable", "anthropic/model-a"], s.deps)).toBe(0);
    expect(s.model("model-a")?.status).toBe("active");
  });

  test("enable refuses a retired model", async () => {
    const s = setup([{ ...ACTIVE, status: "retired" }]);
    expect(await run(["models", "enable", "anthropic/model-b"], s.deps)).toBe(1);
    expect(s.model("model-b")?.status).toBe("retired");
  });

  test("default needs an active model and lists the active ones otherwise", async () => {
    const s = setup([CANDIDATE, ACTIVE]);
    expect(await run(["models", "default", "anthropic/model-a"], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain("anthropic/model-b");
    expect(await run(["models", "default", "anthropic/model-b"], s.deps)).toBe(0);
    expect(s.model("model-b")?.default).toBe(true);
  });

  test("default moves from one model to another of the same provider", async () => {
    const s = setup([
      { ...ACTIVE, default: true },
      { ...ACTIVE, id: "model-c" },
    ]);
    expect(await run(["models", "default", "anthropic/model-c"], s.deps)).toBe(0);
    expect(s.model("model-b")?.default).toBeUndefined();
    expect(s.model("model-c")?.default).toBe(true);
  });

  test("disable sets disabled and drops default", async () => {
    const s = setup([{ ...ACTIVE, default: true }]);
    expect(await run(["models", "disable", "anthropic/model-b"], s.deps)).toBe(0);
    expect(s.model("model-b")?.status).toBe("disabled");
    expect(s.model("model-b")?.default).toBeUndefined();
  });
});

describe("tars models confirm-prices", () => {
  test("yes on the terminal dates the active prices today", async () => {
    const s = setup([ACTIVE, CANDIDATE], { answers: ["yes"] });
    expect(await run(["models", "confirm-prices"], s.deps)).toBe(0);
    expect(s.model("model-b")?.pricedAt).toBe("2026-11-19");
    expect(s.model("model-a")?.pricedAt).toBeUndefined();
  });

  test("a price changed after it was shown is not dated, and the command says which", async () => {
    const other = { ...ACTIVE, id: "model-c" };
    const s = setup([ACTIVE, other], {
      answers: [
        async () => {
          expect(await run(["models", "set", "anthropic/model-c", "--input", "4"], s.deps)).toBe(0);
          return "yes";
        },
      ],
    });
    expect(await run(["models", "confirm-prices"], s.deps)).toBe(1);
    expect(s.model("model-b")?.pricedAt).toBe("2026-11-19");
    expect(s.model("model-c")).toMatchObject({ pricedAt: "2026-11-01", price: { input: 4 } });
    expect(s.deps.io.stdout.join("\n")).toContain("confirmed 1 anthropic prices");
    expect(s.deps.io.stderr.join("\n")).toContain("anthropic/model-c");
  });

  test("anything else leaves the dates alone", async () => {
    const s = setup([ACTIVE], { answers: ["no"] });
    expect(await run(["models", "confirm-prices"], s.deps)).toBe(1);
    expect(s.model("model-b")?.pricedAt).toBe("2026-11-01");
  });
});

describe("tars models refresh", () => {
  test("adds new models as candidates, retires missing ones, keeps prices", async () => {
    const s = setup([{ ...ACTIVE, default: true }], {
      listed: [{ id: "model-new", label: "New", lifecycle: "active", contextWindow: 100000 }],
    });
    expect(await run(["models", "refresh"], s.deps)).toBe(0);
    expect(s.keys).toEqual(["sk-test"]);
    expect(s.model("model-new")).toMatchObject({ status: "candidate", firstSeen: "2026-11-19" });
    expect(s.model("model-b")).toMatchObject({ status: "retired", price: ACTIVE.price });
    const out = s.deps.io.stdout.join("\n");
    expect(out).toContain("added      anthropic/model-new (candidate)");
    expect(out).toContain("retired    anthropic/model-b");
    expect(s.deps.io.stderr.join("\n")).toContain("現在沒有預設模型");
  });

  test("a models set made while the list is fetched is kept", async () => {
    const s = setup([ACTIVE], {
      listed: async () => {
        expect(await run(["models", "set", "anthropic/model-b", "--output", "20"], s.deps)).toBe(0);
        return [
          { id: "model-b", label: "B" },
          { id: "model-new", label: "New" },
        ];
      },
    });
    expect(await run(["models", "refresh"], s.deps)).toBe(0);
    expect(s.model("model-b")?.price?.output).toBe(20);
    expect(s.model("model-new")?.status).toBe("candidate");
  });

  test("a missing models.json starts empty", async () => {
    const s = setup(undefined, { listed: [{ id: "m", label: "M" }] });
    expect(await run(["models", "refresh"], s.deps)).toBe(0);
    expect(s.read().models).toHaveLength(1);
  });

  test("deprecated models are a warning with the date", async () => {
    const s = setup([ACTIVE], {
      listed: [{ id: "model-b", label: "B", lifecycle: "deprecated", retiresAt: "2027-02-01" }],
    });
    expect(await run(["models", "refresh"], s.deps)).toBe(0);
    expect(s.deps.io.stderr.join("\n")).toContain("2027-02-01");
    expect(s.model("model-b")?.status).toBe("active");
  });

  test("without a key it says how to set one", async () => {
    const s = setup([]);
    await s.secrets.delete("llm:anthropic");
    expect(await run(["models", "refresh"], s.deps)).toBe(1);
    expect(s.deps.io.stderr.join("\n")).toContain("tars llm key set anthropic");
  });

  test("a provider error is exit 1 and nothing is written", async () => {
    const s = setup([ACTIVE], {
      listed: new ProviderError("auth", {
        status: 401,
        receivedStart: false,
        receivedContent: false,
      }),
    });
    expect(await run(["models", "refresh"], s.deps)).toBe(1);
    expect(s.model("model-b")?.status).toBe("active");
  });
});

describe("tars models refresh against the fake API", () => {
  let fake: FakeAnthropic;
  const saved = { ...process.env };
  beforeAll(() => {
    fake = startFakeAnthropic();
  });
  afterAll(async () => {
    Object.assign(process.env, saved);
    await fake.stop();
  });

  test("the real adapter reaches the fake through TARS_E2E_ANTHROPIC_BASE_URL", async () => {
    fake.models = [
      {
        id: "real-a",
        display_name: "Real A",
        max_input_tokens: 200000,
        max_tokens: 64000,
        capabilities: capabilities(["low", "high"]),
      },
    ];
    const s = setup([], { env: { TARS_E2E_ANTHROPIC_BASE_URL: fake.url } });
    expect(await run(["models", "refresh"], { ...s.deps, adapterFor })).toBe(0);
    expect(s.model("real-a")).toMatchObject({
      status: "candidate",
      label: "Real A",
      effortLevels: ["low", "high"],
      contextWindow: 200000,
    });
  });

  test("a bad TARS_E2E_ANTHROPIC_BASE_URL is exit 1", async () => {
    const s = setup([], { env: { TARS_E2E_ANTHROPIC_BASE_URL: "http://127.0.0.1:80@x" } });
    expect(await run(["models", "refresh"], { ...s.deps, adapterFor })).toBe(1);
  });
});

describe("tars models list", () => {
  test("--json adds the price age and state to each entry; it works in a session", async () => {
    const stale = { ...ACTIVE, id: "model-old", pricedAt: "2026-09-01" };
    const s = setup([CANDIDATE, ACTIVE, stale], { session: true });
    expect(await run(["models", "list", "--json"], s.deps)).toBe(0);
    const { models } = JSON.parse(s.deps.io.stdout.join("\n"));
    expect(models).toEqual([
      { ...CANDIDATE, priceAgeDays: null, priceState: "missing" },
      { ...ACTIVE, priceAgeDays: 18, priceState: "ok" },
      { ...stale, priceAgeDays: 79, priceState: "stale" },
    ]);
  });

  test("text output is one line per model with its state", async () => {
    const s = setup([
      { ...ACTIVE, default: true },
      { ...ACTIVE, id: "ancient", pricedAt: "2026-01-01" },
    ]);
    expect(await run(["models", "list"], s.deps)).toBe(0);
    expect(s.deps.io.stdout).toHaveLength(2);
    expect(s.deps.io.stdout[0]).toContain("default");
    expect(s.deps.io.stdout[0]?.endsWith("ok")).toBe(true);
    expect(s.deps.io.stdout[1]?.endsWith("refused")).toBe(true);
  });

  test("the price-age lines come from config.toml", async () => {
    const s = setup([ACTIVE]);
    mkdirSync(s.paths.config, { recursive: true });
    writeFileSync(s.paths.configFile, "[limits]\nprice_warn_days = 10\n");
    expect(await run(["models", "list", "--json"], s.deps)).toBe(0);
    expect(JSON.parse(s.deps.io.stdout.join("\n")).models[0].priceState).toBe("stale");
  });
});

describe("Gemini and OpenRouter lists", () => {
  let gemini: FakeCompat;
  let openrouter: FakeCompat;
  beforeAll(() => {
    gemini = startFakeCompat("gemini");
    openrouter = startFakeCompat("openrouter");
  });
  afterAll(async () => {
    await gemini.stop();
    await openrouter.stop();
  });

  /** The real adapters, pointed at the two fakes. */
  function compat(models: ModelEntry[]) {
    const home = tempHome();
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, "cfg"),
      TARS_DATA_DIR: join(home, "data"),
      [E2E_BASE_URL_VARS.gemini]: gemini.url,
      [E2E_BASE_URL_VARS.openrouter]: openrouter.url,
    };
    const paths = resolvePaths(env);
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(paths.modelsFile, JSON.stringify({ version: 1, models }));
    const deps = testDeps({
      env,
      secrets: fakeSecrets({ "llm:gemini": "gm-test", "llm:openrouter": "or-test" }),
      adapterFor,
    });
    const raw = () => readFileSync(paths.modelsFile, "utf8");
    const model = (provider: string, id: string) =>
      (JSON.parse(raw()) as Catalog).models.find((m) => m.provider === provider && m.id === id);
    return { deps, raw, model };
  }
  const err = (d: { io: { stderr: string[] } }) => d.io.stderr.join("\n");
  const out = (d: { io: { stdout: string[] } }) => d.io.stdout.join("\n");

  const upstream = (id: string, more: Record<string, unknown> = {}) => ({
    id,
    name: `Name of ${id}`,
    context_length: 100000,
    top_provider: { max_completion_tokens: 8000 },
    supported_parameters: ["reasoning"],
    pricing: { prompt: "0.000002", completion: "0.000008" },
    ...more,
  });
  const listedEntry = (provider: "gemini" | "openrouter", id: string): ModelEntry => ({
    provider,
    id,
    label: id,
    status: "candidate",
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-01",
  });
  const refresh = (...more: string[]) => ["models", "refresh", "--provider", "openrouter", ...more];

  describe("OpenRouter", () => {
    test("no options: only models already listed are updated; the rest are counted", async () => {
      openrouter.models = [upstream("v/a"), upstream("v/b"), upstream("v/c")];
      const s = compat([listedEntry("openrouter", "v/a")]);
      expect(await run(refresh(), s.deps)).toBe(0);
      expect(s.model("openrouter", "v/a")).toMatchObject({
        label: "Name of v/a",
        price: { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 },
        priceSource: "openrouter",
        pricedAt: "2026-11-19",
      });
      expect(s.model("openrouter", "v/b")).toBeUndefined();
      expect(out(s.deps)).toContain("上游另有 2 個模型不在清單上，用 --find 找、--add 加");
    });

    test("--find prints matches by id or name and writes nothing", async () => {
      openrouter.models = [upstream("v/alpha"), upstream("v/beta", { name: "Gamma Pro" })];
      const s = compat([]);
      const before = s.raw();
      expect(await run(refresh("--find", "gamma"), s.deps)).toBe(0);
      expect(s.deps.io.stdout).toEqual(["v/beta\tGamma Pro"]);
      expect(s.raw()).toBe(before);
    });

    test("--add writes a candidate with its prices; a missing output limit is named", async () => {
      openrouter.models = [upstream("v/a"), upstream("v/c", { top_provider: {} })];
      const s = compat([]);
      expect(await run(refresh("--add", "v/a", "--add", "v/c"), s.deps)).toBe(0);
      expect(s.model("openrouter", "v/a")).toMatchObject({
        status: "candidate",
        contextWindow: 100000,
        maxOutput: 8000,
        price: { input: 2, output: 8 },
        priceSource: "openrouter",
      });
      expect(err(s.deps)).toContain(
        "openrouter/v/c 缺 max-output；執行 tars models set openrouter/v/c --max-output <n>",
      );
      expect(err(s.deps)).not.toContain("openrouter/v/a 缺");
      expect(err(s.deps)).toContain("openrouter/v/a 能關掉推理的話，加 --thinking-types disabled");
    });

    test("--add of an id not upstream is an error and writes nothing", async () => {
      openrouter.models = [upstream("v/a")];
      const s = compat([]);
      const before = s.raw();
      expect(await run(refresh("--add", "v/nope"), s.deps)).toBe(1);
      expect(err(s.deps)).toContain("上游清單沒有 v/nope");
      expect(s.raw()).toBe(before);
    });

    test("a list refresh wrote is read back, and its prices are not refused", async () => {
      openrouter.models = [upstream("v/a")];
      const s = compat([]);
      expect(await run(refresh("--add", "v/a"), s.deps)).toBe(0);
      expect(await run(["models", "list", "--json"], s.deps)).toBe(0);
      const { models } = JSON.parse(s.deps.io.stdout.at(-1) as string);
      expect(models[0]).toMatchObject({ priceSource: "openrouter", priceState: "ok" });
    });

    test("a model gone upstream becomes retired (acceptance 3, first half)", async () => {
      openrouter.models = [upstream("v/a")];
      const s = compat([listedEntry("openrouter", "v/a"), listedEntry("openrouter", "v/gone")]);
      expect(await run(refresh(), s.deps)).toBe(0);
      expect(s.model("openrouter", "v/gone")?.status).toBe("retired");
      expect(s.model("openrouter", "v/a")?.status).toBe("candidate");
    });

    test("effortLevels the owner set survive a refresh", async () => {
      openrouter.models = [upstream("v/a")];
      const s = compat([
        { ...listedEntry("openrouter", "v/a"), effortLevels: ["low", "medium", "high", "xhigh"] },
      ]);
      expect(await run(refresh(), s.deps)).toBe(0);
      expect(s.model("openrouter", "v/a")?.effortLevels).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
    });

    test.each([
      [["models", "refresh", "--find", "x"]],
      [["models", "refresh", "--provider", "gemini", "--add", "x"]],
      [["models", "refresh", "--provider", "openrouter", "--find", "x", "--add", "y"]],
    ])("%p is a usage error", async (args) => {
      const s = compat([]);
      expect(await run(args, s.deps)).toBe(2);
    });
  });

  describe("Gemini", () => {
    test("refresh writes candidates with only an id and a name", async () => {
      gemini.models = [
        { id: "models/gem-a", object: "model", owned_by: "google", display_name: "Gem A" },
        { id: "gem-b", object: "model", owned_by: "google" },
      ];
      const s = compat([]);
      expect(await run(["models", "refresh", "--provider", "gemini"], s.deps)).toBe(0);
      const a = s.model("gemini", "gem-a");
      expect(a).toMatchObject({ label: "Gem A", status: "candidate" });
      expect(a?.price).toBeUndefined();
      expect(a?.contextWindow).toBeUndefined();
      expect(s.model("gemini", "gem-b")?.label).toBe("gem-b");
    });

    test("a model gone upstream becomes retired", async () => {
      gemini.models = [{ id: "models/gem-a", object: "model", owned_by: "google" }];
      const s = compat([listedEntry("gemini", "gem-a"), listedEntry("gemini", "gem-old")]);
      expect(await run(["models", "refresh", "--provider", "gemini"], s.deps)).toBe(0);
      expect(s.model("gemini", "gem-old")?.status).toBe("retired");
    });

    test("enable only once set has filled it in", async () => {
      const s = compat([listedEntry("gemini", "gem-a")]);
      expect(await run(["models", "enable", "gemini/gem-a"], s.deps)).toBe(1);
      const set = [
        "models",
        "set",
        "gemini/gem-a",
        ...PRICES,
        "--context-window",
        "100000",
        "--max-output",
        "8000",
        "--effort-levels",
        "low,medium,high",
        "--thinking-types",
        "disabled",
      ];
      expect(await run(set, s.deps)).toBe(0);
      expect(await run(["models", "enable", "gemini/gem-a"], s.deps)).toBe(0);
      expect(s.model("gemini", "gem-a")?.status).toBe("active");
    });
  });

  test("--effort-levels max on a Gemini model is refused; xhigh on OpenRouter is taken", async () => {
    const s = compat([listedEntry("gemini", "gem-a"), listedEntry("openrouter", "v/a")]);
    const before = s.raw();
    expect(await run(["models", "set", "gemini/gem-a", "--effort-levels", "low,max"], s.deps)).toBe(
      2,
    );
    expect(err(s.deps)).toContain("gemini 的模型只接受 --effort-levels low,medium,high");
    expect(s.raw()).toBe(before);
    expect(
      await run(["models", "set", "openrouter/v/a", "--effort-levels", "low,xhigh"], s.deps),
    ).toBe(0);
    expect(s.model("openrouter", "v/a")?.effortLevels).toEqual(["low", "xhigh"]);
  });
});
