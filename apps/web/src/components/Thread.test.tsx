// @vitest-environment jsdom
import type { WireItem } from "@tars/protocol";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import { initial, type State } from "../state.ts";
import { Thread } from "./Thread.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const T = "turn-00000001";

/** One tool call per status the local end ends a call with (ToolCallEndState), plus one running. */
function steps(statuses: readonly (string | undefined)[]): State {
  const items: WireItem[] = statuses.flatMap((status, i) => {
    const callId = `call-0000000${i}`;
    const call: WireItem = {
      seq: i * 2 + 1,
      turn: T,
      kind: "tool_call",
      callId,
      name: "tars",
      input: '{"argv":["memory","remember","x"]}',
      truncated: false,
    };
    return status === undefined
      ? [call]
      : [
          call,
          {
            seq: i * 2 + 2,
            turn: T,
            kind: "tool_result",
            callId,
            status,
            text: "結果",
            truncated: false,
          },
        ];
  });
  return { ...initial, connection: "open", conv: "conv-1", items };
}

test("each end state of a tool call is a tag in Chinese; a refused call reads 已擋下", async () => {
  const ends = [
    "done",
    "failed",
    "denied",
    "expired",
    "cancelled",
    "skipped",
    "refused",
    "interrupted",
  ];
  const { root } = await render(
    <Thread state={steps([...ends, undefined])} onOlder={() => undefined} after={() => null} />,
  );
  const cards = [...root.querySelectorAll(".tool-step")].map((e) => [
    e.querySelector(".tool-step-left > span")?.textContent,
    e.querySelector(".sg-tag")?.className,
    e.querySelector(".sg-tag")?.textContent,
  ]);
  expect(cards).toEqual([
    ["tars", "sg-tag ok", "完成"],
    ["tars", "sg-tag error", "失敗"],
    ["tars", "sg-tag error", "已拒絕"],
    ["tars", "sg-tag error", "已過期"],
    ["tars", "sg-tag ", "已取消"],
    ["tars", "sg-tag ", "已略過"],
    ["已擋下", "sg-tag warn", "沒有執行"],
    ["tars", "sg-tag warn", "中斷（結果不明）"],
    ["tars", "sg-tag active", "執行中"],
  ]);
});

test("a status this page does not know is shown as sent, not dropped", async () => {
  const { root } = await render(
    <Thread state={steps(["later_status"])} onOlder={() => undefined} after={() => null} />,
  );
  expect(root.querySelector(".tool-step .sg-tag")?.textContent).toBe("later_status");
});

test("a carried conversation opens with where it came from and that model's label", async () => {
  const carried = (from: string): State => ({
    ...initial,
    connection: "open",
    conv: "conv-2",
    items: [{ seq: 1, turn: T, kind: "carried", from }],
  });
  const origin = (id: string) =>
    id === "conv-00000001" ? { title: "整理巡檢", model: "Claude Sonnet 4.6" } : undefined;
  const known = await render(
    <Thread
      state={carried("conv-00000001")}
      origin={origin}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  const banner = known.root.querySelector(".fork-banner") as HTMLElement;
  expect([...banner.children].map((e) => e.textContent)).toEqual([
    "接續自「整理巡檢」（只帶入渲染後文字，不含工具執行紀錄）",
    "原模型 Claude Sonnet 4.6",
  ]);
  known.unmount();
  // One past the list: named by its id, no model.
  const far = await render(
    <Thread
      state={carried("conv-0000abcdef99")}
      origin={origin}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(far.root.querySelector(".fork-banner")?.textContent).toBe(
    "接續自對話 abcdef99（只帶入渲染後文字，不含工具執行紀錄）",
  );
  far.unmount();
});

const usage = (extra: Record<string, unknown>): State => ({
  ...initial,
  connection: "open",
  conv: "conv-1",
  items: [
    {
      seq: 1,
      turn: T,
      kind: "usage",
      inputTokens: 19_340,
      outputTokens: 216,
      costUsd: 0.0104,
      costSource: "table",
      ...extra,
    } as WireItem,
  ],
});

const spans = (root: HTMLElement) =>
  [...root.querySelectorAll(".msg-usage-line span")].map((e) => e.textContent);

test("A1: the usage line as the prototype; cache reads are taken out of 輸入 and shown even at 0", async () => {
  const full = await render(
    <Thread
      state={usage({ cacheReadTokens: 18_920, thinkingTokens: 92, effort: "medium" })}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(spans(full.root)).toEqual([
    "輸入 420",
    "快取讀 18,920",
    "輸出 216（含思考 92）",
    "推理：中",
    "0.010 USD 估",
  ]);
  document.body.innerHTML = "";
  const none = await render(
    <Thread
      state={usage({ cacheReadTokens: 0, costSource: "provider" })}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(spans(none.root)).toEqual(["輸入 19,340", "快取讀 0", "輸出 216", "0.010 USD"]);
});

test("A1: a local end older than the fields: no 快取讀, no thinking, no effort, never a made-up 0", async () => {
  const { root } = await render(
    <Thread state={usage({})} onOlder={() => undefined} after={() => null} />,
  );
  expect(spans(root)).toEqual(["輸入 19,340", "輸出 216", "0.010 USD 估"]);
});

const result = (extra: Record<string, unknown>): State => {
  const s = steps(["done"]);
  return {
    ...s,
    items: s.items.map((i) =>
      i.kind === "tool_result" ? ({ ...i, exit: 0, ...extra } as WireItem) : i,
    ),
  };
};

test("A2: the time in seconds replaces 結束碼 in the summary; the code moves into the output", async () => {
  const { root } = await render(
    <Thread state={result({ durationMs: 840 })} onOlder={() => undefined} after={() => null} />,
  );
  const right = root.querySelector(".tool-step-right")?.textContent;
  expect(right).toContain("0.84 s");
  expect(right).not.toContain("結束碼");
  (root.querySelector(".tool-step-summary") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".tool-step-body")?.textContent).toContain("· 結束碼 0");
});

test("A2: without a time (an older local end) the summary keeps 結束碼", async () => {
  const { root } = await render(
    <Thread state={result({})} onOlder={() => undefined} after={() => null} />,
  );
  expect(root.querySelector(".tool-step-right")?.textContent).toContain("結束碼 0");
});

test("B3: a refused call says why when the local end does; 沒有執行 when it does not", async () => {
  const tags = async (refusal: string | undefined) => {
    document.body.innerHTML = "";
    const s = steps(["refused"]);
    const state = {
      ...s,
      items: s.items.map((i) =>
        i.kind === "tool_result" && refusal !== undefined ? ({ ...i, refusal } as WireItem) : i,
      ),
    };
    const { root } = await render(
      <Thread state={state} onOlder={() => undefined} after={() => null} />,
    );
    return root.querySelector(".tool-step .sg-tag")?.textContent;
  };
  expect(await tags("not_offered")).toBe("這個入口不提供");
  expect(await tags("changed")).toBe("腳本已變更，沒有執行");
  expect(await tags("budget")).toBe("預算已到上限，沒有執行");
  expect(await tags(undefined)).toBe("沒有執行");
});

const turnState = (turn: State["turn"], items: WireItem[] = []): State => ({
  ...initial,
  connection: "open",
  conv: "conv-1",
  items,
  ...(turn === undefined ? {} : { turn }),
});

test("D1: a started turn's line names its phase, and is gone once the turn ends", async () => {
  const line = async (turn: State["turn"]) => {
    document.body.innerHTML = "";
    const { root } = await render(
      <Thread state={turnState(turn)} onOlder={() => undefined} after={() => null} />,
    );
    return root.querySelector(".turn-status")?.textContent ?? null;
  };
  expect(await line({ state: "started", turn: T, phase: "thinking" })).toBe("思考中…");
  expect(await line({ state: "started", turn: T, phase: "replying" })).toBe("回覆中");
  expect(await line({ state: "started", turn: T, phase: "running_script" })).toBe("執行腳本");
  expect(await line({ state: "started", turn: T, phase: "waiting_approval" })).toBe("等待核准");
  // An older local end sends no phase.
  expect(await line({ state: "started", turn: T })).toBe("回覆中…");
  expect(await line({ state: "completed", turn: T })).toBeNull();
  expect(await line({ state: "aborted", turn: T })).toBeNull();
});

test("C3: an interrupted turn is a warn card, from its error item or, without one, from the turn", async () => {
  const errorItem = {
    seq: 1,
    turn: T,
    kind: "error",
    code: "interrupted",
    message: "程式在回合進行中結束",
    data: { script: "bark-notify" },
  } as WireItem;
  const withItem = await render(
    <Thread
      state={turnState({ state: "interrupted", turn: T }, [errorItem])}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  const cards = withItem.root.querySelectorAll(".task-notice");
  expect(cards).toHaveLength(1);
  expect(cards[0]?.className).toBe("task-notice warn");
  expect(cards[0]?.querySelector(".task-notice-title")?.textContent).toBe("回合中斷（本機端重啟）");
  expect(cards[0]?.querySelector(".task-notice-desc")?.textContent).toBe(
    "腳本 bark-notify 的結果不明，系統沒有自動重跑。請先確認狀態再繼續。",
  );
  document.body.innerHTML = "";
  const bare = await render(
    <Thread
      state={turnState({ state: "interrupted", turn: T })}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(bare.root.querySelector(".task-notice-title")?.textContent).toBe("回合中斷（本機端重啟）");
  expect(bare.root.querySelector(".turn-status")).toBeNull();
});

test("C1: a failed turn's figures come from turn.data when no error item carries them", async () => {
  const { root } = await render(
    <Thread
      state={turnState({
        state: "failed",
        turn: T,
        reason: "turn_cap",
        data: { turnUsd: 1.02, turnCapUsd: 1 },
      })}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(root.querySelector(".task-notice-title")?.textContent).toBe(
    "這個回合的花費已到上限（1.00 USD）",
  );
  expect(root.querySelector(".task-notice-desc")?.textContent).toContain("這個回合累計 1.02 USD");
});
