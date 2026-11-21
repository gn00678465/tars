import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../src/index.ts";

test("S3 speaks version 1", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
