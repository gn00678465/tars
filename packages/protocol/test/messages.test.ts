import { describe, expect, test } from "bun:test";
import {
  parseClient,
  parseFrame,
  parseRelayFrame,
  parseServer,
  type Parsed,
} from "../src/index.ts";
import { CLIENT, ID, REQUIRED_P, SERVER, TO_LOCAL, TO_RELAY } from "./fixtures.ts";

const ok = (r: Parsed<unknown>) => r.ok;
const reason = (r: Parsed<unknown>) => (r.ok ? "ok" : r.reason);
const without = (o: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe.each([
  ["browser", CLIENT, parseClient],
  ["local end", SERVER, parseServer],
] as const)("%s messages", (_, examples, parse) => {
  for (const [kind, example] of Object.entries(examples)) {
    describe(kind, () => {
      const m = example as Record<string, unknown> & { p: Record<string, unknown> };
      test("a valid one passes", () => {
        expect(reason(parse(JSON.stringify(m)))).toBe("ok");
      });
      test("an unknown key is refused, outside or in p", () => {
        expect(reason(parse(JSON.stringify({ ...m, extra: 1 })))).toBe("bad_message");
        expect(reason(parse(JSON.stringify({ ...m, p: { ...m.p, extra: 1 } })))).toBe(
          "bad_message",
        );
      });
      test("a missing required field is refused", () => {
        for (const key of ["id", "kind", "p"])
          expect(ok(parse(JSON.stringify(without(m, key))))).toBe(false);
        const inP = REQUIRED_P[kind];
        if (inP !== undefined && inP in m.p)
          expect(reason(parse(JSON.stringify({ ...m, p: without(m.p, inP) })))).toBe("bad_message");
      });
    });
  }
});

test("conv.open and turn.abort need conv; turn.submit without it opens a new conversation", () => {
  for (const kind of ["conv.open", "turn.abort"] as const) {
    const m = CLIENT[kind] as Record<string, unknown>;
    expect(reason(parseClient(JSON.stringify(without(m, "conv"))))).toBe("bad_message");
  }
  const submit = CLIENT["turn.submit"] as Record<string, unknown>;
  expect(reason(parseClient(JSON.stringify({ ...submit, conv: ID })))).toBe("ok");
});

test("a server kind from a browser, and a browser kind from the local end, are refused", () => {
  expect(reason(parseClient(JSON.stringify(SERVER.ack)))).toBe("bad_message");
  expect(reason(parseServer(JSON.stringify(CLIENT["turn.submit"])))).toBe("bad_message");
});

describe.each([
  ["to the local end", TO_LOCAL, parseFrame],
  ["to the relay", TO_RELAY, parseRelayFrame],
] as const)("frames %s", (_, examples, parse) => {
  for (const [t, example] of Object.entries(examples))
    test(`${t}: valid passes, an unknown key is refused`, () => {
      expect(reason(parse(JSON.stringify(example)))).toBe("ok");
      expect(reason(parse(JSON.stringify({ ...example, extra: 1 })))).toBe("bad_message");
    });
});

test("a conn inside m does not change the frame's conn", () => {
  const conn = "11111111-2222-4333-8444-555555555555";
  const r = parseFrame(
    JSON.stringify({ t: "msg", conn, m: { ...CLIENT.hello, conn: "other", t: "open" } }),
  );
  expect(r.ok && r.value.t === "msg" && r.value.conn).toBe(conn);
});

test('"all" is not a connection: a frame to it is refused', () => {
  expect(reason(parseRelayFrame(JSON.stringify({ ...TO_RELAY.msg, to: "all" })))).toBe(
    "bad_message",
  );
  expect(reason(parseRelayFrame(JSON.stringify({ t: "drop", conn: "all", code: 4003 })))).toBe(
    "bad_message",
  );
});
