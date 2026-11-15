import { expect, test } from "bun:test";
import { TarsError } from "../../../src/core/exit.ts";
import { launch } from "../../../src/features/session/launch.ts";
import { tempHome } from "../../helpers.ts";

test("runs the planned command in the planned cwd and env, returning its exit code", async () => {
  const cwd = tempHome();
  const code = await launch({
    command: "sh",
    args: ["-c", `[ "$(pwd)" = "${cwd}" ] && [ "$TARS_PROBE" = yes ] && exit 5`],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TARS_PROBE: "yes" },
    cwd,
  });
  expect(code).toBe(5);
});

test("a command that is not on PATH fails with exit 1", async () => {
  const err = await launch({
    command: "tars-no-such-harness",
    args: [],
    env: { PATH: "/nonexistent" },
    cwd: tempHome(),
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TarsError);
  expect((err as TarsError).exitCode).toBe(1);
});
