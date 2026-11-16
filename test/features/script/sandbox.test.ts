import { describe, expect, test } from "bun:test";
import { openAsk } from "../../../src/features/script/sandbox.ts";

describe('domains "*"', () => {
  test.each(["example.com", "api.push.example.net", "xn--fiq228c.example"])(
    "the name %s is left to the proxy's address checks",
    async (host) => {
      expect(await openAsk({ host })).toBe(true);
    },
  );

  test.each([
    "8.8.8.8",
    "127.0.0.2",
    "0.0.0.0",
    "127.1",
    "2130706433",
    "0x7f.1",
    "::1",
    "[::1]",
    "::ffff:10.0.0.1",
  ])("the IP literal %s is refused", async (host) => {
    expect(await openAsk({ host })).toMatchObject({ allow: false });
  });
});
