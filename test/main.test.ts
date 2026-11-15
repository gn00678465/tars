import { expect, test } from "bun:test";
import { run } from "../src/main.ts";

test("unknown option exits with 2", async () => {
  expect(await run(["--no-such-option"])).toBe(2);
});

test("--help exits with 0", async () => {
  expect(await run(["--help"])).toBe(0);
});

test("process exit code follows run()", () => {
  const proc = Bun.spawnSync(["bun", "src/main.ts", "--no-such-option"], { stderr: "pipe" });
  expect(proc.exitCode).toBe(2);
});
