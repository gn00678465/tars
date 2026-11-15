import { expect, test } from "bun:test";
import { run } from "../src/main.ts";
import { captureIo } from "./helpers.ts";

const deps = () => ({ io: captureIo(), env: {} });

test("unknown option exits with 2", async () => {
  expect(await run(["--no-such-option"], deps())).toBe(2);
});

test("--help exits with 0 and prints usage to stdout", async () => {
  const d = deps();
  expect(await run(["--help"], d)).toBe(0);
  expect(d.io.stdout.join("\n")).toContain("Usage: tars");
});

test("process exit code follows run()", () => {
  const proc = Bun.spawnSync(["bun", "src/main.ts", "--no-such-option"], { stderr: "pipe" });
  expect(proc.exitCode).toBe(2);
});
