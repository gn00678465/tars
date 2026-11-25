// @vitest-environment jsdom
// Two or more cards from other conversations go behind a pager (M4-P4b): one shown at a time, the
// rest not in the page. Only the arrows change the card shown; a decision, a card that comes, a
// timer or a key do not. Each test here is an invariant of the brief (11–16) or of the design.
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const CONVS = ["conv-1", "conv-2", "conv-3", "conv-4", "conv-9"].map((id, i) => ({
  id,
  title: `對話 ${i + 1}`,
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  updatedAt: 1_000 - i,
}));

const request = (n: number, conv: string, effects = "read") =>
  server("approval.request", {
    approval: {
      approvalId: `approval-${n}`,
      conv,
      hash: String(n).repeat(64).slice(0, 64),
      action: "run_script",
      script: `s${n}`,
      version: "v1",
      summary: "做一件事",
      effects,
      domains: [],
      secret: null,
      argv: [],
      expiresAt: 600_000,
    },
  });

/** The page open on 對話 9, with cards from other conversations as `n` asks (1 → conv-1 …). */
async function dock(...ns: number[]) {
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  await act(async () => {
    h.last().receive(server("relay.status", { online: true }));
    h.last().receive(server("conv.list.result", { convs: CONVS }));
  });
  await act(async () =>
    (
      [...r.root.querySelectorAll<HTMLButtonElement>(".conv-item")].find((b) =>
        b.textContent?.startsWith("對話 5"),
      ) as HTMLButtonElement
    ).click(),
  );
  for (const n of ns) await act(async () => h.last().receive(request(n, `conv-${n}`)));
  const q = <T extends Element>(sel: string) => r.root.querySelector<T>(sel);
  const cards = () => [...r.root.querySelectorAll<HTMLElement>(".pinned-approvals .approval-card")];
  /** The scripts of the cards in the dock's page. */
  const inPage = () =>
    cards().map((c) => c.querySelector(".approval-field-val")?.textContent?.split(" @")[0]);
  const button = (which: "approve" | "deny") =>
    cards()[0]?.querySelectorAll<HTMLButtonElement>(".approval-actions button")[
      which === "deny" ? 0 : 1
    ];
  const press = (which: "approve" | "deny") =>
    act(async () => {
      const b = button(which);
      if (b === undefined) throw new Error(`no ${which} button`);
      b.click();
    });
  const arrow = (dir: "prev" | "next") => q<HTMLButtonElement>(`.pager-${dir}`);
  const go = (dir: "prev" | "next") => act(async () => arrow(dir)?.click());
  const decisions = () =>
    h
      .last()
      .messages()
      .filter((m) => m.kind === "approval.decide")
      .map((m) => {
        const p = m.p as { approvalId: string; decision: string };
        return `${p.decision}@${p.approvalId}`;
      });
  const resolve = (n: number, state = "approved") =>
    act(async () =>
      h
        .last()
        .receive(
          server("approval.resolved", { approvalId: `approval-${n}`, state, via: "remote" }),
        ),
    );
  const close = () =>
    act(async () => q<HTMLButtonElement>('.pinned-approvals button[aria-label="關閉"]')?.click());
  const meta = () => q(".pager-meta")?.textContent;
  return { h, ...r, q, cards, inPage, button, press, arrow, go, decisions, resolve, close, meta };
}

describe("one card from another conversation", () => {
  test("no pager: the card as before, its bar with the title and 關閉 after 跳至該對話", async () => {
    const t = await dock(1);
    expect(t.q(".pager")).toBeNull();
    expect(t.q(".pinned-approvals")?.classList.contains("paged")).toBe(false);
    expect(t.q(".approval-origin-title")?.textContent).toBe("對話 1");
    await t.press("deny");
    await t.resolve(1, "denied");
    const labels = [...t.cards()[0]!.querySelectorAll(".approval-origin-actions button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["跳至該對話", "關閉"]);
    t.unmount();
  });
});

describe("two or more: behind the pager", () => {
  test("one card in the page; the others' buttons are not there to press, focus or click (11)", async () => {
    const t = await dock(1, 2, 3);
    expect(t.inPage()).toEqual(["s1"]);
    const approve = [...t.root.querySelectorAll(".pinned-approvals button")].filter(
      (b) => b.textContent?.includes("核准執行") || b.textContent?.includes("拒絕"),
    );
    expect(approve).toHaveLength(2);
    expect(t.root.textContent).not.toContain("s2 @");
    expect(t.root.textContent).not.toContain("s3 @");
    t.unmount();
  });

  test("the header: a named group, 1/3, its state, arrows named with what waits that way", async () => {
    const t = await dock(1, 2, 3);
    expect(t.q('[role="group"]')?.getAttribute("aria-label")).toBe("待核准 1／3");
    expect(t.q(".pinned-head")?.textContent).toBe("其他對話的核准（3） · 共 3 張待核准");
    expect(t.meta()).toContain("1/3· 待核准");
    expect(t.arrow("prev")?.getAttribute("aria-label")).toBe("上一張待核准");
    expect(t.arrow("next")?.getAttribute("aria-label")).toBe(
      "下一張待核准（這個方向還有 2 張待核准）",
    );
    expect(t.arrow("next")?.querySelector(".pager-badge")?.textContent).toBe("2");
    // Not a tablist: no roles a screen reader would take for one.
    expect(t.q('[role="tablist"], [role="tab"]')).toBeNull();
    t.unmount();
  });

  test("the head's count is all those waiting: changing card leaves it, and it is not live", async () => {
    const t = await dock(1, 2, 3);
    await t.resolve(2);
    const head = () => t.q(".pinned-head")?.textContent;
    expect(head()).toBe("其他對話的核准（3） · 共 2 張待核准");
    await t.go("next");
    expect(head()).toBe("其他對話的核准（3） · 共 2 張待核准");
    // Only the pager's own line speaks on a change of card.
    expect(t.q(".pinned-head [aria-live], .pinned-head[aria-live]")).toBeNull();
    expect(t.root.querySelectorAll(".pinned-approvals [aria-live]")).toHaveLength(1);
    for (const n of [1, 3]) await t.resolve(n);
    expect(head()).toBe("其他對話的核准（3）");
    t.unmount();
  });

  test("decided, the card goes back to its top, where its × comes", async () => {
    const t = await dock(1, 2);
    const scroll = t.q(".pinned-scroll") as HTMLElement;
    scroll.scrollTop = 500;
    await t.press("approve");
    expect(scroll.scrollTop).toBe(0);
    t.unmount();
  });

  test("at the ends the arrow is off but focusable, and it does not wrap", async () => {
    const t = await dock(1, 2);
    const prev = t.arrow("prev") as HTMLButtonElement;
    expect(prev.getAttribute("aria-disabled")).toBe("true");
    expect(prev.disabled).toBe(false);
    prev.focus();
    expect(document.activeElement).toBe(prev);
    await t.go("prev");
    expect(t.inPage()).toEqual(["s1"]);
    await t.go("next");
    expect(t.inPage()).toEqual(["s2"]);
    expect(t.arrow("next")?.getAttribute("aria-disabled")).toBe("true");
    await t.go("next");
    expect(t.inPage()).toEqual(["s2"]);
    t.unmount();
  });

  test("a decision does not move on: the card stays, sent, then decided, with no buttons", async () => {
    const t = await dock(1, 2);
    await t.press("approve");
    expect(t.inPage()).toEqual(["s1"]);
    expect(t.meta()).toContain("1/2· 等待本機回應");
    await t.resolve(1);
    expect(t.inPage()).toEqual(["s1"]);
    expect(t.meta()).toContain("1/2· 已決定（已核准）");
    expect(t.button("approve")).toBeUndefined();
    expect(t.decisions()).toEqual(["approved@approval-1"]);
    t.unmount();
  });

  test("decided, the focus stays on that card's box, in no other card (12)", async () => {
    const t = await dock(1, 2);
    t.button("deny")?.focus();
    await t.press("deny");
    expect(document.activeElement?.classList.contains("pager-card")).toBe(true);
    expect(document.activeElement?.textContent).toContain("s1 @");
    // A second Enter on it presses nothing.
    await act(async () => (document.activeElement as HTMLElement).click());
    expect(t.decisions()).toEqual(["denied@approval-1"]);
    t.unmount();
  });

  test("Enter held on the first's deny: only it is decided, and the focus goes to no button", async () => {
    const t = await dock(1, 2);
    t.button("deny")?.focus();
    for (let i = 0; i < 45; i++) {
      await act(async () => t.h.advance(33));
      await act(async () => (document.activeElement as HTMLElement).click());
    }
    expect(t.decisions()).toEqual(["denied@approval-1"]);
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
    t.unmount();
  });

  test("neither a card shown by an arrow nor one that comes takes the focus (12)", async () => {
    const t = await dock(1, 2);
    const next = t.arrow("next") as HTMLButtonElement;
    next.focus();
    await t.go("next");
    expect(document.activeElement).toBe(next);
    await act(async () => t.h.last().receive(request(3, "conv-3")));
    expect(document.activeElement).toBe(next);
    t.unmount();
  });

  test("one decided, then › : the next card's deny does not take the focus, which stays on › (12)", async () => {
    const t = await dock(1, 2);
    await t.press("deny");
    const next = t.arrow("next") as HTMLButtonElement;
    next.focus();
    await t.go("next");
    expect(t.inPage()).toEqual(["s2"]);
    expect(document.activeElement).toBe(next);
    t.unmount();
  });

  test("the first decided elsewhere, then › : the next card's deny does not take the focus (12)", async () => {
    // Held, Enter on › would change the card and then deny the one changed to, unread.
    const t = await dock(1, 2);
    await t.resolve(1, "denied");
    const next = t.arrow("next") as HTMLButtonElement;
    next.focus();
    await t.go("next");
    expect(t.inPage()).toEqual(["s2"]);
    expect(document.activeElement).toBe(next);
    t.unmount();
  });

  test("decided behind the pager, a card waiting in the thread does not take the focus (12)", async () => {
    const t = await dock(1, 2);
    await act(async () => t.h.last().receive(request(9, "conv-9")));
    expect(document.activeElement?.closest(".thread-scroll")).not.toBeNull();
    t.button("deny")?.focus();
    await t.press("deny");
    expect(document.activeElement?.classList.contains("pager-card")).toBe(true);
    t.unmount();
  });

  test("a card that comes does not change the one shown; its count does (15)", async () => {
    const t = await dock(1, 2);
    await t.go("next");
    await act(async () => t.h.last().receive(request(3, "conv-3")));
    expect(t.inPage()).toEqual(["s2"]);
    expect(t.meta()).toContain("2/3");
    expect(t.arrow("next")?.querySelector(".pager-badge")?.textContent).toBe("1");
    t.unmount();
  });

  test("decided elsewhere, or expired, the card shown stays shown (15)", async () => {
    const t = await dock(1, 2, 3);
    await t.resolve(1, "approved");
    expect(t.inPage()).toEqual(["s1"]);
    await t.resolve(1, "expired");
    expect(t.inPage()).toEqual(["s1"]);
    t.unmount();
  });

  test("a timer does not change the card shown", async () => {
    const t = await dock(1, 2);
    await act(async () => t.h.advance(120_000));
    expect(t.inPage()).toEqual(["s1"]);
    t.unmount();
  });

  test("arrow keys on the page or on the pager do not change the card", async () => {
    const t = await dock(1, 2);
    for (const target of [document.body, t.q(".pager") as HTMLElement, t.arrow("next")!])
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "PageDown"]) {
        await act(
          async () =>
            void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
        );
        expect(t.inPage(), key).toEqual(["s1"]);
      }
    t.unmount();
  });

  test("changed to, a card starts at its top", async () => {
    const t = await dock(1, 2);
    const scroll = t.q(".pinned-scroll") as HTMLElement;
    scroll.scrollTop = 400;
    await t.go("next");
    expect(scroll.scrollTop).toBe(0);
    t.unmount();
  });

  test("the time window stays: another card's decision 1000 ms after one is sent (14)", async () => {
    for (const gap of [0, 300, 999]) {
      const t = await dock(1, 2);
      await t.press("approve");
      await t.go("next");
      await act(async () => t.h.advance(gap));
      await t.press("approve");
      expect(t.decisions(), `${gap} ms`).toEqual(["approved@approval-1"]);
      // Nothing about it changed: still waiting.
      expect(t.meta()).toContain("2/2· 待核准");
      t.unmount();
    }
    const t = await dock(1, 2);
    await t.press("approve");
    await t.go("next");
    await act(async () => t.h.advance(1_000));
    await t.press("approve");
    expect(t.decisions()).toEqual(["approved@approval-1", "approved@approval-2"]);
    t.unmount();
  });
});

describe("the card shown goes: which takes its place (15)", () => {
  test("closed: the next one waiting from its place, held 1000 ms as not chosen, the wait restarting", async () => {
    const t = await dock(1, 2, 3);
    await t.resolve(1);
    await act(async () => t.h.advance(5_000));
    await t.close();
    expect(t.inPage()).toEqual(["s2"]);
    await t.press("approve");
    expect(t.decisions()).toEqual([]);
    await act(async () => t.h.advance(999));
    await t.press("approve");
    expect(t.decisions()).toEqual([]);
    await act(async () => t.h.advance(1_000));
    await t.press("approve");
    expect(t.decisions()).toEqual(["approved@approval-2"]);
    t.unmount();
  });

  test("none waiting after it: the nearest one waiting before it", async () => {
    const t = await dock(1, 2, 3);
    await t.resolve(3);
    await t.go("next");
    await t.go("next");
    expect(t.inPage()).toEqual(["s3"]);
    await t.close();
    expect(t.inPage()).toEqual(["s2"]);
    t.unmount();
  });

  test("none waiting at all: the last one left", async () => {
    const t = await dock(1, 2, 3);
    for (const n of [1, 2, 3]) await t.resolve(n);
    await t.close();
    expect(t.inPage()).toEqual(["s3"]);
    t.unmount();
  });

  test("the store replaced (a new epoch): the dock empties; cards that come again start at the first", async () => {
    const t = await dock(1, 2);
    await t.go("next");
    await act(async () =>
      t.h
        .last()
        .receive(
          server("conv.snapshot", { epoch: "epoch-2", more: false, items: [] }, { conv: "conv-9" }),
        ),
    );
    expect(t.q(".pinned-approvals")).toBeNull();
    for (const n of [4, 1]) await act(async () => t.h.last().receive(request(n, `conv-${n}`)));
    expect(t.inPage()).toEqual(["s4"]);
    // Not held: it was shown as the dock came, not put in another's place.
    await t.press("deny");
    expect(t.decisions()).toEqual(["denied@approval-4"]);
    t.unmount();
  });
});

describe("held: each way a card is put before a hand that was pressing (pager_review.md 6)", () => {
  test("two, the first decided and closed: the one left, put there, is held 1000 ms (M4)", async () => {
    // Pressed on by keyboard, Enter on × then again would deny the one left, unread.
    const t = await dock(1, 2);
    await t.press("deny");
    await t.resolve(1, "denied");
    await act(async () => t.h.advance(5_000));
    await t.close();
    expect(t.q(".pager")).toBeNull();
    expect(t.inPage()).toEqual(["s2"]);
    await t.press("deny");
    await act(async () => t.h.advance(999));
    await t.press("deny");
    expect(t.decisions()).toEqual(["denied@approval-1"]);
    await act(async () => t.h.advance(1_000));
    await t.press("deny");
    expect(t.decisions()).toEqual(["denied@approval-1", "denied@approval-2"]);
    t.unmount();
  });

  test("a card put there, pressed at 600 ms and again at 1100 ms: the wait starts again, not sent (M5)", async () => {
    const t = await dock(1, 2, 3);
    await t.resolve(1);
    await act(async () => t.h.advance(5_000));
    await t.close();
    expect(t.inPage()).toEqual(["s2"]);
    await act(async () => t.h.advance(600));
    await t.press("approve");
    await act(async () => t.h.advance(500));
    await t.press("approve");
    expect(t.decisions()).toEqual([]);
    t.unmount();
  });

  test("decided, then › : another card pressed at 600 ms and at 1100 ms is not sent (M11)", async () => {
    const t = await dock(1, 2);
    await t.press("approve");
    await t.go("next");
    await act(async () => t.h.advance(600));
    await t.press("approve");
    await act(async () => t.h.advance(500));
    await t.press("approve");
    expect(t.decisions()).toEqual(["approved@approval-1"]);
    t.unmount();
  });

  test("a decision not sent (the connection gone) moves no focus (M10)", async () => {
    const t = await dock(1, 2);
    const approve = t.button("approve") as HTMLButtonElement;
    // Taken while it is pressable: once the connection goes the buttons are off.
    const key = Object.keys(approve).find((k) => k.startsWith("__reactProps"));
    const onClick = (approve as unknown as Record<string, { onClick?: (e: unknown) => void }>)[
      key ?? ""
    ]?.onClick;
    expect(onClick).toBeTypeOf("function");
    approve.focus();
    await act(async () => t.h.last().end(1006));
    await act(async () =>
      onClick?.({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: approve }),
    );
    expect(t.decisions()).toEqual([]);
    expect(document.activeElement?.classList.contains("pager-card")).toBe(false);
    t.unmount();
  });
});

describe("the focus does not drop to the page (pager_review.md 2)", () => {
  test("× on a decided card, two left: the focus goes to the box of the one put there", async () => {
    const t = await dock(1, 2, 3);
    await t.press("deny");
    await t.resolve(1, "denied");
    const shut = t.q<HTMLButtonElement>('.pinned-approvals button[aria-label="關閉"]');
    shut?.focus();
    expect(document.activeElement).toBe(shut);
    await t.close();
    expect(t.inPage()).toEqual(["s2"]);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.classList.contains("pager-card")).toBe(true);
    expect(document.activeElement?.textContent).toContain("s2 @");
    t.unmount();
  });

  test("the card shown decided elsewhere, its deny focused: the focus goes to its box", async () => {
    const t = await dock(1, 2);
    t.button("deny")?.focus();
    await t.resolve(1, "approved");
    expect(t.button("deny")).toBeUndefined();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.classList.contains("pager-card")).toBe(true);
    t.unmount();
  });

  test("the focus elsewhere (the composer): a card closed or decided there does not take it", async () => {
    const t = await dock(1, 2, 3);
    await t.resolve(1);
    const area = t.q<HTMLTextAreaElement>("textarea");
    area?.focus();
    await t.close();
    await t.resolve(2);
    expect(document.activeElement).toBe(area);
    t.unmount();
  });
});

describe("what a screen reader is told (16)", () => {
  test("a card that comes is announced as before; changing card says which, once", async () => {
    const t = await dock(1);
    const alert = () => document.querySelector('[role="alert"]')?.textContent;
    await act(async () => t.h.last().receive(request(2, "conv-2")));
    expect(alert()).toContain("s2");
    const said = () => t.q('.pinned-approvals .sr-only[aria-live="polite"]')?.textContent;
    expect(said()).toBe("");
    await t.go("next");
    expect(said()).toBe("第 2 張，共 2 張：對話 2，s2，待核准");
    await act(async () => t.h.last().receive(request(3, "conv-3")));
    expect(said()).toBe("第 2 張，共 2 張：對話 2，s2，待核准");
    t.unmount();
  });

  test("one not shown that comes says where it is, and names no focus: Enter would decide the one shown", async () => {
    const t = await dock(1);
    const alert = () => document.querySelector('[role="alert"]')?.textContent;
    // One pinned: as before.
    expect(alert()).toBe("需要核准：執行腳本 s1，影響read，不連線。預設焦點在拒絕按鈕。");
    await act(async () => t.h.last().receive(request(2, "conv-2", "external-write")));
    expect(alert()).toBe(
      "另有一張待核准（第 2 張，共 2 張）：執行腳本 s2，影響寫外部，不連線。按下一張查看。",
    );
    expect(alert()).not.toContain("焦點");
    await t.go("next");
    await act(async () => t.h.last().receive(request(3, "conv-3")));
    expect(alert()).toContain("另有一張待核准（第 3 張，共 3 張）");
    t.unmount();
  });

  test("a card of the conversation open, behind the pager or not, is announced as before", async () => {
    const t = await dock(1, 2);
    await act(async () => t.h.last().receive(request(9, "conv-9")));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "需要核准：執行腳本 s9，影響read，不連線。預設焦點在拒絕按鈕。",
    );
    t.unmount();
  });
});

test("the decision of a card not shown is not sent, whoever calls it (11)", async () => {
  // The buttons of a card not shown are not in the page; App's decide also refuses it, should a
  // stale handler be called. Reached here through the shown card's own handler, kept and called
  // after another card is shown.
  const t = await dock(1, 2);
  const stale = t.button("approve") as HTMLButtonElement;
  // Taken while it is in the page: React drops it from the node once the card goes.
  const key = Object.keys(stale).find((k) => k.startsWith("__reactProps"));
  const onClick = (stale as unknown as Record<string, { onClick?: (e: unknown) => void }>)[
    key ?? ""
  ]?.onClick;
  expect(onClick).toBeTypeOf("function");
  await t.go("next");
  expect(stale.isConnected).toBe(false);
  await act(async () =>
    onClick?.({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: stale }),
  );
  expect(t.decisions()).toEqual([]);
  t.unmount();
});
