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
