// @vitest-environment jsdom
import type { WireApproval } from "@tars/protocol";
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { button, render } from "../render.ts";
import type { Card } from "../state.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const approval: WireApproval = {
  approvalId: "01a1fd71-be41-71e7-809a-4bb1e56800aa",
  conv: "conv-1",
  hash: "0123456789abcdef".repeat(4),
  action: "run_script",
  script: "push",
  version: "v1",
  summary: "推播一則通知",
  effects: "external-write",
  domains: ["api.example.com", "*"],
  secret: "bark",
  argv: ["--text", "<script>alert(1)</script>"],
  expiresAt: 1_800_000_600_000,
};

const card = (over: Partial<Card> = {}): Card => ({ approval, ...over });

test("the nine fields, as text", async () => {
  const { root } = await render(
    <ApprovalCard card={card()} localNow={1_800_000_000_000} onDecide={() => undefined} />,
  );
  const labels = [...root.querySelectorAll("dt")].map((d) => d.textContent);
  expect(labels).toEqual([
    "動作",
    "對象",
    "內容",
    "腳本說明",
    "影響",
    "連線對象",
    "用到的金鑰",
    "到期時間",
    "核准編號、雜湊前 8 碼",
  ]);
  const values = [...root.querySelectorAll("dd")].map((d) => d.textContent);
  expect(values[0]).toBe("執行腳本");
  expect(values[1]).toBe("push（版本 v1）");
  expect(values[2]).toBe("--text <script>alert(1)</script>");
  expect(values[3]).toBe("推播一則通知");
  expect(values[4]).toBe("寫外部");
  expect(values[5]).toBe("api.example.com、任意主機");
  expect(values[6]).toBe("bark");
  expect(values[7]).toContain("剩 10 分 0 秒");
  expect(values[8]).toBe("e56800aa、01234567");
  // The argv's markup stays text: no element was made from it.
  expect(root.querySelector("script")).toBeNull();
});

test("no secret and no domains read 無", async () => {
  const { root } = await render(
    <ApprovalCard
      card={{ approval: { ...approval, secret: null, domains: [] } }}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  const values = [...root.querySelectorAll("dd")].map((d) => d.textContent);
  expect(values[5]).toBe("無");
  expect(values[6]).toBe("無");
  expect(values[7]).not.toContain("剩");
});

test("deny has the focus, and comes first", async () => {
  const { root } = await render(
    <ApprovalCard card={card()} localNow={undefined} onDecide={() => undefined} />,
  );
  expect(document.activeElement).toBe(button(root, "拒絕"));
  expect([...root.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["拒絕", "核准"]);
});

test("a click decides; once deciding or resolved, both buttons are off", async () => {
  const decided: string[] = [];
  const { root, rerender } = await render(
    <ApprovalCard card={card()} localNow={undefined} onDecide={(d) => decided.push(d)} />,
  );
  await act(async () => button(root, "核准").click());
  expect(decided).toEqual(["approved"]);
  await rerender(
    <ApprovalCard
      card={card({ deciding: "m1" })}
      localNow={undefined}
      onDecide={(d) => decided.push(d)}
    />,
  );
  expect(button(root, "核准").disabled).toBe(true);
  expect(button(root, "拒絕").disabled).toBe(true);
  await rerender(
    <ApprovalCard
      card={card({ resolved: { state: "approved", here: false } })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  expect(button(root, "核准").disabled).toBe(true);
  expect(root.textContent).toContain("已核准（在別處決定）");
});
