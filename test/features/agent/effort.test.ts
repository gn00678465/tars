import { describe, expect, test } from "bun:test";
import { TarsError } from "../../../src/core/exit.ts";
import {
  assertSelectable,
  effectiveEffort,
  parseEffort,
} from "../../../src/features/agent/effort.ts";

describe("effectiveEffort", () => {
  test("a model without effortLevels, or with none, gets no effort and a notice", () => {
    expect(effectiveEffort({}, "medium")).toEqual({
      effort: undefined,
      notice: "effort_unsupported",
    });
    expect(effectiveEffort({ effortLevels: [] }, "medium")).toEqual({
      effort: undefined,
      notice: "effort_unsupported",
    });
  });

  test("a supported level is sent as is", () => {
    expect(effectiveEffort({ effortLevels: ["low", "medium", "high"] }, "medium")).toEqual({
      effort: "medium",
    });
  });

  test("an unsupported level falls to the nearest supported one below", () => {
    expect(effectiveEffort({ effortLevels: ["low", "high"] }, "xhigh")).toEqual({
      effort: "high",
      notice: "effort_clamped",
    });
    expect(effectiveEffort({ effortLevels: ["low", "high"] }, "medium")).toEqual({
      effort: "low",
      notice: "effort_clamped",
    });
  });

  test("with nothing supported below, the lowest supported level is used", () => {
    expect(effectiveEffort({ effortLevels: ["high", "max"] }, "low")).toEqual({
      effort: "high",
      notice: "effort_clamped",
    });
  });
});

describe("assertSelectable", () => {
  test("a supported level passes", () => {
    assertSelectable({ id: "m", effortLevels: ["low", "high"] }, "high");
  });

  test("an unsupported level throws a TarsError listing the choices", () => {
    expect(() => assertSelectable({ id: "m", effortLevels: ["high", "low"] }, "max")).toThrow(
      TarsError,
    );
    expect(() => assertSelectable({ id: "m", effortLevels: ["high", "low"] }, "max")).toThrow(
      "low, high",
    );
  });

  test("a model without effort says it has no levels", () => {
    expect(() => assertSelectable({ id: "m" }, "low")).toThrow("不支援推理強度");
  });
});

test("parseEffort accepts the five levels only", () => {
  expect(parseEffort("xhigh")).toBe("xhigh");
  expect(parseEffort("extreme")).toBeUndefined();
});
