import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readStatus,
  writeStatus,
  type ServeStatus,
} from "../../../src/features/serve/status-file.ts";
import { tempHome } from "../../helpers.ts";

const STATUS: ServeStatus = {
  pid: 42,
  startedAt: 1,
  updatedAt: 2,
  version: "0.0.1",
  link: { state: "replaced", since: 1, replacedSince: 1, replacedNotified: false },
  browsers: 0,
  pendingApprovals: 1,
  turnRunning: false,
  accessKeys: "ok",
  notify: "not_configured",
};

describe("serve.json", () => {
  test("written whole and read back", async () => {
    const dir = join(tempHome(), "agent");
    mkdirSync(dir);
    const file = join(dir, "serve.json");
    await writeStatus(file, STATUS);
    expect(await readStatus(file)).toEqual(STATUS);
  });

  test("missing, torn or of another shape: undefined", async () => {
    const dir = tempHome();
    expect(await readStatus(join(dir, "none.json"))).toBeUndefined();
    writeFileSync(join(dir, "torn.json"), '{"pid": 4');
    expect(await readStatus(join(dir, "torn.json"))).toBeUndefined();
    writeFileSync(join(dir, "other.json"), '{"pid": 4}');
    expect(await readStatus(join(dir, "other.json"))).toBeUndefined();
  });
});
