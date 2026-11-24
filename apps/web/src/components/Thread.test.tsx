// @vitest-environment jsdom
import type { WireItem } from "@tars/protocol";
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import { initial, type State } from "../state.ts";
import { Thread as Rows } from "./Thread.tsx";
import { inScroller, noticeTone } from "../testing.ts";

/** The thread's rows are the scroller's (App.tsx). */
const Thread = (props: Parameters<typeof Rows>[0]) => inScroller(<Rows {...props} />);

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

/** A tool step's line: who, its result in words, the words' tone, Trace's status, its icon. */
const stepLine = (e: Element) => {
  const result = e.querySelector(".tool-step-result");
  const icon = e.querySelector(".tool-step-icon");
  return [
    e.querySelector(".tool-step-name")?.textContent,
    result?.textContent,
    [...(result?.classList ?? [])].filter((c) => c !== "tool-step-result").join(" "),
    e.querySelector("[data-slot=trace-line]")?.getAttribute("data-status") ?? null,
    icon?.querySelector(".tars-sprite")?.className ??
      icon
        ?.querySelector("svg")
        ?.getAttribute("class")
        ?.match(/lucide-[a-z-]+/)?.[0],
  ];
};

// P3b: Trace's error status and the error tone are 失敗's alone (denied and expired were the
// error tag before: neither failed). Each result has its words and an icon of its own.
test("each end state of a tool call: its words, its own icon, error for 失敗 alone; a refused call reads 已擋下", async () => {
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
  const { root } = await render(<Thread state={steps([...ends, undefined])} after={() => null} />);
  const lines = [...root.querySelectorAll(".tool-step")].map(stepLine);
  expect(lines).toEqual([
    ["tars", "完成", "ok", null, "lucide-check"],
    ["tars", "失敗", "error", "error", "lucide-circle-x"],
    ["tars", "已拒絕", "", null, "lucide-ban"],
    ["tars", "已過期", "", null, "lucide-timer-off"],
    ["tars", "已取消", "", null, "lucide-circle-minus"],
    ["tars", "已略過", "", null, "lucide-skip-forward"],
    ["已擋下", "沒有執行", "warn", null, "lucide-shield-exclamation-point"],
    ["tars", "中斷（結果不明）", "warn", null, "lucide-circle-question-mark"],
    ["tars", "執行中", "", "running", "tars-sprite wheel sm"],
  ]);
  expect(new Set(lines.map((l) => l[4])).size).toBe(lines.length);
  expect(root.querySelectorAll('[data-status="error"]')).toHaveLength(1);
});

test("a status this page does not know is shown as sent, not dropped", async () => {
  const { root } = await render(<Thread state={steps(["later_status"])} after={() => null} />);
  expect(root.querySelector(".tool-step .tool-step-result")?.textContent).toBe("later_status");
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
    <Thread state={carried("conv-00000001")} origin={origin} after={() => null} />,
  );
  const banner = known.root.querySelector(".fork-banner") as HTMLElement;
  expect([...banner.children].map((e) => e.textContent)).toEqual([
    "接續自「整理巡檢」（只帶入渲染後文字，不含工具執行紀錄）",
    "原模型 Claude Sonnet 4.6",
  ]);
  known.unmount();
  // One past the list: named by its id, no model.
  const far = await render(
    <Thread state={carried("conv-0000abcdef99")} origin={origin} after={() => null} />,
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
    <Thread state={usage({ cacheReadTokens: 0, costSource: "provider" })} after={() => null} />,
  );
  expect(spans(none.root)).toEqual(["輸入 19,340", "快取讀 0", "輸出 216", "0.010 USD"]);
});

test("A1: a local end older than the fields: no 快取讀, no thinking, no effort, never a made-up 0", async () => {
  const { root } = await render(<Thread state={usage({})} after={() => null} />);
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
  const { root } = await render(<Thread state={result({ durationMs: 840 })} after={() => null} />);
  const right = root.querySelector(".tool-step-right")?.textContent;
  expect(right).toContain("0.84 s");
  expect(right).not.toContain("結束碼");
  (root.querySelector(".tool-step-summary") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".tool-step-body")?.textContent).toContain("· 結束碼 0");
});

test("A2: without a time (an older local end) the summary keeps 結束碼", async () => {
  const { root } = await render(<Thread state={result({})} after={() => null} />);
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
    const { root } = await render(<Thread state={state} after={() => null} />);
    return root.querySelector(".tool-step .tool-step-result")?.textContent;
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
    const { root } = await render(<Thread state={turnState(turn)} after={() => null} />);
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

// The no-inline-style check covers only these two Thread views, not the whole App.
test("the sprites: the wheel while thinking, idle while waiting for an approval and on the empty page; no view has a style", async () => {
  const thinking = await render(
    <Thread
      state={turnState({ state: "started", turn: T, phase: "thinking" })}
      after={() => null}
    />,
  );
  const sprite = thinking.root.querySelector(".turn-status .tars-sprite");
  expect(sprite?.className).toBe("tars-sprite wheel");
  expect(sprite?.getAttribute("aria-hidden")).toBe("true");
  expect(thinking.root.querySelector("[style], style")).toBeNull();
  thinking.unmount();
  // Every working phase is TARS rolling, none the old three bars (the owner: 回覆中 showed them).
  for (const phase of ["replying", "running_script", undefined] as const) {
    const working = await render(
      <Thread
        state={turnState({ state: "started", turn: T, ...(phase === undefined ? {} : { phase }) })}
        after={() => null}
      />,
    );
    expect(working.root.querySelector(".turn-status .tars-sprite")?.className).toBe(
      "tars-sprite wheel",
    );
    expect(working.root.querySelector(".status-glyph")).toBeNull();
    working.unmount();
  }
  const waiting = await render(
    <Thread
      state={turnState({ state: "started", turn: T, phase: "waiting_approval" })}
      after={() => null}
    />,
  );
  const waitSprite = waiting.root.querySelector(".turn-status .tars-sprite");
  expect(waitSprite?.className).toBe("tars-sprite idle");
  expect(waitSprite?.getAttribute("aria-hidden")).toBe("true");
  expect(waiting.root.querySelector(".turn-status")?.textContent).toContain("等待核准");
  expect(waiting.root.querySelector("[style], style")).toBeNull();
  waiting.unmount();
  const empty = await render(
    <Thread state={{ ...initial, connection: "open" }} after={() => null} />,
  );
  expect(empty.root.querySelector(".empty-state .tars-sprite")?.className).toBe("tars-sprite idle");
  expect(empty.root.querySelector("[style], style")).toBeNull();
  empty.unmount();
});

test("a table's order picked while the reply streams stays once the reply is an item", async () => {
  const table = "| 代號 | 價 |\n|---|---|\n| 2330 | 2 |\n| 0050 | 1 |";
  const user: WireItem = { seq: 1, turn: T, kind: "user", text: "列表", truncated: false };
  const before: WireItem = {
    seq: 2,
    turn: T,
    kind: "assistant",
    text: "先查一下。",
    truncated: false,
    state: "complete",
  };
  const view = (state: State) => <Thread state={state} after={() => null} />;
  const streaming: State = {
    ...turnState({ state: "started", turn: T }, [user, before]),
    running: { turn: T, text: table },
  };
  const { root, rerender } = await render(view(streaming));
  const price = () => root.querySelectorAll(".md-table th")[1] as HTMLElement;
  await act(async () => (price().querySelector("button") as HTMLButtonElement).click());
  expect(price().getAttribute("aria-sort")).toBe("ascending");
  const done: WireItem = { ...before, seq: 3, text: table };
  await rerender(view(turnState({ state: "completed", turn: T }, [user, before, done])));
  expect(root.querySelector(".streaming")).toBeNull();
  expect(price().getAttribute("aria-sort")).toBe("ascending");
  expect(
    [...root.querySelectorAll(".md-table tbody tr")].map((r) => r.firstChild?.textContent),
  ).toEqual(["0050", "2330"]);
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
    <Thread state={turnState({ state: "interrupted", turn: T }, [errorItem])} after={() => null} />,
  );
  const cards = withItem.root.querySelectorAll(".task-notice");
  expect(cards).toHaveLength(1);
  expect(noticeTone(cards[0])).toBe("task-notice warn");
  expect(cards[0]?.querySelector(".task-notice-title")?.textContent).toBe("回合中斷（本機端重啟）");
  expect(cards[0]?.querySelector(".task-notice-desc")?.textContent).toBe(
    "腳本 bark-notify 的結果不明，系統沒有自動重跑。請先確認狀態再繼續。",
  );
  document.body.innerHTML = "";
  const bare = await render(
    <Thread state={turnState({ state: "interrupted", turn: T })} after={() => null} />,
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
  const { root } = await render(<Thread state={compacted()} after={() => null} />);
  const order = [
    ...root.querySelectorAll(".compacted-notice-line, .msg-group, .compaction-divider"),
  ].map((e) =>
    e.classList.contains("compaction-divider")
      ? `divider:${e.querySelector(".compaction-trigger-left")?.textContent}`
      : e.classList.contains("msg-group")
        ? // The row's own classes, without the scroller item's.
          `${e.classList.contains("compacted-old") ? "msg-group compacted-old" : "msg-group"}:${e.querySelector(".msg-user")?.textContent}`
        : "line",
  );
  // The line above them is the page's, over the rows (App.scroll.test.tsx).
  expect(order).toEqual([
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
  const { root } = await render(<Thread state={compacted()} after={() => null} />);
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
  const { root } = await render(<Thread state={{ ...s, items }} after={() => null} />);
  expect(root.querySelector(".compacted-old")).toBeNull();
  expect(root.querySelectorAll(".compaction-divider")).toHaveLength(2);
  expect(root.querySelector(".compaction-trigger-left")?.textContent).toBe(
    "這之前的內容已壓縮成摘要",
  );
});

test("E3: 壓縮中 while it runs; its end, when not a summary, is a card saying nothing changed", async () => {
  const line = await render(
    <Thread state={{ ...compacted(), compacting: true }} after={() => null} />,
  );
  expect(line.root.querySelector(".turn-status")?.textContent).toBe("壓縮中…");
  expect(line.root.querySelector(".turn-status .tars-sprite")?.className).toBe("tars-sprite wheel");
  expect(line.root.querySelector(".status-glyph")).toBeNull();
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
      <Thread state={{ ...compacted(), compactEnd: end }} after={() => null} />,
    );
    expect(root.querySelector(".task-notice-title")?.textContent).toBe(title);
    expect(root.querySelector(".task-notice-desc")?.textContent).toBe(desc);
  }
});

const withOutput = (text: string): State => {
  const s = steps(["done"]);
  return {
    ...s,
    items: s.items.map((i) =>
      i.kind === "tool_call"
        ? ({ ...i, input: "<b>argv</b> **粗**" } as WireItem)
        : i.kind === "tool_result"
          ? ({ ...i, text } as WireItem)
          : i,
    ),
  };
};

test("P3b: a tool step opens and closes on its own button, aria-expanded says which, nothing has a style", async () => {
  const { root } = await render(<Thread state={withOutput("一\n二")} after={() => null} />);
  const trigger = root.querySelector(".tool-step-summary") as HTMLButtonElement;
  // A native button: Enter and Space press it, and it takes the focus ring (Trace's focus-visible).
  expect([trigger.tagName, trigger.getAttribute("type")]).toEqual(["BUTTON", "button"]);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(root.querySelector(".tool-step-body")).toBeNull();
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-controls")).toBe(
    root.querySelector("[data-slot=trace-collapsible-content]")?.id,
  );
  expect(root.querySelector(".tool-step-body")?.textContent).toContain(
    "執行輸出（純文字，共 2 行）",
  );
  // No style of ours. Base UI's panel sets its own height variables from script (CSSOM, which
  // the CSP allows; tools/visual/csp.ts opens one), and nothing else.
  expect(root.querySelector("style")).toBeNull();
  const styled = [...root.querySelectorAll("[style]")] as HTMLElement[];
  expect(styled.map((e) => e.dataset["slot"])).toEqual(["trace-collapsible-content"]);
  expect([...(styled[0]?.style ?? [])].sort()).toEqual([
    "--collapsible-panel-height",
    "--collapsible-panel-width",
  ]);
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

// T11: what a tool sent is text: no tag of it becomes an element, no Markdown becomes bold.
test("P3b: the argv and the output are plain text as sent (T11)", async () => {
  const sent = '<script>alert(1)</script>\n**粗體**\n<img src=x onerror="alert(2)">';
  const { root } = await render(<Thread state={withOutput(sent)} after={() => null} />);
  await act(async () => (root.querySelector(".tool-step-summary") as HTMLButtonElement).click());
  const codes = [...root.querySelectorAll(".tool-step-body [data-slot=code-block-code]")];
  expect(codes.map((c) => c.textContent)).toEqual(["<b>argv</b> **粗**", sent]);
  expect(
    root.querySelector(".tool-step script, .tool-step img, .tool-step strong, .tool-step b"),
  ).toBeNull();
});

test("P3b: more than 20 lines open the rest on a button and fold back", async () => {
  const many = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
  const { root } = await render(<Thread state={withOutput(many)} after={() => null} />);
  await act(async () => (root.querySelector(".tool-step-summary") as HTMLButtonElement).click());
  const out = () =>
    root.querySelectorAll(".tool-step-body [data-slot=code-block-code]")[1]?.textContent;
  const more = () => root.querySelector(".tool-step-body .sg-btn") as HTMLButtonElement;
  expect([out()?.split("\n").length, more().textContent]).toEqual([20, "展開其餘 5 行"]);
  await act(async () => more().click());
  expect([out()?.split("\n").length, more().textContent]).toEqual([25, "收合至前 20 行"]);
});

test("P3b: the turn's line is a Trace line in our own role=status; it shimmers only while working, never under reduced motion", async () => {
  const line = async (turn: State["turn"], compacting = false) => {
    document.body.innerHTML = "";
    const { root } = await render(
      <Thread
        state={{ ...turnState(turn), ...(compacting ? { compacting: true } : {}) }}
        after={() => null}
      />,
    );
    const status = root.querySelector(".turn-status");
    return [
      status?.getAttribute("role"),
      status?.querySelector("[data-slot=trace-line]")?.getAttribute("data-status") ?? null,
      status?.querySelector(".tars-sprite")?.className,
      status
        ?.querySelector("[data-slot=trace-title]")
        ?.className.includes("motion-reduce:shimmer-none"),
      status?.querySelector(".status-glyph") ?? null,
    ];
  };
  expect(await line({ state: "started", turn: T, phase: "thinking" })).toEqual([
    "status",
    "running",
    "tars-sprite wheel",
    true,
    null,
  ]);
  expect(await line({ state: "started", turn: T, phase: "waiting_approval" })).toEqual([
    "status",
    null,
    "tars-sprite idle",
    true,
    null,
  ]);
  expect(await line(undefined, true)).toEqual([
    "status",
    "running",
    "tars-sprite wheel",
    true,
    null,
  ]);
});

test("P3b: an open step's argv and output are not tab stops: they wrap, nothing to scroll", async () => {
  const { root } = await render(<Thread state={withOutput("一")} after={() => null} />);
  await act(async () => (root.querySelector(".tool-step-summary") as HTMLButtonElement).click());
  const pres = [...root.querySelectorAll(".tool-step-body pre")];
  expect(pres.map((p) => [p.getAttribute("tabindex"), p.hasAttribute("data-wrap")])).toEqual([
    ["-1", true],
    ["-1", true],
  ]);
});
