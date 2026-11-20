import { describe, expect, test } from "bun:test";
import { TarsError } from "../../../src/core/exit.ts";
import {
  E2E_BASE_URL_VARS,
  loopbackUrl,
  resolveAnthropicBaseUrl,
} from "../../../src/features/agent/provider.ts";

const VAR = "TARS_E2E_ANTHROPIC_BASE_URL";

test("unset or empty means the real API", () => {
  expect(resolveAnthropicBaseUrl({})).toBe("https://api.anthropic.com");
  expect(resolveAnthropicBaseUrl({ [VAR]: "" })).toBe("https://api.anthropic.com");
});

test("a loopback http address with a port is used as is", () => {
  expect(resolveAnthropicBaseUrl({ [VAR]: "http://127.0.0.1:8080" })).toBe("http://127.0.0.1:8080");
  expect(resolveAnthropicBaseUrl({ [VAR]: "http://127.0.0.1:65535" })).toBe(
    "http://127.0.0.1:65535",
  );
});

test.each([
  "http://127.0.0.1:80@x",
  "http://127.0.0.1:80@attacker.example",
  "https://127.0.0.1:1",
  "http://127.0.0.1:0",
  "http://127.0.0.1:65536",
  "http://127.0.0.1:8080/v1",
  "http://127.0.0.1:8080/",
  "http://127.0.0.1:8080?x=1",
  "http://127.0.0.1:8080#x",
  "http://localhost:8080",
  "http://127.0.0.1",
  "http://user:pw@127.0.0.1:8080",
])("%s is refused with exit 1", (value) => {
  try {
    resolveAnthropicBaseUrl({ [VAR]: value });
    throw new Error("expected refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(TarsError);
    expect((err as TarsError).exitCode).toBe(1);
  }
});

describe("loopbackUrl", () => {
  test("unset or empty is undefined; a loopback address with a port is returned", () => {
    expect(loopbackUrl("X", undefined, "http")).toBeUndefined();
    expect(loopbackUrl("X", "", "http")).toBeUndefined();
    expect(loopbackUrl("X", "http://127.0.0.1:8080", "http")).toBe("http://127.0.0.1:8080");
    expect(loopbackUrl("X", "ws://127.0.0.1:8080", "ws")).toBe("ws://127.0.0.1:8080");
  });

  test.each([
    "http://localhost:8080",
    "http://0.0.0.0:8080",
    "http://203.0.113.7:8080",
    "http://127.0.0.1",
    "http://127.0.0.1:8080/v1",
    "http://user:pw@127.0.0.1:8080",
    "https://127.0.0.1:8080",
    "ws://127.0.0.1:8080",
  ])("%s is refused for http, naming the variable", (value) => {
    expect(() => loopbackUrl("TARS_E2E_X", value, "http")).toThrow(
      "TARS_E2E_X must be http://127.0.0.1:<port>",
    );
  });

  test.each(Object.entries(E2E_BASE_URL_VARS))("%s goes through it", (_provider, name) => {
    expect(loopbackUrl(name, "http://127.0.0.1:9", "http")).toBe("http://127.0.0.1:9");
    expect(() => loopbackUrl(name, "http://example.com:9", "http")).toThrow(name);
  });
});
