import { describe, expect, test } from "bun:test";
import {
  ARGV_ITEMS,
  checkClient,
  FRAME_BYTES,
  EFFORT_LEVELS,
  EFFORT_NAME,
  KEEP_LAST,
  MESSAGE_BYTES,
  MODELS,
  parseClient,
  parseFrame,
  parseRelayFrame,
  parseServer,
  SKILL_TEXT,
  SKILLS,
  skillInvocationText,
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

describe("an approval's tool call", () => {
  test("callId is optional: a card with it and one without both parse", () => {
    const req = SERVER["approval.request"] as { p: { approval: Record<string, unknown> } };
    const withCall = (approval: Record<string, unknown>) =>
      JSON.stringify({ ...req, p: { approval } });
    expect(reason(parseServer(withCall({ ...req.p.approval, callId: ID })))).toBe("ok");
    expect(reason(parseServer(withCall(req.p.approval)))).toBe("ok");
    expect(reason(parseServer(withCall({ ...req.p.approval, callId: "x".repeat(65) })))).toBe(
      "bad_message",
    );
  });
});

describe("status's skills and certificate expiry", () => {
  test("both optional; a description longer than SKILL_TEXT is refused", () => {
    const st = SERVER.status as { p: Record<string, unknown> };
    const withP = (extra: Record<string, unknown>) =>
      JSON.stringify({ ...st, p: { ...st.p, ...extra } });
    const skill = { name: "demo", description: "示範", localOnly: false };
    expect(reason(parseServer(withP({})))).toBe("ok");
    expect(reason(parseServer(withP({ skills: [skill], certExpiresAt: 1 })))).toBe("ok");
    expect(
      reason(
        parseServer(withP({ skills: [{ ...skill, description: "x".repeat(SKILL_TEXT + 1) }] })),
      ),
    ).toBe("bad_message");
    expect(reason(parseServer(withP({ skills: Array(SKILLS + 1).fill(skill) })))).toBe(
      "bad_message",
    );
  });

  test("skillInvocationText is one wording for the terminal and the page", () => {
    expect(skillInvocationText("demo", "")).toBe(
      "請用 skill「demo」處理下面的內容。先用 skill_load 讀它。",
    );
    expect(skillInvocationText("demo", "內容")).toBe(
      "請用 skill「demo」處理下面的內容。先用 skill_load 讀它。\n\n內容",
    );
  });
});

describe("turn.submit's model, from and keepLast; models.result", () => {
  const with_ = (extra: Record<string, unknown>) =>
    JSON.stringify(msg("turn.submit", { requestId: ID, text: "hi", ...extra }));
  const model = { provider: "gemini", id: "g" };

  test("all three optional: a new conversation on a model, a continuation, the last turns only", () => {
    expect(reason(parseClient(with_({})))).toBe("ok");
    expect(reason(parseClient(with_({ model })))).toBe("ok");
    expect(reason(parseClient(with_({ model, from: ID })))).toBe("ok");
    expect(reason(parseClient(with_({ model, from: ID, keepLast: KEEP_LAST })))).toBe("ok");
  });

  test("from without model, keepLast without from, keepLast out of range, a key no one knows", () => {
    expect(reason(parseClient(with_({ from: ID })))).toBe("bad_message");
    expect(reason(parseClient(with_({ model, keepLast: 3 })))).toBe("bad_message");
    for (const keepLast of [0, -1, 1.5, KEEP_LAST + 1])
      expect(reason(parseClient(with_({ model, from: ID, keepLast })))).toBe("bad_message");
    expect(reason(parseClient(with_({ model: { ...model, effort: "high" } })))).toBe("bad_message");
  });

  test("models.result: window and unusable optional; at most MODELS", () => {
    const one = { provider: "anthropic", id: "m", label: "M", isDefault: false };
    const result = (models: unknown[]) => JSON.stringify(msg("models.result", { models }));
    expect(reason(parseServer(result([one])))).toBe("ok");
    expect(reason(parseServer(result([{ ...one, window: 0 }])))).toBe("bad_message");
    expect(reason(parseServer(result(Array(MODELS + 1).fill(one))))).toBe("bad_message");
  });
});

describe("effort: turn.submit's, models.result's levels, a conversation's", () => {
  const submit = (extra: Record<string, unknown>) =>
    JSON.stringify(msg("turn.submit", { requestId: ID, text: "hi", ...extra }));
  const one = { provider: "anthropic", id: "m", label: "M", isDefault: true };
  const result = (extra: Record<string, unknown>) =>
    JSON.stringify(msg("models.result", { models: [{ ...one, ...extra }] }));
  const conv = (extra: Record<string, unknown>) =>
    JSON.stringify(
      msg("conv.list.result", {
        convs: [{ id: ID, title: "t", provider: "anthropic", model: "m", updatedAt: 1, ...extra }],
      }),
    );

  test("turn.submit: on its own, with a conversation, with a new model; a name, not an empty one", () => {
    expect(reason(parseClient(submit({ effort: "high" })))).toBe("ok");
    expect(
      reason(
        parseClient(
          JSON.stringify({
            ...msg("turn.submit", { requestId: ID, text: "hi", effort: "low" }),
            conv: ID,
          }),
        ),
      ),
    ).toBe("ok");
    expect(
      reason(parseClient(submit({ model: { provider: "gemini", id: "g" }, effort: "low" }))),
    ).toBe("ok");
    // A level a newer local end knows is still a message; the local end judges it.
    expect(reason(parseClient(submit({ effort: "ultra" })))).toBe("ok");
    expect(reason(parseClient(submit({ effort: "" })))).toBe("bad_message");
    expect(reason(parseClient(submit({ effort: "x".repeat(EFFORT_NAME + 1) })))).toBe(
      "bad_message",
    );
    expect(reason(parseClient(submit({ effort: 2 })))).toBe("bad_message");
  });

  test("models.result: levels and the default optional, an empty list allowed, at most EFFORT_LEVELS", () => {
    expect(reason(parseServer(result({})))).toBe("ok");
    expect(reason(parseServer(result({ effortLevels: [] })))).toBe("ok");
    expect(
      reason(parseServer(result({ effortLevels: ["low", "max"], defaultEffort: "low" }))),
    ).toBe("ok");
    expect(
      reason(parseServer(result({ effortLevels: Array(EFFORT_LEVELS + 1).fill("low") }))),
    ).toBe("bad_message");
    expect(reason(parseServer(result({ effortLevels: [""] })))).toBe("bad_message");
  });

  test("a conversation's effort is optional", () => {
    expect(reason(parseServer(conv({})))).toBe("ok");
    expect(reason(parseServer(conv({ effort: "medium" })))).toBe("ok");
    expect(reason(parseServer(conv({ effort: 1 })))).toBe("bad_message");
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
