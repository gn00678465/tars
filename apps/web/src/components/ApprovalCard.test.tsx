// @vitest-environment jsdom
import type { WireApproval } from "@tars/protocol";
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { button, render } from "../render.ts";
import type { Card } from "../state.ts";
import { ApprovalCard, announceText } from "./ApprovalCard.tsx";

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
const args = (root: HTMLElement) =>
  [...root.querySelectorAll("ol.argv li")].map((li) => li.textContent);

test("the nine fields, as text, in the prototype's two parts", async () => {
  const { root } = await render(
    <ApprovalCard card={card()} localNow={1_800_000_000_000} onDecide={() => undefined} />,
  );
  expect(root.querySelector(".approval-head-title")?.textContent).toContain("執行腳本");
  const labels = [...root.querySelectorAll("dt")].map((d) => d.textContent);
  expect(labels).toEqual([
    "對象與版本",
    "影響範圍",
    "腳本說明",
    "連線對象",
    "用到的金鑰",
    "內容",
    "核准編號、雜湊前 8 碼",
    "鍵盤",
  ]);
  const values = [...root.querySelectorAll("dd")].map((d) => d.textContent);
  expect(values[0]).toBe("push @ v1");
  expect(values[1]).toBe("寫外部（高風險）");
  expect(root.querySelector(".approval-field-val .sg-tag")?.className).toBe("sg-tag warn");
  expect(values[2]).toBe("推播一則通知");
  expect(values[3]).toBe("api.example.com、任意主機（*）");
  const hosts = root.querySelectorAll(".approval-field")[3]?.querySelectorAll("dd > span > span");
  expect([...(hosts ?? [])].map((e) => e.className)).toEqual(["mono", "sg-tag warn"]);
  expect(values[4]).toBe("bark");
  expect(args(root)).toEqual(['"--text"', '"<script>alert(1)</script>"']);
  // As the prototype: the countdown in the head, the ids with their names.
  expect(root.querySelector(".approval-countdown")?.textContent).toBe("剩餘 10:00");
  expect(values[6]).toBe("核准 #e56800aa · sha256: 01234567");
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
  expect(values[3]).toBe("無");
  expect(values[4]).toBe("無");
  expect(values[6]).not.toContain("剩");
});

const DENY = "拒絕（預設）";
const APPROVE = "確認核准寫外部";

test("deny has the focus, and comes first", async () => {
  const { root } = await render(
    <ApprovalCard card={card()} localNow={undefined} onDecide={() => undefined} />,
  );
  expect(document.activeElement).toBe(button(root, DENY));
  expect([...root.querySelectorAll("button")].map((b) => b.textContent)).toEqual([DENY, APPROVE]);
});

test("a read-only script's approve button says so plainly", async () => {
  const { root } = await render(
    <ApprovalCard
      card={card({ approval: { ...approval, effects: "read-only" } })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  expect(button(root, "核准執行").className).toContain("sg-btn-approve");
});

test("a click decides; while deciding both buttons are off; decided, the outcome replaces them", async () => {
  const decided: string[] = [];
  const { root, rerender } = await render(
    <ApprovalCard card={card()} localNow={undefined} onDecide={(d) => decided.push(d)} />,
  );
  await act(async () => button(root, APPROVE).click());
  expect(decided).toEqual(["approved"]);
  await rerender(
    <ApprovalCard
      card={card({ deciding: "m1" })}
      localNow={undefined}
      onDecide={(d) => decided.push(d)}
    />,
  );
  expect(button(root, "等待本機回應…").disabled).toBe(true);
  expect(button(root, DENY).disabled).toBe(true);
  await rerender(
    <ApprovalCard
      card={card({ resolved: { state: "approved", here: false } })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  expect(root.querySelectorAll("button")).toHaveLength(0);
  expect(root.textContent).toContain("已核准（在別處決定）");
});

test("each argument on its own: where one ends is visible", async () => {
  const one = await render(
    <ApprovalCard
      card={card({ approval: { ...approval, argv: ["send", "--to", "alice --amount 100"] } })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  const many = await render(
    <ApprovalCard
      card={card({
        approval: { ...approval, argv: ["send", "--to", "alice", "--amount", "100"] },
      })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  expect(args(one.root)).toEqual(['"send"', '"--to"', '"alice --amount 100"']);
  expect(args(many.root)).toEqual(['"send"', '"--to"', '"alice"', '"--amount"', '"100"']);
});

test("empty, blank and invisible characters are spelled out", async () => {
  const { root } = await render(
    <ApprovalCard
      card={card({
        approval: {
          ...approval,
          argv: [
            "",
            " ",
            "a\nb",
            'say "hi"',
            "x\u200by",
            "\u202eevil",
            "\u00a0",
            "\u0085",
            "\u{e0041}",
          ],
        },
      })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  expect(args(root)).toEqual([
    '""',
    '" "',
    '"a\\nb"',
    '"say \\"hi\\""',
    '"x\\u200by"',
    '"\\u202eevil"',
    '"\\u00a0"',
    '"\\u0085"',
    '"\\u{e0041}"',
  ]);
});

test("combining marks and variation selectors are spelled out, so look-alikes differ", async () => {
  const { root } = await render(
    <ApprovalCard
      card={card({
        approval: {
          ...approval,
          argv: [
            "\u00e9",
            "e\u0301",
            "\u2764",
            "\u2764\ufe0f",
            "a\u1ab0\u1dc0\u20d0\ufe20",
            "x\u{e0100}",
          ],
        },
      })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  expect(args(root)).toEqual([
    '"\u00e9"',
    '"e\\u0301"',
    '"\u2764"',
    '"\u2764\\ufe0f"',
    '"a\\u1ab0\\u1dc0\\u20d0\\ufe20"',
    '"x\\u{e0100}"',
  ]);
});

test("long arguments, quotes and backslashes: one numbered item each, escaped as before", async () => {
  const long = "x".repeat(300);
  const { root } = await render(
    <ApprovalCard
      card={card({ approval: { ...approval, argv: [long, 'say "hi"', "C:\\dir\\file", "--"] } })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  const list = root.querySelector("ol.argv") as HTMLOListElement;
  expect(list.children).toHaveLength(4);
  expect(args(root)).toEqual([`"${long}"`, '"say \\"hi\\""', '"C:\\\\dir\\\\file"', '"--"']);
});

test("offline: both buttons are off and the card says why", async () => {
  const { root } = await render(
    <ApprovalCard
      card={card()}
      localNow={undefined}
      blocked="離線，無法送出決定"
      onDecide={() => undefined}
    />,
  );
  expect(button(root, DENY).disabled).toBe(true);
  expect(button(root, APPROVE).disabled).toBe(true);
  expect(root.textContent).toContain("離線，無法送出決定");
});

test("acked, waiting for the result: both buttons stay off", async () => {
  const { root } = await render(
    <ApprovalCard card={card({ acked: true })} localNow={undefined} onDecide={() => undefined} />,
  );
  expect(button(root, DENY).disabled).toBe(true);
  expect(button(root, "等待結果…").disabled).toBe(true);
});

test("a card told not to take the focus leaves it where it is", async () => {
  const { root } = await render(
    <ApprovalCard card={card()} focus={false} localNow={undefined} onDecide={() => undefined} />,
  );
  expect(document.activeElement).not.toBe(button(root, DENY));
});

test("after a drop only the same decision can go again, and the card says why", async () => {
  const { root } = await render(
    <ApprovalCard
      card={card({
        lost: true,
        choice: "approved",
        error: "連線曾中斷，決定可能沒有送達；可以再按一次",
      })}
      localNow={undefined}
      onDecide={() => undefined}
    />,
  );
  expect(button(root, DENY).disabled).toBe(true);
  expect(button(root, APPROVE).disabled).toBe(false);
  expect(root.textContent).toContain("你剛才選的是「核准」，連線中斷後沒有收到結果");
});

test("acked and no result for 15 s: the card says to reload, buttons still off", async () => {
  const at = (pageNow: number) =>
    render(
      <ApprovalCard
        card={card({ acked: true, ackedAt: 1000 })}
        pageNow={pageNow}
        localNow={undefined}
        onDecide={() => undefined}
      />,
    );
  const early = await at(15_000);
  expect(early.root.textContent).not.toContain("還沒收到結果");
  early.unmount();
  const late = await at(16_001);
  expect(late.root.querySelector("[role=status]")?.textContent).toContain(
    "還沒收到結果。腳本可能已執行或已被拒絕，請重新整理頁面確認",
  );
  expect(button(late.root, DENY).disabled).toBe(true);
});

test("decided: no countdown, only the result and the two ids; timed out says 已過期", async () => {
  const at = (state: "approved" | "expired") =>
    render(
      <ApprovalCard
        card={card({ resolved: { state, here: true } })}
        localNow={approval.expiresAt - 576_000}
        onDecide={() => undefined}
      />,
    );
  const done = await at("approved");
  expect(done.root.textContent).not.toContain("到期");
  expect(done.root.textContent).not.toContain("剩");
  expect(done.root.querySelector(".approval-ids")?.textContent).toBe(
    `核准 #${approval.approvalId.slice(-8)} · sha256: ${approval.hash.slice(0, 8)}`,
  );
  done.unmount();
  const late = await at("expired");
  expect(late.root.querySelector(".approval-head .sg-tag")?.textContent).toContain("已過期");
  expect(late.root.textContent).not.toContain("剩");
  late.unmount();
});

test("waiting: the countdown is shown", async () => {
  const { root } = await render(
    <ApprovalCard
      card={card()}
      localNow={approval.expiresAt - 576_000}
      onDecide={() => undefined}
    />,
  );
  expect(root.querySelector(".approval-countdown")?.textContent).toBe("剩餘 09:36");
});

test("without the page's clock: no countdown, the time it expires instead", async () => {
  const { root } = await render(
    <ApprovalCard card={card()} localNow={undefined} onDecide={() => undefined} />,
  );
  expect(root.querySelector(".approval-countdown")).toBeNull();
  expect(root.querySelector(".approval-foot .compaction-meta")?.textContent).toMatch(/^到期 /);
});

test("read-only and local-write are plain tags, without （高風險）", async () => {
  for (const [effects, text] of [
    ["read-only", "只讀"],
    ["local-write", "寫本機"],
  ] as const) {
    const { root, unmount } = await render(
      <ApprovalCard
        card={card({ approval: { ...approval, effects } })}
        localNow={1_800_000_000_000}
        onDecide={() => undefined}
      />,
    );
    const tag = root.querySelector(".approval-field-val .sg-tag") as HTMLElement;
    expect([tag.className, tag.textContent]).toEqual(["sg-tag", text]);
    unmount();
  }
});

test("a region named as the prototype's; waiting, it says how the keyboard works", async () => {
  const waiting = await render(
    <ApprovalCard card={card()} localNow={1_800_000_000_000} onDecide={() => undefined} />,
  );
  const region = waiting.root.querySelector("article") as HTMLElement;
  expect([region.getAttribute("role"), region.getAttribute("aria-label")]).toEqual([
    "region",
    "腳本執行核准卡",
  ]);
  expect(region.textContent).toContain("無單鍵快捷鍵 · 預設焦點在拒絕");
  waiting.unmount();
  const decided = await render(
    <ApprovalCard
      card={card({ resolved: { state: "approved", here: true } })}
      localNow={1_800_000_000_000}
      onDecide={() => undefined}
    />,
  );
  expect(decided.root.textContent).not.toContain("無單鍵快捷鍵");
});

test("the announcement: script, effect and where it connects, and where the focus is", () => {
  expect(announceText(approval)).toBe(
    "需要核准：執行腳本 push，影響寫外部，連線 api.example.com、任意主機。預設焦點在拒絕按鈕。",
  );
  expect(announceText({ ...approval, effects: "read-only", domains: [] })).toBe(
    "需要核准：執行腳本 push，影響只讀，不連線。預設焦點在拒絕按鈕。",
  );
  expect(announceText({ ...approval, domains: ["*"] })).toBe(
    "需要核准：執行腳本 push，影響寫外部，連線任意主機。預設焦點在拒絕按鈕。",
  );
});
