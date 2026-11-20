import type { ModelEntry } from "../../../src/features/agent/catalog.ts";
import { CONFIG_TEMPLATE } from "../../../src/features/agent/config.ts";
import { E2E_BASE_URL_VARS } from "../../../src/features/agent/provider.ts";
import { startFakeCompat, type FakeCompat } from "../../fakes/openai-compat.ts";
import { engineHarness, type EngineHarness, type HarnessOptions } from "./engine-fixture.ts";

export const GEMINI_ENTRY: ModelEntry = {
  provider: "gemini",
  id: "gemini-x",
  label: "Gemini X",
  status: "active",
  contextWindow: 100000,
  maxOutput: 8000,
  effortLevels: ["low", "medium", "high"],
  thinkingTypes: ["disabled"],
  price: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 1 },
  priceSource: "manual",
  pricedAt: "2026-11-19",
  firstSeen: "2026-11-19",
  lastSeen: "2026-11-19",
};

/** Like the model P2 measured: it reasons and cannot turn reasoning off. */
export const OPENROUTER_ENTRY: ModelEntry = {
  provider: "openrouter",
  id: "vendor/model-r",
  label: "Model R",
  status: "active",
  contextWindow: 100000,
  maxOutput: 8000,
  effortLevels: ["low", "medium", "high", "xhigh"],
  thinkingTypes: [],
  price: { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 },
  priceSource: "openrouter",
  pricedAt: "2026-11-19",
  firstSeen: "2026-11-19",
  lastSeen: "2026-11-19",
};

/** A config.toml text with gemini and openrouter enabled. */
export const enableCompat = (text: string) =>
  text
    .replace("[providers.gemini]\nenabled = false", "[providers.gemini]\nenabled = true")
    .replace("[providers.openrouter]\nenabled = false", "[providers.openrouter]\nenabled = true");

export const COMPAT_CONFIG = enableCompat(CONFIG_TEMPLATE);

export interface CompatHarness extends EngineHarness {
  readonly gemini: FakeCompat;
  readonly openrouter: FakeCompat;
}

/** The engine harness with both compatible fakes, their keys, models and enabled providers. */
export async function compatHarness(opts: HarnessOptions = {}): Promise<CompatHarness> {
  const gemini = startFakeCompat("gemini");
  const openrouter = startFakeCompat("openrouter");
  const h = await engineHarness({
    config: COMPAT_CONFIG,
    ...opts,
    extraModels: [GEMINI_ENTRY, OPENROUTER_ENTRY, ...(opts.extraModels ?? [])],
    extraEnv: {
      [E2E_BASE_URL_VARS.gemini]: gemini.url,
      [E2E_BASE_URL_VARS.openrouter]: openrouter.url,
      ...opts.extraEnv,
    },
    extraSecrets: { "llm:gemini": "gm-test", "llm:openrouter": "or-test", ...opts.extraSecrets },
  });
  const stop = h.stop;
  return Object.assign(h, {
    gemini,
    openrouter,
    stop: async () => {
      await stop();
      await gemini.stop();
      await openrouter.stop();
    },
  });
}
