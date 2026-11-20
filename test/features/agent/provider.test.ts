import { expect, test } from "bun:test";
import { TarsError } from "../../../src/core/exit.ts";
import { resolveAnthropicBaseUrl } from "../../../src/features/agent/provider.ts";

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
