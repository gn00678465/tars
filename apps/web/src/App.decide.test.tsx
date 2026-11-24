// @vitest-environment jsdom
// Two cards waiting: a second press soon after the first must not decide the other card, which
// the user has not read. After the first decision the focus goes to the next card's deny button,
// and the browser scrolls that card's buttons to where the first card's were (p4_review.md 5, 6):
// the second click of a double click, or a second Enter, lands on the other card. jsdom lays
// nothing out, so the second press is sent to the button it would land on.
import { act } from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { App } from "./App.tsx";
import { render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const CONVS = ["conv-1", "conv-2", "conv-3"].map((id, i) => ({
  id,
  title: `對話 ${i + 1}`,
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  updatedAt: 1_000 - i,
}));

const request = (id: string, conv: string) =>
  server("approval.request", {
    approval: {
      approvalId: id,
      conv,
      hash: id.slice(-1).repeat(64),
      action: "run_script",
      script: `s-${id}`,
      version: "v1",
      summary: "做一件事",
      effects: "read",
      domains: [],
      secret: null,
      argv: [],
      expiresAt: 600_000,
    },
  });

/** Both cards in the pinned dock (from other conversations), or both in this thread. */
async function twoCards(layout: "pinned" | "thread") {
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
        b.textContent?.startsWith("對話 3"),
      ) as HTMLButtonElement
    ).click(),
  );
  const [a, b] = layout === "pinned" ? ["conv-1", "conv-2"] : ["conv-3", "conv-3"];
  await act(async () => {
    h.last().receive(request("approval-1", a));
    h.last().receive(request("approval-2", b));
  });
  const where = layout === "pinned" ? ".pinned-approvals" : ".thread-scroll";
  const cards = () => [...r.root.querySelectorAll<HTMLElement>(`${where} .approval-card`)];
  // Deny first, approve second, as the card draws them; a click on a disabled one does nothing.
  const press = (card: number, which: "approve" | "deny") =>
    act(async () => {
      const el = cards()[card];
      if (el === undefined) throw new Error(`no card ${card}`);
      const all = el.querySelectorAll<HTMLButtonElement>(".approval-actions button");
      const b = all[which === "deny" ? 0 : 1];
      if (b === undefined) throw new Error(`card ${card} has no ${which} button`);
      b.click();
    });
  const decisions = () =>
    h
      .last()
      .messages()
      .filter((m) => m.kind === "approval.decide")
      .map((m) => {
        const p = m.p as { approvalId: string; decision: string };
        return `${p.decision}@${p.approvalId}`;
      });
  const status = (card: number) => cards()[card]?.querySelector(".sg-tag")?.textContent;
  return { h, ...r, cards, press, decisions, status };
}

describe.each(["pinned", "thread"] as const)("two cards waiting, %s", (layout) => {
  test("two cards are drawn there, and the first decided moves the focus to the second", async () => {
    const t = await twoCards(layout);
    expect(t.cards()).toHaveLength(2);
    await t.press(0, "deny");
    expect(t.cards()[1]?.contains(document.activeElement)).toBe(true);
    t.unmount();
  });

  test.each([0, 60, 150, 300, 699])(
    "a double click: the second, %i ms on, lands on the other card and is not sent",
    async (gap) => {
      const t = await twoCards(layout);
      await t.press(0, "approve");
      await act(async () => t.h.advance(gap));
      await t.press(1, "approve");
      expect(t.decisions()).toEqual(["approved@approval-1"]);
      // Nothing about the second card changed: it waits, and can be decided.
      expect(t.status(1)).toBe("等待核准");
      t.unmount();
    },
  );

  test("a second Enter goes to the focused button, the other card's deny: not sent", async () => {
    const t = await twoCards(layout);
    await t.press(0, "deny");
    await act(async () => t.h.advance(30));
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(t.decisions()).toEqual(["denied@approval-1"]);
    expect(t.status(1)).toBe("等待核准");
    t.unmount();
  });

  test("the press held back is not lost: 700 ms on, the other card's decision is sent", async () => {
    const t = await twoCards(layout);
    await t.press(0, "approve");
    await act(async () => t.h.advance(100));
    await t.press(1, "approve");
    await act(async () => t.h.advance(600));
    await t.press(1, "approve");
    expect(t.decisions()).toEqual(["approved@approval-1", "approved@approval-2"]);
    t.unmount();
  });

  test("the same card again, soon after, is not held back (a decision refused may go again)", async () => {
    const t = await twoCards(layout);
    await t.press(0, "approve");
    const sent = t.h
      .last()
      .messages()
      .findLast((m) => m.kind === "approval.decide");
    await act(async () =>
      t.h.last().receive({ ...server("nack", { reason: "busy" }), re: sent?.id }),
    );
    await act(async () => t.h.advance(100));
    await t.press(0, "approve");
    expect(t.decisions()).toEqual(["approved@approval-1", "approved@approval-1"]);
    t.unmount();
  });
});
