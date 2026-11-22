// @vitest-environment jsdom
import { skillInvocationText } from "@tars/protocol";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { button, buttons, render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

test("connects, asks for the list after hello, and shows what the relay says", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  expect(root.textContent).toContain("連線中");
  await act(async () => h.last().ready());
  expect(
    h
      .last()
      .messages()
      .map((m) => m.kind),
  ).toEqual(["hello", "conv.list", "models.get"]);
  await act(async () =>
    h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 })),
  );
  expect(root.querySelector(".conn-pill")?.textContent).toBe("在線");
  unmount();
});

test("a turn message missed across a reconnect: the resend's ack with the turn finishes the send", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  await act(async () =>
    h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 })),
  );
  const textarea = () => root.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => void h.socket.submit("你好"));
  expect(textarea().disabled).toBe(true);
  expect(root.querySelector(".composer .reason")?.textContent).toBe("送出中");
  await act(async () => {
    h.last().end(4000);
    await h.advance(0);
  });
  await act(async () => h.last().ready());
  const resend = h
    .last()
    .messages()
    .find((m) => m.kind === "turn.submit");
  await act(async () =>
    h.last().receive(server("ack", { turn: "turn-9" }, { re: resend?.id, conv: "conv-9" })),
  );
  expect(textarea().disabled).toBe(false);
  expect(root.querySelector(".composer .reason")).toBeNull();
  expect(
    h
      .last()
      .messages()
      .filter((m) => m.kind === "conv.open")
      .map((m) => m.conv),
  ).toEqual(["conv-9"]);
  unmount();
});

describe("an ack with the turn after a reconnect, in a conversation already open", () => {
  const convs = [
    { id: "conv-a", title: "對話甲", provider: "anthropic", model: "m", updatedAt: 1 },
    { id: "conv-b", title: "對話乙", provider: "anthropic", model: "m", updatedAt: 2 },
  ];

  const conv = (root: HTMLElement, title: string) =>
    buttons(root).find((b) => b.textContent?.includes(title) === true) as HTMLButtonElement;

  async function sentInA(h: ReturnType<typeof socketHarness>, root: HTMLElement) {
    await act(async () => h.last().ready());
    await act(async () => {
      h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 }));
      h.last().receive(server("conv.list.result", { convs }));
    });
    await act(async () => conv(root, "對話甲").click());
    await act(async () => void h.socket.submit("你好", "conv-a"));
  }

  async function reconnectAndAck(h: ReturnType<typeof socketHarness>) {
    await act(async () => {
      h.last().end(4000);
      await h.advance(0);
    });
    await act(async () => h.last().ready());
    const before = h
      .last()
      .messages()
      .filter((m) => m.kind === "conv.open")
      .map((m) => m.conv);
    const resend = h
      .last()
      .messages()
      .find((m) => m.kind === "turn.submit");
    await act(async () =>
      h.last().receive(server("ack", { turn: "turn-a" }, { re: resend?.id, conv: "conv-a" })),
    );
    const after = h
      .last()
      .messages()
      .filter((m) => m.kind === "conv.open")
      .map((m) => m.conv);
    return { before, after };
  }

  test("still on it: its snapshot is asked for again, after the ack", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await sentInA(h, root);
    const { before, after } = await reconnectAndAck(h);
    expect(before).toEqual(["conv-a"]);
    expect(after).toEqual(["conv-a", "conv-a"]);
    unmount();
  });

  test("moved to another conversation: no jump and no load of the first", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await sentInA(h, root);
    await act(async () => conv(root, "對話乙").click());
    const { before, after } = await reconnectAndAck(h);
    expect(before).toEqual(["conv-b"]);
    expect(after).toEqual(["conv-b"]);
    expect(conv(root, "對話乙").getAttribute("aria-current")).toBe("true");
    unmount();
  });
});

describe("the sidebar and the open conversation", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `conv-${i}`,
    title: `對話 ${i}`,
    provider: "anthropic",
    model: "m",
    updatedAt: 1000 - i,
  }));

  async function listed() {
    const h = socketHarness();
    const r = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    await act(async () => {
      h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 }));
      h.last().receive(server("conv.list.result", { convs: many }));
    });
    return { h, ...r };
  }
  const scroll = (root: HTMLElement) => root.querySelector(".thread-scroll") as HTMLElement;
  const entry = (root: HTMLElement, title: string) =>
    [...root.querySelectorAll<HTMLButtonElement>(".conv-item")].find(
      (b) => b.querySelector(".conv-title")?.textContent === title,
    ) as HTMLButtonElement;

  test("before the list arrives it is loading; then 新對話 comes before it", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    await act(async () => h.last().receive(server("relay.status", { online: true })));
    expect(root.querySelector(".conv-skeleton")).not.toBeNull();
    unmount();
    const l = await listed();
    expect(l.root.querySelector(".conv-skeleton")).toBeNull();
    const fresh = l.root.querySelector(".new-chat-btn") as HTMLElement;
    const first = entry(l.root, "對話 0");
    expect(fresh.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(l.root.querySelector(".empty-state h2")?.textContent).toBe("新對話");
    l.unmount();
  });

  test("opening one moves the focus to the thread and marks it in words and shape", async () => {
    const { root, unmount } = await listed();
    await act(async () => entry(root, "對話 30").click());
    expect(document.activeElement).toBe(scroll(root));
    const current = entry(root, "對話 30");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.className).toContain("active");
    expect(current.querySelector(".sg-tag")?.textContent).toBe("目前");
    expect(entry(root, "對話 31").querySelector(".sg-tag")).toBeNull();
    unmount();
  });

  test("新對話 clears the mark and shows the empty state", async () => {
    const { root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => (root.querySelector(".new-chat-btn") as HTMLButtonElement).click());
    expect(root.querySelector(".conv-item[aria-current]")).toBeNull();
    expect(root.querySelector(".empty-state")).not.toBeNull();
    unmount();
  });

  test("the local end offline: the list says why instead of listing", async () => {
    const { h, root, unmount } = await listed();
    await act(async () =>
      h.last().receive(server("relay.status", { online: false, lastSeenAt: 1 })),
    );
    expect(root.querySelector(".conv-offline-box")?.textContent).toContain("本機端離線");
    expect(root.querySelector(".conn-pill")?.textContent).toContain("本機端離線");
    unmount();
  });

  const request = (conv: string) =>
    server("approval.request", {
      approval: {
        approvalId: "approval-00000001",
        conv,
        hash: "a".repeat(64),
        action: "run_script",
        script: "push",
        version: "v1",
        summary: "推播",
        effects: "external-write",
        domains: [],
        secret: null,
        argv: [],
        expiresAt: 600_000,
      },
    });

  const resolved = (state: string) =>
    server("approval.resolved", {
      approvalId: "approval-00000001",
      state,
      via: "remote",
    });
  const pinnedCard = (root: HTMLElement) =>
    root.querySelector(".composer-dock .approval-card") as HTMLElement | null;

  test("decided on another device, a card from another conversation stays with its result until closed", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-2")));
    await act(async () => h.last().receive(resolved("denied")));
    const card = pinnedCard(root) as HTMLElement;
    expect(card.textContent).toContain("已拒絕（在別處決定）");
    expect(card.querySelector(".approval-origin-bar")?.textContent).toContain("對話 2");
    await act(async () =>
      buttons(card)
        .find((b) => b.textContent === "關閉")
        ?.click(),
    );
    expect(pinnedCard(root)).toBeNull();
    unmount();
  });

  test("decided here, it stays too, saying it was this device", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-2")));
    await act(async () =>
      buttons(pinnedCard(root) as HTMLElement)
        .find((b) => b.textContent === "確認核准寫外部")
        ?.click(),
    );
    const decide = h
      .last()
      .messages()
      .find((m) => m.kind === "approval.decide");
    await act(async () => h.last().receive(server("ack", {}, { re: decide?.id })));
    await act(async () => h.last().receive(resolved("approved")));
    const card = pinnedCard(root) as HTMLElement;
    expect(card.textContent).toContain("已核准");
    expect(card.textContent).not.toContain("在別處決定");
    unmount();
  });

  describe("approved, then the connection dropped before the ack", () => {
    const APPROVE = "確認核准寫外部";
    const pick = (root: HTMLElement, text: string) =>
      buttons(pinnedCard(root) as HTMLElement).find((b) => b.textContent?.startsWith(text));
    const sendApprove = async (h: ReturnType<typeof socketHarness>, root: HTMLElement) => {
      await act(async () => pick(root, APPROVE)?.click());
      return h
        .last()
        .messages()
        .filter((m) => m.kind === "approval.decide")
        .at(-1);
    };
    async function lostApprove() {
      const opened = await listed();
      const { h, root } = opened;
      await act(async () => entry(root, "對話 1").click());
      await act(async () => h.last().receive(request("conv-2")));
      await sendApprove(h, root);
      await act(async () => {
        h.last().end(4000);
        await h.advance(0);
      });
      await act(async () => h.last().ready());
      return opened;
    }

    test("resent, then already_decided: deny stays off, approve can go again", async () => {
      const { h, root, unmount } = await lostApprove();
      expect(pick(root, "拒絕")?.disabled).toBe(true);
      const again = await sendApprove(h, root);
      expect(again?.p).toMatchObject({ decision: "approved" });
      await act(async () =>
        h.last().receive(server("nack", { reason: "already_decided" }, { re: again?.id })),
      );
      expect(pick(root, "拒絕")?.disabled).toBe(true);
      expect(pick(root, APPROVE)?.disabled).toBe(false);
      expect(pinnedCard(root)?.textContent).toContain(
        "本機端已收到先前的決定，結果以本機為準；請重新整理確認",
      );
      unmount();
    });

    test("resent, then the same request again before the ack: deny stays off", async () => {
      const { h, root, unmount } = await lostApprove();
      await sendApprove(h, root);
      await act(async () => h.last().receive(request("conv-2")));
      expect(pick(root, "拒絕")?.disabled).toBe(true);
      expect(pick(root, APPROVE)?.disabled).toBe(false);
      expect(pinnedCard(root)?.textContent).toContain("你剛才選的是「核准」");
      unmount();
    });

    test("a nack saying it was not taken (hash_mismatch) frees both choices", async () => {
      const { h, root, unmount } = await lostApprove();
      const again = await sendApprove(h, root);
      await act(async () =>
        h.last().receive(server("nack", { reason: "hash_mismatch" }, { re: again?.id })),
      );
      expect(pick(root, "拒絕")?.disabled).toBe(false);
      expect(pick(root, APPROVE)?.disabled).toBe(false);
      expect(pinnedCard(root)?.textContent).not.toContain("你剛才選的是");
      unmount();
    });
  });

  describe("a card of this conversation sits under its tool call", () => {
    const T = "turn-00000001";
    const user = { seq: 1, turn: T, kind: "user", text: "記帳", truncated: false };
    const call = {
      seq: 2,
      turn: T,
      kind: "tool_call",
      callId: "call-00000001",
      name: "run_script",
      input: "{}",
      truncated: false,
    };
    const result = {
      seq: 3,
      turn: T,
      kind: "tool_result",
      callId: "call-00000001",
      status: "ok",
      text: "done",
      truncated: false,
    };
    const reply = {
      seq: 4,
      turn: T,
      kind: "assistant",
      text: "試跑成功",
      truncated: false,
      state: "complete",
    };
    const item = (i: object) => server("item", { item: i }, { conv: "conv-1" });
    const order = (root: HTMLElement) =>
      [
        ...root.querySelectorAll(
          ".thread-scroll .tool-step, .thread-scroll .approval-card, .thread-scroll .msg-assistant-text",
        ),
      ].map((e) =>
        e.classList.contains("tool-step")
          ? `tool:${e.querySelector(".sg-tag")?.textContent}`
          : e.classList.contains("approval-card")
            ? "card"
            : e.textContent,
      );
    async function decidedThenReply(callId: string | undefined) {
      const opened = await listed();
      const { h, root } = opened;
      await act(async () => entry(root, "對話 1").click());
      await act(async () =>
        h
          .last()
          .receive(
            server(
              "conv.snapshot",
              { epoch: "epoch-1", more: false, items: [user, call] },
              { conv: "conv-1" },
            ),
          ),
      );
      const req = request("conv-1") as { p: { approval: Record<string, unknown> } };
      await act(async () =>
        h.last().receive({
          ...req,
          p: { approval: { ...req.p.approval, ...(callId === undefined ? {} : { callId }) } },
        } as typeof req),
      );
      await act(async () => h.last().receive(resolved("approved")));
      await act(async () => h.last().receive(item(result)));
      await act(async () => h.last().receive(item(reply)));
      return opened;
    }

    test("by callId: tool row (with its result), the card, then the reply", async () => {
      const { root, unmount } = await decidedThenReply("call-00000001");
      expect(order(root)).toEqual(["tool:完成", "card", "試跑成功"]);
      unmount();
    });

    test("without callId (an older local end): after the item last when it came", async () => {
      const { root, unmount } = await decidedThenReply(undefined);
      expect(order(root)).toEqual(["tool:完成", "card", "試跑成功"]);
      unmount();
    });

    test("at the bottom, what comes is followed; scrolled up, it is left alone", async () => {
      const { h, root, unmount } = await listed();
      await act(async () => entry(root, "對話 1").click());
      const el = scroll(root);
      let height = 500;
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
      Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
      await act(async () =>
        h
          .last()
          .receive(
            server(
              "conv.snapshot",
              { epoch: "epoch-1", more: false, items: [user, call] },
              { conv: "conv-1" },
            ),
          ),
      );
      expect(el.scrollTop).toBe(500);
      height = 800;
      await act(async () => h.last().receive(item(result)));
      expect(el.scrollTop).toBe(800);
      // Scrolled up to read: nothing pulls it down.
      el.scrollTop = 100;
      await act(async () => el.dispatchEvent(new Event("scroll")));
      height = 900;
      await act(async () => h.last().receive(item(reply)));
      expect(el.scrollTop).toBe(100);
      unmount();
    });
  });

  test("offline: the card's buttons are off and say why", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-1")));
    await act(async () => h.last().receive(server("relay.status", { online: false })));
    const card = root.querySelector(".approval-card") as HTMLElement;
    expect(buttons(card).every((b) => b.disabled)).toBe(true);
    expect(card.textContent).toContain("離線，無法送出決定");
    unmount();
  });

  test("a decision the socket could not send: an error, not 送出中", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-1")));
    h.socket.send = () => undefined;
    const card = root.querySelector(".approval-card") as HTMLElement;
    await act(async () =>
      buttons(card)
        .find((b) => b.textContent === "拒絕（預設）")
        ?.click(),
    );
    expect(card.textContent).toContain("連線中斷，決定沒有送出");
    expect(card.textContent).not.toContain("送出決定中");
    expect(buttons(card).find((b) => b.textContent === "拒絕（預設）")?.disabled).toBe(false);
    unmount();
  });

  test("the reconnection warning sits outside the thread, closes, and a new one shows again", async () => {
    const { h, root, unmount } = await listed();
    await act(async () =>
      h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_500_000 })),
    );
    const alert = () => root.querySelector(".reconnect-alert") as HTMLElement | null;
    expect(alert()?.getAttribute("role")).toBe("alert");
    expect(alert()?.closest(".thread-scroll")).toBeNull();
    await act(async () => buttons(alert() as HTMLElement)[0]?.click());
    expect(alert()).toBeNull();
    await act(async () =>
      h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_500_000 })),
    );
    expect(alert()).toBeNull();
    await act(async () =>
      h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_900_000 })),
    );
    expect(alert()).not.toBeNull();
    unmount();
  });

  const requestN = (n: number, conv: string) =>
    server("approval.request", {
      approval: {
        approvalId: `approval-0000000${n}`,
        conv,
        hash: "a".repeat(64),
        action: "run_script",
        script: `s${n}`,
        version: "v1",
        summary: "推播",
        effects: "external-write",
        domains: [],
        secret: null,
        argv: [],
        expiresAt: 600_000,
      },
    });
  const denyOf = (root: HTMLElement, script: string) =>
    [...root.querySelectorAll<HTMLElement>(".approval-card")]
      .find((c) => c.textContent?.includes(`${script}（版本`))
      ?.querySelector<HTMLButtonElement>(".sg-btn-danger");

  test("three waiting cards: only the oldest one's deny has the focus", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    for (const n of [2, 3, 4]) await act(async () => h.last().receive(requestN(n, `conv-${n}`)));
    expect(document.activeElement).toBe(denyOf(root, "s2"));
    unmount();
  });

  test("the focus moves on to the next card once the first is decided", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    for (const n of [2, 3]) await act(async () => h.last().receive(requestN(n, `conv-${n}`)));
    expect(document.activeElement).toBe(denyOf(root, "s2"));
    await act(async () =>
      h.last().receive(
        server("approval.resolved", {
          approvalId: "approval-00000002",
          state: "denied",
          via: "remote",
        }),
      ),
    );
    expect(document.activeElement).toBe(denyOf(root, "s3"));
    unmount();
  });

  test("in this conversation too, the one decided last stays though it came first", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    for (const n of [2, 3, 4, 5]) await act(async () => h.last().receive(requestN(n, "conv-1")));
    for (const n of [3, 4, 5, 2])
      await act(async () =>
        h.last().receive(
          server("approval.resolved", {
            approvalId: `approval-0000000${n}`,
            state: "approved",
            via: "remote",
          }),
        ),
      );
    const shown = [...root.querySelectorAll(".thread-scroll .approval-card")].map(
      (c) => c.querySelector(".approval-field-val")?.textContent,
    );
    expect(shown).toEqual(["s4（版本 v1）", "s5（版本 v1）", "s2（版本 v1）"]);
    unmount();
  });

  test("typing in the composer: a new card does not take the focus", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    const area = root.querySelector("textarea") as HTMLTextAreaElement;
    area.focus();
    await act(async () => h.last().receive(requestN(2, "conv-2")));
    expect(document.activeElement).toBe(area);
    unmount();
  });

  test("four decided elsewhere: the one decided last stays though it came first", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    for (const n of [2, 3, 4, 5]) await act(async () => h.last().receive(requestN(n, `conv-${n}`)));
    for (const n of [3, 4, 5, 2])
      await act(async () =>
        h.last().receive(
          server("approval.resolved", {
            approvalId: `approval-0000000${n}`,
            state: "approved",
            via: "remote",
          }),
        ),
      );
    const shown = [...root.querySelectorAll(".composer-dock .approval-card")].map(
      (c) => c.querySelector(".approval-field-val")?.textContent,
    );
    expect(shown).toEqual(["s4（版本 v1）", "s5（版本 v1）", "s2（版本 v1）"]);
    unmount();
  });

  test("a waiting card of this conversation is in the thread", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-1")));
    expect(root.querySelector(".thread-scroll .approval-card")).not.toBeNull();
    expect(root.querySelector(".composer-dock .approval-card")).toBeNull();
    unmount();
  });

  test("one from another conversation is pinned above the composer, says where, and jumps there", async () => {
    const { h, root, unmount } = await listed();
    await act(async () => entry(root, "對話 1").click());
    await act(async () => h.last().receive(request("conv-2")));
    const pinned = root.querySelector(".composer-dock .approval-card") as HTMLElement;
    expect(pinned.querySelector(".approval-origin-bar")?.textContent).toContain("對話 2");
    expect(entry(root, "對話 2").querySelector(".sg-tag.wait")?.textContent).toBe("待核准");
    await act(async () =>
      buttons(pinned)
        .find((b) => b.textContent === "跳至該對話")
        ?.click(),
    );
    expect(entry(root, "對話 2").getAttribute("aria-current")).toBe("true");
    expect(root.querySelector(".thread-scroll .approval-card")).not.toBeNull();
    unmount();
  });
});

test("spend says 本期 and 估 until status says the period and source; a table-priced turn is 估", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  await act(async () => {
    h.last().receive(server("relay.status", { online: true }));
    h.last().receive(
      server("status", {
        now: 1,
        providers: [
          {
            name: "anthropic",
            spentUsd: 1,
            quotaUsd: 100,
            warnUsd: 80,
            stopUsd: 95,
            stopped: false,
          },
          {
            name: "openrouter",
            spentUsd: 1,
            quotaUsd: 10,
            warnUsd: 8,
            stopUsd: 9.5,
            stopped: false,
          },
        ],
        pricesWarn: false,
        pendingApprovals: 0,
        turnRunning: false,
        notify: "ok",
      }),
    );
    h.last().receive(
      server("conv.list.result", {
        convs: [{ id: "conv-1", title: "甲", provider: "anthropic", model: "m", updatedAt: 1 }],
      }),
    );
  });
  await act(async () => (root.querySelector(".topbar-right .sg-btn") as HTMLButtonElement).click());
  const sheet = root.querySelector(".sheet-panel") as HTMLElement;
  expect(sheet.textContent).not.toMatch(/本月|累計/);
  expect(sheet.textContent?.match(/本期 1\.00 \/ [0-9,]+ USD 估/g)).toHaveLength(2);
  await act(async () => (root.querySelector(".conv-item") as HTMLButtonElement).click());
  const usage = (costSource: string) => ({
    seq: 2,
    turn: "t",
    kind: "usage",
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.01,
    costSource,
  });
  await act(async () =>
    h
      .last()
      .receive(
        server(
          "conv.snapshot",
          { epoch: "epoch-1", more: false, items: [usage("table")] },
          { conv: "conv-1" },
        ),
      ),
  );
  expect(root.querySelector(".msg-usage-line")?.textContent).toContain("USD 估");
  await act(async () =>
    h
      .last()
      .receive(
        server(
          "conv.snapshot",
          { epoch: "epoch-1", more: false, items: [usage("provider")] },
          { conv: "conv-1" },
        ),
      ),
  );
  expect(root.querySelector(".msg-usage-line")?.textContent).not.toContain("估");
  unmount();
});

describe("the / menu and the certificate, from status", () => {
  const DAY = 86_400_000;
  const status = (extra: object) =>
    server("status", {
      now: 1_800_000_000_000,
      providers: [],
      pricesWarn: false,
      pendingApprovals: 0,
      turnRunning: false,
      notify: "ok",
      ...extra,
    });
  async function ready(extra: object) {
    const h = socketHarness();
    const r = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    await act(async () => {
      h.last().receive(server("relay.status", { online: true }));
      h.last().receive(status(extra));
    });
    const area = r.root.querySelector("textarea") as HTMLTextAreaElement;
    const type = (value: string) =>
      act(async () => {
        // oxlint-disable-next-line typescript/unbound-method
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        set?.call(area, value);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const key = (k: string) =>
      act(
        async () =>
          void area.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })),
      );
    return { h, ...r, type, key };
  }

  test("the local end's skills are in the menu; a skill goes as the terminal's wording", async () => {
    const { h, root, type, key, unmount } = await ready({
      skills: [
        { name: "tars-mode", description: "路由表", localOnly: false },
        { name: "memory", description: "記憶", localOnly: true },
      ],
    });
    await type("/");
    const names = [...root.querySelectorAll(".slash-cmd")].map((e) => e.textContent);
    expect(names).toEqual(["/new", "/cost", "/help", "/tars-mode", "/memory"]);
    await type("/tars-mode 記一筆");
    await key("Enter");
    const sent = h
      .last()
      .messages()
      .filter((m) => m.kind === "turn.submit");
    expect((sent.at(-1)?.p as { text?: string } | undefined)?.text).toBe(
      skillInvocationText("tars-mode", "記一筆"),
    );
    unmount();
  });

  test("/cost opens the status sheet", async () => {
    const { root, type, key, unmount } = await ready({});
    await type("/cost");
    await key("Enter");
    expect(root.querySelector(".sheet-panel")).not.toBeNull();
    unmount();
  });

  test("a certificate within 30 days is warned on the bar and dated in the sheet", async () => {
    const { root, unmount } = await ready({ certExpiresAt: 1_800_000_000_000 + 10 * DAY });
    const bar = root.querySelector(".topbar-right .desktop-only") as HTMLButtonElement;
    expect(bar.textContent).toBe("憑證剩 10 天");
    await act(async () => bar.click());
    const sheet = root.querySelector(".sheet-panel") as HTMLElement;
    expect(sheet.textContent).toContain("本機端憑證30 天內到期");
    expect(sheet.textContent).toContain("（剩 10 天）");
    unmount();
    const far = await ready({ certExpiresAt: 1_800_000_000_000 + 90 * DAY });
    expect(far.root.querySelector(".topbar-right .desktop-only")?.textContent).toBe("花費與模型");
    far.unmount();
  });
});

describe("the drawer and the status sheet hold the focus; Esc closes them", () => {
  const press = (key: string, shiftKey = false) =>
    act(
      async () =>
        void document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })),
    );

  test("the drawer below 1024px: focus goes in, Tab wraps, Esc closes and the menu button has it back", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    const menu = root.querySelector('[aria-label="展開對話列表"]') as HTMLButtonElement;
    menu.focus();
    await act(async () => menu.click());
    const drawer = root.querySelector(".sidebar") as HTMLElement;
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.contains(document.activeElement)).toBe(true);
    const inside = [...drawer.querySelectorAll<HTMLElement>("button")];
    (inside.at(-1) as HTMLElement).focus();
    await press("Tab");
    expect(document.activeElement).toBe(inside[0]);
    await press("Tab", true);
    expect(document.activeElement).toBe(inside.at(-1));
    await press("Escape");
    expect(drawer.classList.contains("mobile-open")).toBe(false);
    expect(drawer.getAttribute("role")).toBeNull();
    expect(document.activeElement).toBe(menu);
    unmount();
    vi.unstubAllGlobals();
  });

  test("on desktop the column is not a dialog and Esc leaves it alone", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    const side = root.querySelector(".sidebar") as HTMLElement;
    expect(side.getAttribute("role")).toBeNull();
    await press("Escape");
    expect(side.classList.contains("collapsed")).toBe(false);
    unmount();
  });

  test("the status sheet: the close button has the focus, Esc closes it and the opener has it back", async () => {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    const opener = root.querySelector(".topbar-right .desktop-only") as HTMLButtonElement;
    opener.focus();
    await act(async () => opener.click());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("關閉");
    await press("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("關閉");
    await press("Escape");
    expect(root.querySelector(".sheet-panel")).toBeNull();
    expect(document.activeElement).toBe(opener);
    unmount();
  });
});

test("往返延遲: status.get while the sheet is open, timed to the status that answers it", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  const asked = () =>
    h
      .last()
      .messages()
      .filter((m) => m.kind === "status.get");
  expect(asked()).toHaveLength(0);
  await act(async () =>
    (root.querySelector(".topbar-right .desktop-only") as HTMLButtonElement).click(),
  );
  const sheet = () => root.querySelector(".sheet-panel") as HTMLElement;
  expect(asked()).toHaveLength(1);
  expect(sheet().textContent).toContain("往返延遲量測中");
  const status = {
    now: 1,
    providers: [],
    pricesWarn: false,
    pendingApprovals: 0,
    turnRunning: false,
    notify: "ok",
  };
  // A status nobody asked for (a broadcast) does not count.
  await act(async () => h.advance(100));
  await act(async () => h.last().receive(server("status", status)));
  expect(sheet().textContent).toContain("往返延遲量測中");
  await act(async () => h.advance(80));
  await act(async () => h.last().receive(server("status", status, { re: asked()[0]?.id ?? "" })));
  expect(sheet().textContent).toContain("往返延遲180 ms");
  await act(async () => (root.querySelector('[aria-label="關閉"]') as HTMLButtonElement).click());
  await act(async () =>
    (root.querySelector(".topbar-right .desktop-only") as HTMLButtonElement).click(),
  );
  expect(asked()).toHaveLength(2);
  unmount();
});

describe("another model: chosen for a new conversation, or continuing one", () => {
  const MODELS = [
    { provider: "anthropic", id: "model-a", label: "Model A", window: 200_000, isDefault: true },
    { provider: "anthropic", id: "model-b", label: "Model B", window: 100_000, isDefault: false },
    { provider: "gemini", id: "g", label: "G", isDefault: false, unusable: "no_key" },
  ];
  const CONVS = [
    { id: "conv-1", title: "甲", provider: "anthropic", model: "model-a", updatedAt: 2 },
    {
      id: "conv-2",
      title: "乙",
      provider: "anthropic",
      model: "model-b",
      updatedAt: 1,
      parentId: "conv-1",
    },
  ];
  async function ready(models: boolean) {
    const h = socketHarness();
    const r = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    const asked = h
      .last()
      .messages()
      .find((m) => m.kind === "models.get");
    await act(async () => {
      h.last().receive(server("relay.status", { online: true }));
      h.last().receive(server("conv.list.result", { convs: CONVS }));
      h.last().receive(
        models
          ? server("models.result", { models: MODELS }, { re: asked?.id ?? "" })
          : server("nack", { reason: "bad_message" }, { re: asked?.id ?? "" }),
      );
    });
    const area = r.root.querySelector("textarea") as HTMLTextAreaElement;
    const send = async (value: string) => {
      await act(async () => {
        // oxlint-disable-next-line typescript/unbound-method
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        set?.call(area, value);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button(r.root, "送出").click());
    };
    const submitted = () =>
      h
        .last()
        .messages()
        .filter((m) => m.kind === "turn.submit")
        .at(-1);
    return { h, ...r, send, submitted };
  }

  test("a local end that does not list models: no model control, no error", async () => {
    const { root, unmount } = await ready(false);
    expect(root.querySelector(".run-seg")).toBeNull();
    expect(root.querySelector("[role=alert]")).toBeNull();
    unmount();
  });

  test("a new conversation: the default shown, another picked, and the message names it", async () => {
    const { root, send, submitted, unmount } = await ready(true);
    const seg = root.querySelector(".run-seg") as HTMLButtonElement;
    expect(seg.textContent).toBe("模型Model A");
    await act(async () => seg.click());
    const sheet = root.querySelector("[aria-labelledby=model-sheet-title]") as HTMLElement;
    const g = [...sheet.querySelectorAll<HTMLButtonElement>(".model-option")].find((b) =>
      b.textContent?.includes("G"),
    );
    expect(g?.disabled).toBe(true);
    expect(g?.textContent).toContain("這家 provider 沒有 API 金鑰");
    await act(async () => button(sheet, "Model Bmodel-b100K").click());
    await act(async () => button(sheet, "使用這個模型").click());
    expect(root.querySelector(".run-seg")?.textContent).toBe("模型Model B");
    expect(root.querySelector(".empty-state")?.textContent).toContain("模型：Model B。");
    await send("嗨");
    expect(submitted()?.p).toMatchObject({
      text: "嗨",
      model: { provider: "anthropic", id: "model-b" },
    });
    expect(submitted()?.conv).toBeUndefined();
    unmount();
  });

  test("continuing: the cost said first, then a new conversation that carries this one", async () => {
    const { h, root, send, submitted, unmount } = await ready(true);
    await act(async () => (root.querySelector(".conv-item") as HTMLButtonElement).click());
    await act(async () => button(root, "以另一個模型接續").click());
    const sheet = root.querySelector("[aria-labelledby=model-sheet-title]") as HTMLElement;
    expect(sheet.textContent).toContain("來源對話：甲（原模型 model-a）");
    const a = [...sheet.querySelectorAll<HTMLButtonElement>(".model-option")][0];
    expect([a?.disabled, a?.textContent?.includes("目前")]).toEqual([true, true]);
    // Model B, the first one usable, is chosen: 40% of its 100K window.
    expect(sheet.textContent).toContain("約 40,000 tokens，上限估計");
    expect(sheet.textContent).toContain("工具輸出不會帶入");
    await act(async () => button(sheet, "建立接續對話").click());
    expect(root.querySelector(".empty-state")).not.toBeNull();
    const banner = root.querySelector(".composer-wrap .task-notice.active") as HTMLElement;
    expect(banner.textContent).toContain("下一則訊息會用 Model B 開新對話，接續「甲」");
    expect(banner.textContent).toContain("新對話第一則請求以全價計費");
    await act(async () => button(banner, "最後 3 回合").click());
    await send("繼續");
    expect(submitted()?.p).toMatchObject({
      model: { provider: "anthropic", id: "model-b" },
      from: "conv-1",
      keepLast: 3,
    });
    expect(submitted()?.conv).toBeUndefined();
    const requestId = String(submitted()?.p.requestId);
    await act(async () =>
      h.last().receive(server("turn", { requestId, state: "rejected", reason: "carry_over_stop" })),
    );
    // Refused: still here, with the choice, and what to do next.
    expect(root.querySelector("[role=alert]")?.textContent).toContain("把帶入範圍改成更少的回合");
    expect(root.querySelector(".composer-wrap .task-notice.active")).not.toBeNull();
    await act(async () => button(root, "取消").click());
    expect(h.last().messages().at(-1)).toMatchObject({ kind: "conv.open", conv: "conv-1" });
    expect(root.querySelector(".composer-wrap .task-notice.active")).toBeNull();
    unmount();
  });

  test("the list says which conversation one continues", async () => {
    const { root, unmount } = await ready(true);
    const rows = [...root.querySelectorAll(".conv-item")].map((e) => e.textContent ?? "");
    expect(rows[1]).toContain("接續自「甲」");
    expect(rows[0]).not.toContain("接續自");
    unmount();
  });
});
