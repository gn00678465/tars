import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TarsError } from "../../../src/core/exit.ts";
import { run } from "../../../src/main.ts";
import { scriptedTerminal, tempHome, testDeps } from "../../helpers.ts";

function setup(env: Record<string, string> = {}) {
  const home = tempHome();
  const data = join(home, "data");
  return { scripts: join(data, "scripts"), env: { HOME: home, TARS_DATA_DIR: data, ...env } };
}

describe("tars script approve guards", () => {
  test("inside a tars session it exits 1 without opening the terminal", async () => {
    const { env } = setup({ TARS_IN_SESSION: "1" });
    let opened = 0;
    const deps = testDeps({
      env,
      openTerminal: () => {
        opened++;
        return scriptedTerminal([]);
      },
    });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(opened).toBe(0);
    expect(deps.io.stderr.join("\n")).toContain("outside the tars session");
  });

  test("an empty TARS_IN_SESSION is not a session", async () => {
    const { env } = setup({ TARS_IN_SESSION: "" });
    const terminal = scriptedTerminal([]);
    const deps = testDeps({ env, openTerminal: () => terminal });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).not.toContain("outside the tars session");
  });

  test("without a terminal it exits 1", async () => {
    const { env } = setup();
    const deps = testDeps({
      env,
      openTerminal: () => {
        throw new TarsError("no terminal here");
      },
    });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("no terminal here");
  });

  test("the terminal is closed when the command ends", async () => {
    const { env } = setup();
    const terminal = scriptedTerminal([]);
    const deps = testDeps({ env, openTerminal: () => terminal });
    expect(await run(["script", "approve", "bark-push"], deps)).toBe(1);
    expect(terminal.closed).toBe(true);
  });
});
