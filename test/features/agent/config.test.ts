import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import { resolvePaths } from "../../../src/core/paths.ts";
import {
  CONFIG_TEMPLATE,
  DEFAULT_CHAT,
  DEFAULT_LIMITS,
  DEFAULT_WIKI,
  loadConfig,
} from "../../../src/features/agent/config.ts";
import { tempHome } from "../../helpers.ts";

const PROVIDER = `[providers.anthropic]
enabled = true
quota_usd = 100
period = "utc-month"
stop_ratio = 0.95
warn_ratio = 0.80
daily_cap_usd = 10
`;

function pathsWith(text: string | undefined) {
  const home = tempHome();
  const paths = resolvePaths({
    HOME: home,
    TARS_DATA_DIR: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "cfg"),
  });
  if (text !== undefined) {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(paths.configFile, text);
  }
  return paths;
}

async function problems(text: string): Promise<string> {
  try {
    await loadConfig(pathsWith(text));
  } catch (err) {
    expect(err).toBeInstanceOf(TarsError);
    expect((err as TarsError).exitCode).toBe(1);
    return (err as Error).message;
  }
  throw new Error("expected loadConfig to fail");
}

describe("loadConfig", () => {
  test("a missing file points at tars config init", async () => {
    await expect(loadConfig(pathsWith(undefined))).rejects.toThrow("tars config init");
  });

  test("the template passes and equals the defaults", async () => {
    const { config, warnings } = await loadConfig(pathsWith(CONFIG_TEMPLATE));
    expect(warnings).toEqual([]);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.chat).toEqual(DEFAULT_CHAT);
    expect(config.wiki).toEqual(DEFAULT_WIKI);
    expect(config.providers.anthropic).toEqual({
      enabled: true,
      quota_usd: 100,
      period: "utc-month",
      stop_ratio: 0.95,
      warn_ratio: 0.8,
      daily_cap_usd: 10,
      prior_spend_usd: 0,
    });
  });

  test("[limits] and [chat] may be left out entirely", async () => {
    const { config } = await loadConfig(pathsWith(PROVIDER));
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.chat.effort).toBe("medium");
  });

  test("a key left out of [limits] takes its default", async () => {
    const { config } = await loadConfig(pathsWith(`${PROVIDER}[limits]\nturn_cap_usd = 2\n`));
    expect(config.limits).toEqual({ ...DEFAULT_LIMITS, turn_cap_usd: 2 });
  });

  test("invalid TOML is an error", async () => {
    expect(await problems("[limits\n")).toContain("not valid TOML");
  });

  test("an unknown section or key is an error", async () => {
    expect(await problems(`${PROVIDER}[extra]\nx = 1\n`)).toContain("unknown section [extra]");
    expect(await problems(`${PROVIDER}[limits]\nturn_cap = 1\n`)).toContain(
      "[limits] has unknown key turn_cap",
    );
    expect(await problems(`${PROVIDER}nickname = "x"\n`)).toContain("unknown key nickname");
  });

  test("a provider other than anthropic is a warning and is ignored", async () => {
    const { config, warnings } = await loadConfig(
      pathsWith(`${PROVIDER}[providers.gemini]\nenabled = "whatever"\n`),
    );
    expect(warnings.join("\n")).toContain("[providers.gemini]");
    expect(config.providers.gemini).toBeUndefined();
  });

  const providerWith = (key: string, value: string) =>
    PROVIDER.replace(new RegExp(`^${key} = .*$`, "m"), `${key} = ${value}`);

  test.each([
    ["quota_usd", "0"],
    ["quota_usd", "-1"],
    ["quota_usd", "inf"],
    ["daily_cap_usd", "0"],
    ["stop_ratio", "0"],
    ["stop_ratio", "1.5"],
    ["warn_ratio", "0"],
    ["period", '"weekly"'],
    ["enabled", '"yes"'],
  ])("[providers.anthropic] %s = %s is an error", async (key, value) => {
    expect(await problems(providerWith(key, value))).toContain(key);
  });

  test("prior_spend_usd may be 0 but not negative", async () => {
    await loadConfig(pathsWith(`${PROVIDER}prior_spend_usd = 0\n`));
    expect(await problems(`${PROVIDER}prior_spend_usd = -1\n`)).toContain("prior_spend_usd");
  });

  test("warn_ratio above stop_ratio is an error", async () => {
    expect(await problems(providerWith("warn_ratio", "0.99"))).toContain("warn_ratio ≤ stop_ratio");
  });

  test("a required provider key left out is an error", async () => {
    expect(await problems(PROVIDER.replace(/^quota_usd.*\n/m, ""))).toContain("quota_usd");
  });

  const limit = (body: string) => `${PROVIDER}[limits]\n${body}\n`;

  test.each([
    ["turn_cap_usd = 0"],
    ["turn_cap_usd = -0.5"],
    ["auto_compact = 1"],
    ["compact_keep_recent_tokens = 999"],
    ["compact_keep_recent_tokens = 200001"],
    ["compact_keep_recent_tokens = 1500.5"],
    ["compact_max_output_tokens = 1023"],
    ["compact_max_output_tokens = 32001"],
    ["max_requests_per_turn = 0"],
    ["max_requests_per_turn = 101"],
    ["max_output_tokens = 1023"],
    ["max_output_tokens = 200001"],
    ["max_input_tokens = 9999"],
    ["tool_result_bytes = 1023"],
    ["tool_result_bytes = 1048577"],
    ["approval_timeout_s = 9"],
    ["approval_timeout_s = 86401"],
    ["price_warn_days = 0"],
    ["context_warn_ratio = 0"],
    ["context_stop_ratio = 1.1"],
    ['cache_ttl = "10m"'],
  ])("[limits] %s is an error", async (line) => {
    expect(await problems(limit(line))).toContain(line.split(" ")[0] as string);
  });

  test.each([
    ["compact_keep_recent_tokens = 1000"],
    ["compact_keep_recent_tokens = 200000"],
    ["compact_max_output_tokens = 1024"],
    ["compact_max_output_tokens = 32000"],
    ["max_requests_per_turn = 100"],
    ["max_output_tokens = 200000"],
    ["max_input_tokens = 10000"],
    ["tool_result_bytes = 1048576"],
    ["approval_timeout_s = 10"],
    ["context_stop_ratio = 1"],
    ['cache_ttl = "1h"'],
    ["auto_compact = false"],
  ])("[limits] %s is accepted", async (line) => {
    await loadConfig(pathsWith(limit(line)));
  });

  test("price_warn_days above price_refuse_days is an error", async () => {
    expect(await problems(limit("price_warn_days = 91\nprice_refuse_days = 90"))).toContain(
      "price_warn_days ≤ price_refuse_days",
    );
  });

  test("the context ratios must be in order", async () => {
    expect(await problems(limit("context_warn_ratio = 0.8"))).toContain(
      "context_warn_ratio ≤ context_compact_ratio ≤ context_stop_ratio",
    );
    expect(await problems(limit("context_compact_ratio = 0.9"))).toContain(
      "context_compact_ratio ≤ context_stop_ratio",
    );
  });

  test("[chat] effort must be one of the five levels", async () => {
    expect(await problems(`${PROVIDER}[chat]\neffort = "extreme"\n`)).toContain("effort");
    const { config } = await loadConfig(pathsWith(`${PROVIDER}[chat]\neffort = "xhigh"\n`));
    expect(config.chat.effort).toBe("xhigh");
  });

  test("[wiki] may be left out entirely", async () => {
    const { config } = await loadConfig(pathsWith(PROVIDER));
    expect(config.wiki).toEqual({ daily_cap_usd: 1, monthly_cap_usd: 10, model: "" });
  });

  test("[wiki] caps are numbers above 0, the daily one at most the monthly one", async () => {
    expect(await problems(`${PROVIDER}[wiki]\ndaily_cap_usd = 0\n`)).toContain(
      "[wiki] daily_cap_usd must be a number above 0",
    );
    expect(await problems(`${PROVIDER}[wiki]\ndaily_cap_usd = 11\n`)).toContain(
      "[wiki] needs daily_cap_usd ≤ monthly_cap_usd",
    );
  });

  test("[wiki] model is empty or <provider>/<id> with a known provider", async () => {
    for (const bad of ['"model-a"', '"acme/x"', '"anthropic/"', '"/x"', "3"])
      expect(await problems(`${PROVIDER}[wiki]\nmodel = ${bad}\n`)).toContain("[wiki] model");
    const { config } = await loadConfig(pathsWith(`${PROVIDER}[wiki]\nmodel = "gemini/x"\n`));
    expect(config.wiki.model).toBe("gemini/x");
  });

  test("[wiki] with an unknown key is an error", async () => {
    expect(await problems(`${PROVIDER}[wiki]\nbatch = 3\n`)).toContain(
      "[wiki] has unknown key batch",
    );
  });

  test("every problem is reported at once", async () => {
    const message = await problems(
      `${providerWith("quota_usd", "0")}[limits]\nturn_cap_usd = 0\nmax_requests_per_turn = 0\n[chat]\neffort = "x"\n`,
    );
    for (const key of ["quota_usd", "turn_cap_usd", "max_requests_per_turn", "effort"])
      expect(message).toContain(key);
  });
});
