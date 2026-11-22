// @vitest-environment node
import type { WireStatus } from "@tars/protocol";
import { expect, test } from "vite-plus/test";
import { providerSpend, spendFigure } from "./StatusBar.tsx";

type Provider = WireStatus["providers"][number];

const p = (extra: Partial<Provider>): Provider => ({
  name: "anthropic",
  spentUsd: 12.4,
  quotaUsd: 100,
  warnUsd: 80,
  stopUsd: 95,
  stopped: false,
  ...extra,
});

test("A3: the period as status says it; 估 unless status says the figure is not an estimate", () => {
  expect(spendFigure(p({ period: "month", estimated: true }))).toBe("本月 12.40 / 100 USD 估");
  expect(spendFigure(p({ period: "cumulative", estimated: false }))).toBe("累計 12.40 / 100 USD");
  // A local end older than both fields.
  expect(spendFigure(p({}))).toBe("本期 12.40 / 100 USD 估");
  const status = { providers: [p({ period: "month", estimated: false })] } as WireStatus;
  expect(providerSpend(status, "anthropic")).toEqual({
    text: "本月 12.40 / 100 USD",
    stopped: false,
  });
});
