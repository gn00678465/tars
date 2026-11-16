import { describe, expect, test } from "bun:test";
import { redact, REDACTED, secretNeedles } from "../../../src/features/script/redact.ts";

const KEY = "BARK-KEY-abc+/=123";
const JSON_SECRET = JSON.stringify({ url: "https://push.example.net/base", key: KEY, id: "ab" });

const mask = (secret: string, text: string) => redact(text, secretNeedles(secret));

describe("redact", () => {
  test("a plain secret and its URL, JSON and base64 forms are masked", () => {
    const plain = "fake/value+with-plus";
    for (const form of [
      plain,
      encodeURIComponent(plain),
      Buffer.from(plain).toString("base64"),
      Buffer.from(plain).toString("base64url"),
    ])
      expect(mask(plain, `x ${form} y`)).toBe(`x ${REDACTED} y`);
  });

  test("each field of a JSON secret is masked on its own, and so is the url's host", () => {
    const out = mask(
      JSON_SECRET,
      `key=${KEY} quoted=${encodeURIComponent(KEY)} host=push.example.net whole=${JSON_SECRET}`,
    );
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("push.example.net");
    expect(out).not.toContain(encodeURIComponent(KEY));
  });

  test("short JSON fields stay readable", () => {
    expect(mask(JSON_SECRET, "status ab ok")).toBe("status ab ok");
  });

  test("a longer form is masked whole before a shorter part inside it", () => {
    const out = mask(JSON_SECRET, `url=https://push.example.net/base`);
    expect(out).toBe(`url=${REDACTED}`);
  });
});
