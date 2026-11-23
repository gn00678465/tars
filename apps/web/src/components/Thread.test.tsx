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

test("the sprites: the wheel while thinking, idle on the empty page, and no inline style", async () => {
  const thinking = await render(
    <Thread
      state={turnState({ state: "started", turn: T, phase: "thinking" })}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  const sprite = thinking.root.querySelector(".turn-status .tars-sprite");
  expect(sprite?.className).toBe("tars-sprite wheel");
  expect(sprite?.getAttribute("aria-hidden")).toBe("true");
  expect(thinking.root.querySelector("[style], style")).toBeNull();
  thinking.unmount();
  const replying = await render(
    <Thread
      state={turnState({ state: "started", turn: T, phase: "replying" })}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(replying.root.querySelector(".tars-sprite")).toBeNull();
  replying.unmount();
  const empty = await render(
    <Thread
      state={{ ...initial, connection: "open" }}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(empty.root.querySelector(".empty-state .tars-sprite")?.className).toBe("tars-sprite idle");
  expect(empty.root.querySelector("[style], style")).toBeNull();
  empty.unmount();
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

const SUMMARY = [
  "## Goal",
  "- 整理巡檢",
  "## Progress",
  "### Done",
  "- [x] SMART 檢查",
  "### Blocked",
  "- (none)",
  "## Scripts, Outputs & Facts",
  "- 已執行 `disk-health-report`",
].join("\n");

const compacted = (): State => {
  const u = (seq: number, turn: string) =>
    ({ seq, turn, kind: "user", text: `u${seq}`, truncated: false }) as WireItem;
  const a = (seq: number, turn: string) =>
    ({
      seq,
      turn,
      kind: "assistant",
      text: `a${seq}`,
      truncated: false,
      state: "complete",
    }) as WireItem;
  const c = (seq: number, extra: Record<string, unknown>) =>
    ({
      seq,
      turn: "tc",
      kind: "compaction",
      text: SUMMARY,
      truncated: false,
      ...extra,
    }) as WireItem;
  return {
    ...initial,
    connection: "open",
    conv: "conv-1",
    items: [
      u(1, "t1"),
      a(2, "t1"),
      u(3, "t2"),
      a(4, "t2"),
      c(5, { at: 0, trigger: "auto", count: 8, firstKeptSeq: 3 }),
      u(6, "t3"),
      a(7, "t3"),
      c(8, {
        trigger: "manual",
        count: 14,
        beforeTokens: 152_400,
        keptTokens: 20_000,
        costUsd: 0.014,
        firstKeptSeq: 6,
      }),
    ],
  };
};

test("E4: the dividers sit where the latest summary ends; what it summarized is faded", async () => {
  const { root } = await render(
    <Thread state={compacted()} onOlder={() => undefined} after={() => null} />,
  );
  const order = [
    ...root.querySelectorAll(".compacted-notice-line, .msg-group, .compaction-divider"),
  ].map((e) =>
    e.classList.contains("compaction-divider")
      ? `divider:${e.querySelector(".compaction-trigger-left")?.textContent}`
      : e.classList.contains("msg-group")
        ? `${e.className}:${e.querySelector(".msg-user")?.textContent}`
        : "line",
  );
  expect(order).toEqual([
    "line",
    "msg-group compacted-old:u1",
    "msg-group compacted-old:u3",
    `divider:${new Date(0).getHours().toString().padStart(2, "0")}:00 自動壓縮（早期 8 則）`,
    "divider:已壓縮早期 14 則訊息（原 152,400 tokens · 保留近期 20,000 tokens）手動",
    "msg-group:u6",
  ]);
  expect(root.querySelectorAll(".compaction-divider .sg-tag")[0]?.textContent).toBe(
    "已併入後面的摘要",
  );
});

test("E4: the summary opens to its sections, headings in Chinese, figures and cost above", async () => {
  const { root } = await render(
    <Thread state={compacted()} onOlder={() => undefined} after={() => null} />,
  );
  const open = root.querySelector("button.compaction-trigger") as HTMLButtonElement;
  expect(open.textContent).toContain("展開摘要");
  open.click();
  await new Promise((r) => setTimeout(r, 0));
  const body = root.querySelector(".compaction-body") as HTMLElement;
  expect(body.querySelector(".compaction-meta")?.textContent).toBe(
    "本次摘要花費 0.014 USD（估）· 原始 14 則紀錄仍完整保存於本機資料庫。",
  );
  expect([...body.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
    "目標",
    "進度",
    "腳本、輸出與事實",
  ]);
  expect(body.textContent).toContain("已完成");
  expect(body.textContent).not.toContain("[x]");
  expect(body.textContent).toContain("（無）");
  expect(body.querySelector("code")?.textContent).toBe("disk-health-report");
});

test("E4: an older local end's compaction, without its place, is drawn where it came", async () => {
  const s = compacted();
  const items = s.items.map((i) =>
    i.kind === "compaction"
      ? ({ seq: i.seq, turn: i.turn, kind: i.kind, text: "摘要", truncated: false } as WireItem)
      : i,
  );
  const { root } = await render(
    <Thread state={{ ...s, items }} onOlder={() => undefined} after={() => null} />,
  );
  expect(root.querySelector(".compacted-old")).toBeNull();
  expect(root.querySelectorAll(".compaction-divider")).toHaveLength(2);
  expect(root.querySelector(".compaction-trigger-left")?.textContent).toBe(
    "這之前的內容已壓縮成摘要",
  );
});

test("E3: 壓縮中 while it runs; its end, when not a summary, is a card saying nothing changed", async () => {
  const line = await render(
    <Thread
      state={{ ...compacted(), compacting: true }}
      onOlder={() => undefined}
      after={() => null}
    />,
  );
  expect(line.root.querySelector(".turn-status")?.textContent).toBe("壓縮中…");
  const ends: [NonNullable<State["compactEnd"]>, string, string][] = [
    [
      { state: "skipped" },
      "沒有可以壓縮的部分",
      "較早的內容不夠多，只有近期原文。對話內容沒有改變。",
    ],
    [{ state: "aborted" }, "壓縮已取消", "對話內容沒有改變。可以再壓縮一次。"],
    [
      { state: "failed", reason: "compact_bad_summary" },
      "壓縮失敗：摘要的格式不對",
      "對話內容沒有改變。可以再壓縮一次。",
    ],
    [
      { state: "failed", nack: "busy" },
      "壓縮失敗：本機端正在跑另一個回合",
      "對話內容沒有改變。可以再壓縮一次。",
    ],
  ];
  for (const [end, title, desc] of ends) {
    document.body.innerHTML = "";
    const { root } = await render(
      <Thread
        state={{ ...compacted(), compactEnd: end }}
        onOlder={() => undefined}
        after={() => null}
      />,
    );
    expect(root.querySelector(".task-notice-title")?.textContent).toBe(title);
    expect(root.querySelector(".task-notice-desc")?.textContent).toBe(desc);
  }
});
