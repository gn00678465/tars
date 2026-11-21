import { describe, expect, test } from "bun:test";
import { DEFAULT_NOTIFY } from "../../../src/features/agent/config.ts";
import {
  durationText,
  Notifier,
  originText,
  type NotifyDeps,
} from "../../../src/features/serve/notify.ts";
import { approvalRecord, manualTimers, recordedLog } from "./fixture.ts";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function notifier(over: Partial<NotifyDeps> = {}) {
  const timers = manualTimers();
  const runs: string[][] = [];
  const log = recordedLog();
  const state = { running: false, mayRunTool: false, exit: 0 };
  const n = new Notifier({
    config: { ...DEFAULT_NOTIFY, script: "push" },
    run: async (argv) => {
      runs.push([...argv]);
      return state.exit;
    },
    now: timers.now,
    timers,
    log,
    turnRunning: () => state.running,
    turnMayRunTool: () => state.mayRunTool,
    ...over,
  });
  return { n, timers, runs, log, state };
}

const titleBody = (argv: string[]) => [
  argv[argv.indexOf("--title") + 1],
  argv[argv.indexOf("--body") + 1],
];

describe("Notifier", () => {
  test("approval: script and the id's last 8, through script run, no argv or summary", async () => {
    const { n, runs, log } = notifier();
    await n.approval(approvalRecord());
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slice(0, 4)).toEqual(["script", "run", "push", "--"]);
    expect(titleBody(runs[0]!)).toEqual(["TARS 等待核准", "執行腳本 notes（e56800aa）"]);
    expect(JSON.stringify(runs)).not.toContain("PRIVATE-ARGV");
    expect(JSON.stringify(runs)).not.toContain("寫筆記");
    expect(log.lines.at(-1)).toMatchObject({
      event: "notify",
      fields: { notifyKind: "approval", state: "ok", exit: 0 },
    });
  });

  test("placeholders are replaced only as a whole argument", async () => {
    const { n, runs } = notifier({
      config: { script: "push", args: ["{title}", "x{body}", "{body}"], on_connect: false },
    });
    await n.approval(approvalRecord());
    expect(runs[0]!.slice(4)).toEqual(["TARS 等待核准", "x{body}", "執行腳本 notes（e56800aa）"]);
  });

  test("not configured: nothing runs, and idle resolves", async () => {
    const { n, runs } = notifier({ config: undefined });
    expect(n.configured).toBe(false);
    await n.approval(approvalRecord());
    n.browserConnected({ country: "TW" });
    n.replacedAgain(0);
    await n.idle();
    expect(runs).toEqual([]);
  });

  test("a failing script is logged, never thrown", async () => {
    const { n, log } = notifier({ run: async () => Promise.reject(new Error("boom")) });
    await n.approval(approvalRecord());
    expect(log.lines.at(-1)).toMatchObject({ fields: { state: "failed", exit: -1 } });
  });

  test("one child at a time, in order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { n } = notifier({
      run: async (argv) => {
        order.push(`start ${argv.at(-1)}`);
        if (order.length === 1) await gate;
        order.push(`end ${argv.at(-1)}`);
        return 0;
      },
    });
    void n.approval(approvalRecord());
    void n.approval(
      approvalRecord({
        id: "01a1fd71-be41-71e7-809a-4bb1e56800bb",
        fields: { ...approvalRecord().fields, script: "two" },
      }),
    );
    await settle();
    expect(order).toEqual(["start 執行腳本 notes（e56800aa）"]);
    release();
    await n.idle();
    await settle();
    expect(order).toHaveLength(4);
    expect(order[1]!.startsWith("end")).toBe(true);
  });

  test("connections within 60 s make one notification with the last origin", async () => {
    const { n, timers, runs } = notifier();
    timers.advance(120_000);
    n.browserConnected({ country: "TW", ua: "Firefox" });
    n.browserConnected({ country: "JP", ua: "Safari" });
    timers.advance(59_000);
    expect(runs).toEqual([]);
    timers.advance(1_000);
    await n.idle();
    await settle();
    expect(titleBody(runs[0]!)).toEqual(["TARS 有新的連線", "2 條；JP；Safari"]);
  });

  test("the wave after the link connects gets its own words", async () => {
    const { n, timers, runs } = notifier();
    n.linkConnected();
    timers.advance(10_000);
    n.browserConnected({ country: "TW" });
    timers.advance(50_000);
    await n.idle();
    await settle();
    expect(titleBody(runs[0]!)[1]).toBe("本機端重新連線後恢復 1 條連線；TW；不明");
  });

  test("a new-connection notification is skipped while a turn runs; off without on_connect", async () => {
    const { n, timers, runs, log, state } = notifier();
    timers.advance(120_000);
    state.running = true;
    n.browserConnected({});
    timers.advance(60_000);
    await n.idle();
    await settle();
    expect(runs).toEqual([]);
    expect(log.lines.at(-1)).toMatchObject({ fields: { notifyKind: "connect", state: "skipped" } });
    const off = notifier({ config: { ...DEFAULT_NOTIFY, script: "push", on_connect: false } });
    off.n.browserConnected({});
    off.timers.advance(120_000);
    await off.n.idle();
    expect(off.runs).toEqual([]);
  });

  test("replaced: put off while a tool may run, sent on poke, again only after an hour", async () => {
    const { n, timers, runs, state } = notifier();
    state.mayRunTool = true;
    n.replacedAgain(timers.now());
    await n.idle();
    expect(runs).toEqual([]);
    expect(n.replacedNotified).toBe(false);
    state.mayRunTool = false;
    timers.advance(5 * 60_000);
    n.poke();
    await n.idle();
    await settle();
    expect(titleBody(runs[0]!)).toEqual([
      "TARS 的本機端連線被另一台取代",
      "請檢查憑證。已持續 5 分鐘",
    ]);
    expect(n.replacedNotified).toBe(true);
    n.replacedAgain(0);
    await n.idle();
    expect(runs).toHaveLength(1);
    timers.advance(60 * 60_000);
    n.replacedAgain(0);
    await n.idle();
    await settle();
    expect(runs).toHaveLength(2);
    expect(titleBody(runs[1]!)[1]).toBe("請檢查憑證。已持續 1 小時 5 分鐘");
  });

  test("replaced: a failed send is retried on the next replaced", async () => {
    const { n, runs, state } = notifier();
    state.exit = 1;
    n.replacedAgain(0);
    await n.idle();
    await settle();
    expect(n.replacedNotified).toBe(false);
    state.exit = 0;
    n.replacedAgain(0);
    await n.idle();
    await settle();
    expect(runs).toHaveLength(2);
    expect(n.replacedNotified).toBe(true);
  });

  test("originText drops controls and hidden characters and caps at 60", () => {
    expect(originText("Fire\u0007fox‮​")).toBe("Firefox");
    expect(originText("x".repeat(80))).toHaveLength(60);
    expect(originText(undefined)).toBe("不明");
    expect(durationText(59_999)).toBe("0 分鐘");
  });
});
