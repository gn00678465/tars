import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT_TIMEOUT,
  OUTPUT_LIMIT,
  processStartTime,
  spawnAndWait,
} from "../../src/core/spawn.ts";
import { tempHome } from "../helpers.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A killed orphan is reaped by init a moment later; until then kill(pid, 0) still succeeds. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(10);
  }
  return false;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10);
  if (!check()) throw new Error("condition never held");
}

describe("spawnAndWait", () => {
  test("an abort stops the child and, with group, the grandchild it left behind", async () => {
    const dir = tempHome();
    const pidFile = join(dir, "grandchild");
    const controller = new AbortController();
    let child = 0;
    const running = spawnAndWait(
      ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`],
      dir,
      ENV,
      30_000,
      { signal: controller.signal, group: true, graceMs: 200, onSpawn: (pid) => (child = pid) },
    );
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.exit).toBe(128 + 15);
    expect(await gone(child)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
  });

  test("an already aborted signal starts nothing and reports a stopped child", async () => {
    const dir = tempHome();
    const marker = join(dir, "ran");
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const result = await spawnAndWait(["sh", "-c", `touch ${marker}`], dir, ENV, 30_000, {
      signal: controller.signal,
      onSpawn: () => (spawned = true),
    });
    expect(result.exit).toBe(128 + 15);
    expect(spawned).toBe(false);
    await Bun.sleep(200);
    expect(existsSync(marker)).toBe(false);
  });

  test("onSpawn throwing kills the whole group, then the error propagates", async () => {
    const dir = tempHome();
    const pidFile = join(dir, "grandchild");
    const marker = join(dir, "finished");
    let child = 0;
    const running = spawnAndWait(
      ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; sleep 1; touch ${marker}; wait`],
      dir,
      ENV,
      30_000,
      {
        group: true,
        onSpawn: (pid) => {
          child = pid;
          throw new Error("database is locked");
        },
      },
    );
    await expect(running).rejects.toThrow("database is locked");
    expect(await gone(child)).toBe(true);
    if (existsSync(pidFile)) expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
    await Bun.sleep(1500);
    expect(existsSync(marker)).toBe(false);
  });

  test("onSpawn throwing without a group still kills the child", async () => {
    const dir = tempHome();
    const marker = join(dir, "finished");
    let child = 0;
    const running = spawnAndWait(["sh", "-c", `sleep 1; touch ${marker}`], dir, ENV, 30_000, {
      onSpawn: (pid) => {
        child = pid;
        throw new Error("no record");
      },
    });
    await expect(running).rejects.toThrow("no record");
    expect(await gone(child)).toBe(true);
    await Bun.sleep(1500);
    expect(existsSync(marker)).toBe(false);
  });

  test("output past OUTPUT_LIMIT is cut and marked truncated", async () => {
    const result = await spawnAndWait(
      ["sh", "-c", `yes x | head -c ${OUTPUT_LIMIT + 4096}`],
      tempHome(),
      ENV,
      30_000,
    );
    expect(result.exit).toBe(0);
    expect(result.stdout.length).toBe(OUTPUT_LIMIT);
    expect(result.truncated).toBe(true);
  });

  test("output within the limit is kept whole", async () => {
    const result = await spawnAndWait(
      ["sh", "-c", "echo out; echo err >&2"],
      tempHome(),
      ENV,
      30_000,
    );
    expect(result).toMatchObject({ exit: 0, stdout: "out\n", stderr: "err\n", truncated: false });
  });

  test("a timeout ends with EXIT_TIMEOUT", async () => {
    const result = await spawnAndWait(["sleep", "30"], tempHome(), ENV, 50, { graceMs: 200 });
    expect(result.exit).toBe(EXIT_TIMEOUT);
    expect(result.ms).toBeLessThan(5000);
  });

  test("a child that ignores SIGTERM is killed after graceMs", async () => {
    const result = await spawnAndWait(
      ["sh", "-c", "trap '' TERM; exec sleep 30"],
      tempHome(),
      ENV,
      50,
      { graceMs: 300 },
    );
    expect(result.exit).toBe(EXIT_TIMEOUT);
    expect(result.ms).toBeGreaterThanOrEqual(300);
    expect(result.ms).toBeLessThan(5000);
  });

  test("handleSignals: false adds no SIGINT or SIGTERM listener; the default adds one each", async () => {
    const counts = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const before = counts();
    const whileRunning = async (handleSignals?: boolean) => {
      const opts = handleSignals === undefined ? {} : { handleSignals };
      const running = spawnAndWait(["sleep", "0.3"], tempHome(), ENV, 30_000, opts);
      await Bun.sleep(100);
      const during = counts();
      await running;
      return during;
    };
    expect(await whileRunning(false)).toEqual(before);
    expect(await whileRunning()).toEqual(before.map((n) => n + 1));
    expect(counts()).toEqual(before);
  });

  test("onSpawn gets a pid whose start time can be read", async () => {
    let start: string | undefined;
    await spawnAndWait(["sleep", "0.1"], tempHome(), ENV, 30_000, {
      onSpawn: (pid) => (start = processStartTime(pid)),
    });
    expect(start).toMatch(/^\d+$/);
  });
});

describe("processStartTime", () => {
  test("is stable for a live process and undefined for a missing one", () => {
    expect(processStartTime(process.pid)).toBe(processStartTime(process.pid));
    expect(processStartTime(process.pid)).toMatch(/^\d+$/);
    expect(processStartTime(2 ** 30)).toBeUndefined();
  });
});
