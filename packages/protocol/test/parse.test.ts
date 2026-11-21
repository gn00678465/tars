import { describe, expect, test } from "bun:test";
import {
  ARGV_ITEMS,
  checkClient,
  FRAME_BYTES,
  MESSAGE_BYTES,
  parseClient,
  parseFrame,
  parseRelayFrame,
  parseServer,
  SNAPSHOT_ITEMS,
  TEXT_BYTES,
  type Parsed,
} from "../src/index.ts";
import { CLIENT, CONN, ID, ITEMS, msg, SERVER } from "./fixtures.ts";

const reason = (r: Parsed<unknown>) => (r.ok ? "ok" : r.reason);
const submit = (text: string) => JSON.stringify(msg("turn.submit", { requestId: ID, text }));

describe("limits", () => {
  test("over MESSAGE_BYTES is refused before it is parsed", () => {
    const huge = "x".repeat(MESSAGE_BYTES + 1);
    // Not JSON at all: refused for its size, not for its syntax.
    expect(reason(parseClient(huge))).toBe("too_large");
    expect(reason(parseServer(huge))).toBe("too_large");
    // Multi-byte text that is short in UTF-16 units but long in bytes.
    expect(reason(parseClient("中".repeat(MESSAGE_BYTES / 3 + 1)))).toBe("too_large");
  });

  test("a frame may carry a message at MESSAGE_BYTES; over FRAME_BYTES is refused", () => {
    const pad = MESSAGE_BYTES - JSON.stringify(msg("hello", {}, { re: "" })).length;
    const m = msg("hello", {}, { re: "" });
    const atLimit = JSON.stringify({ t: "msg", conn: CONN, m: { ...m, pad: "x".repeat(pad) } });
    expect(atLimit.length).toBeGreaterThan(MESSAGE_BYTES);
    expect(reason(parseFrame(atLimit))).toBe("ok");
    expect(reason(parseFrame("x".repeat(FRAME_BYTES + 1)))).toBe("too_large");
    expect(reason(parseRelayFrame("x".repeat(FRAME_BYTES + 1)))).toBe("too_large");
  });

  test("turn.submit's text: TEXT_BYTES in bytes, not characters", () => {
    expect(reason(parseClient(submit("x".repeat(TEXT_BYTES))))).toBe("ok");
    expect(reason(parseClient(submit("x".repeat(TEXT_BYTES + 1))))).toBe("bad_message");
    expect(reason(parseClient(submit("中".repeat(TEXT_BYTES / 3 + 1))))).toBe("too_large");
    expect(reason(parseClient(submit("")))).toBe("bad_message");
  });

  test("too many items, too long an argv, too long a string", () => {
    const items = Array.from({ length: SNAPSHOT_ITEMS + 1 }, () => ITEMS.user);
    const snap = SERVER["conv.snapshot"] as { p: Record<string, unknown> };
    expect(reason(parseServer(JSON.stringify({ ...snap, p: { ...snap.p, items } })))).toBe(
      "bad_message",
    );
    const req = SERVER["approval.request"] as { p: { approval: Record<string, unknown> } };
    const withArgv = (argv: string[]) =>
      JSON.stringify({ ...req, p: { approval: { ...req.p.approval, argv } } });
    expect(reason(parseServer(withArgv(Array(ARGV_ITEMS).fill("a"))))).toBe("ok");
    expect(reason(parseServer(withArgv(Array(ARGV_ITEMS + 1).fill("a"))))).toBe("bad_message");
    expect(reason(parseServer(withArgv(["a".repeat(4097)])))).toBe("bad_message");
    expect(reason(parseClient(JSON.stringify({ ...CLIENT.hello, id: "x".repeat(65) })))).toBe(
      "bad_message",
    );
  });
});

describe("not a message", () => {
  test.each([
    ["not JSON", "{nope"],
    ["an array", "[1]"],
    ["a string", '"hello"'],
    ["null", "null"],
    ["a number", "1"],
  ])("%s", (_, raw) => {
    for (const parse of [parseClient, parseServer, parseFrame, parseRelayFrame])
      expect(reason(parse(raw))).toBe("bad_message");
  });

  test("v that is not 1 is a version mismatch, for either side", () => {
    for (const v of [2, 0, "1", undefined]) {
      expect(reason(parseClient(JSON.stringify({ ...CLIENT.hello, v })))).toBe("version");
      expect(reason(parseServer(JSON.stringify({ ...SERVER.ack, v })))).toBe("version");
    }
  });
});

test("no parse function throws, whatever it is given", () => {
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  const deepObject = `{"v":1,"m":${deep.slice(0, 100_000)}`;
  const inputs: unknown[] = [
    "",
    deep,
    deepObject,
    "\u0000",
    '{"__proto__":{"v":1}}',
    '{"v":1,"id":"x","kind":"hello","p":{},"constructor":1}',
    undefined,
    null,
    42,
  ];
  for (const raw of inputs)
    for (const parse of [parseClient, parseServer, parseFrame, parseRelayFrame])
      expect(() => parse(raw as string)).not.toThrow();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(reason(checkClient(cyclic))).toBe("bad_message");
  expect(reason(checkClient(undefined))).toBe("bad_message");
  expect(reason(checkClient(BigInt(1)))).toBe("bad_message");
});

test("checkClient: a frame's m checked like a raw message", () => {
  expect(reason(checkClient(CLIENT.hello))).toBe("ok");
  expect(reason(checkClient({ ...CLIENT.hello, v: 2 }))).toBe("version");
  expect(reason(checkClient({ ...CLIENT.hello, extra: 1 }))).toBe("bad_message");
});
