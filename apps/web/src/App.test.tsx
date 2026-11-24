// @vitest-environment jsdom
import { PROTOCOL_VERSION, skillInvocationText } from "@tars/protocol";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { button, buttons, render } from "./render.ts";
import { shortTime } from "./components/time.ts";
import { drag, frame, server, socketHarness, touch } from "./testing.ts";
import { PULL_PX } from "./usePullToRefresh.ts";

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
  ).toEqual(["hello", "conv.list", "status.get", "models.get"]);
  await act(async () =>
    h.last().receive(server("relay.status", { online: true, localSince: 1_800_000_000_000 })),
  );
  expect(root.querySelector(".conn-pill")?.textContent).toBe("在線");
  unmount();
});

test("the pill as scene 5: which reconnect in a warn pill; a version mismatch says which side to update", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  const pill = () => root.querySelector(".conn-pill") as HTMLElement;
  await act(async () => h.last().ready());
  await act(async () => {
    h.last().end(4001);
    await h.advance(1000);
  });
  expect([pill().className, pill().textContent]).toEqual(["conn-pill warn", "重連中，第 1 次"]);
  expect(pill().querySelector(".status-dot")?.className).toBe("status-dot active");
  const hello = h
    .last()
    .messages()
    .findLast((m) => m.kind === "hello");
  await act(async () => {
    h.last().onopen?.();
    h.last().receive({
      v: PROTOCOL_VERSION,
      id: "s-1",
      kind: "nack",
      re:
        h
          .last()
          .messages()
          .findLast((m) => m.kind === "hello")?.id ?? hello?.id,
      p: { reason: "version", need: "client" },
    });
  });
  expect([pill().className, pill().textContent]).toEqual([
    "conn-pill warn",
    "協定不合，請重新載入頁面重新載入",
  ]);
  expect(root.querySelector(".composer .reason")?.textContent).toBe("協定不合，請重新載入頁面");
  // The phone's status button does not say it a second time: a warn dot and 狀態.
  const phone = root.querySelector(".topbar-right .mobile-only") as HTMLElement;
  expect([phone.querySelector(".status-dot")?.className, phone.textContent]).toEqual([
    "status-dot warn",
    "狀態",
  ]);
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
  // Being sent: the box stays on for the next message; the send waits.
  expect(textarea().disabled).toBe(false);
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
    // Nothing started yet: the page says it is connected (11-02).
    expect(l.root.querySelector(".empty-state h2")?.textContent).toBe("已連線至本機 TARS");
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
    expect(root.querySelector(".empty-state h2")?.textContent).toBe("新對話");
    // 7-19: typing can start at once.
    expect(document.activeElement).toBe(root.querySelector("textarea"));
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

  test("a screen reader hears a card come to wait, once; and each reply that comes, not old ones", async () => {
    const { h, root, unmount } = await listed();
    const alert = () => root.querySelector(".sr-only[role=alert]") as HTMLElement;
    const polite = () => root.querySelector(".sr-only[aria-live=polite]") as HTMLElement;
    expect([alert().getAttribute("aria-live"), alert().textContent]).toEqual(["assertive", ""]);
    await act(async () => entry(root, "對話 1").click());
    await act(async () =>
      h.last().receive(
        server(
          "conv.snapshot",
          {
            epoch: "epoch-1",
            more: false,
            items: [
              { seq: 1, turn: "t1", kind: "user", text: "舊", truncated: false },
              {
                seq: 2,
                turn: "t1",
                kind: "assistant",
                text: "舊回覆",
                truncated: false,
                state: "complete",
              },
            ],
          },
          { conv: "conv-1" },
        ),
      ),
    );
    expect(polite().textContent).toBe("");
    await act(async () =>
      h.last().receive(
        server(
          "item",
          {
            item: {
              seq: 3,
              turn: "t2",
              kind: "assistant",
              text: "新回覆",
              truncated: false,
              state: "complete",
            },
          },
          { conv: "conv-1" },
        ),
      ),
    );
    expect(polite().textContent).toBe("新回覆");

    await act(async () => h.last().receive(request("conv-1")));
    expect(alert().textContent).toBe(
      "需要核准：執行腳本 push，影響寫外部，不連線。預設焦點在拒絕按鈕。",
    );
    await act(async () => h.last().receive(resolved("approved")));
    expect(alert().textContent).toBe("");
    // The local end's resend after a reconnect: not new, not said again.
    await act(async () => h.last().receive(request("conv-1")));
    expect(alert().textContent).toBe("");
    unmount();
  });

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
      status: "done",
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
      .find((c) => c.textContent?.includes(`${script} @ `))
      ?.querySelector<HTMLButtonElement>(".sg-btn-danger");

  /** Whether a screen reader can reach it: nothing above it is aria-hidden or inert. */
  const exposed = (el: Element | null) => {
    for (let e = el; e !== null; e = e.parentElement)
      if (e.getAttribute("aria-hidden") === "true" || e.hasAttribute("inert")) return false;
    return el !== null;
  };

  test.each([
    ["the desktop's status Dialog", false],
    ["a phone's status Drawer", true],
  ])(
    "a card that comes while %s is open is announced, and its deny is readable",
    async (_, phone) => {
      if (phone)
        vi.stubGlobal("matchMedia", () => ({
          matches: true,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }));
      const { h, root, unmount } = await listed();
      if (!phone) await act(async () => entry(root, "對話 1").click());
      const status = document.querySelector<HTMLButtonElement>(
        phone ? '[aria-label="開啟系統狀態與花費面板"]' : "header .sg-btn.desktop-only",
      );
      await act(async () => status?.click());
      await frame();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => h.last().receive(requestN(5, "conv-5")));
      const alert = document.querySelector('[role="alert"][aria-live="assertive"]');
      expect(alert?.textContent).toContain("需要核准：執行腳本 s5");
      expect(exposed(alert)).toBe(true);
      expect(document.activeElement).toBe(denyOf(root, "s5"));
      expect(exposed(document.activeElement)).toBe(true);
      unmount();
      vi.unstubAllGlobals();
    },
  );

  /** A full pull on the thread's top; whether it took the drag, and what the bar says. */
  const pullOn = (root: HTMLElement) => {
    const moves = drag(scroll(root), PULL_PX + 20, true);
    const pull = root.querySelector(".pull-indicator")?.getAttribute("data-pull");
    touch(scroll(root), "touchcancel", [], [{ y: 190 }]);
    return [moves.some((e) => e.defaultPrevented), pull];
  };
  const phoneMedia = () =>
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));

  test.each([
    ["the desktop's status Dialog", false, "header .sg-btn.desktop-only"],
    ["a phone's status Drawer", true, '[aria-label="開啟系統狀態與花費面板"]'],
    ["a phone's conversation Sheet", true, '[aria-label="展開對話列表"]'],
  ])("no pull behind %s; closed, the pull is back", async (_, phone, opener) => {
    if (phone) phoneMedia();
    const { root, unmount } = await listed();
    // A failed check must not leave an overlay or a phone's width to the tests after it, and the
    // tree goes before afterEach empties the body, or React loses the portal.
    try {
      if (!phone) await act(async () => entry(root, "對話 1").click());
      expect(pullOn(root)).toEqual([true, "ready"]);
      await act(async () => document.querySelector<HTMLButtonElement>(opener)?.click());
      await frame();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(pullOn(root)).toEqual([false, "idle"]);
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await frame();
      expect(document.querySelector("[data-base-ui-inert]")).toBeNull();
      expect(pullOn(root)).toEqual([true, "ready"]);
    } finally {
      unmount();
      vi.unstubAllGlobals();
    }
  });

  test("a card announced in the middle of a pull: the alert still says it, apart from the bar", async () => {
    const { h, root, unmount } = await listed();
    try {
      await act(async () => entry(root, "對話 1").click());
      drag(scroll(root), 40, true);
      await act(async () => h.last().receive(requestN(5, "conv-5")));
      const alert = document.querySelector('[role="alert"][aria-live="assertive"]');
      const bar = root.querySelector('.pull-indicator[role="status"]');
      expect(alert?.textContent).toContain("需要核准：執行腳本 s5");
      expect(exposed(alert)).toBe(true);
      expect(bar?.textContent).toBe("下拉重新整理");
      // Two regions, neither inside the other: the bar's polite text does not replace the alert's.
      expect(alert?.contains(bar ?? null) || bar?.contains(alert)).toBe(false);
      expect(exposed(bar)).toBe(true);
      touch(scroll(root), "touchend", [], [{ y: 140 }]);
    } finally {
      unmount();
    }
  });

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
    expect(shown).toEqual(["s4 @ v1", "s5 @ v1", "s2 @ v1"]);
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
    expect(shown).toEqual(["s4 @ v1", "s5 @ v1", "s2 @ v1"]);
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
  const sheet = document.querySelector(".sheet-panel") as HTMLElement;
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
    const { type, key, unmount } = await ready({});
    await type("/cost");
    await key("Enter");
    expect(document.querySelector(".sheet-panel")).not.toBeNull();
    unmount();
  });

  test("a certificate within 30 days is warned on the bar and dated in the sheet", async () => {
    const { root, unmount } = await ready({ certExpiresAt: 1_800_000_000_000 + 10 * DAY });
    const bar = root.querySelector(".topbar-right .desktop-only") as HTMLButtonElement;
    expect(bar.textContent).toBe("憑證剩 10 天");
    await act(async () => bar.click());
    const sheet = document.querySelector(".sheet-panel") as HTMLElement;
    expect(sheet.textContent).toContain("本機端憑證30 天內到期");
    expect(sheet.textContent).toContain("（剩 10 天）");
    // On a phone the button says it too, with a warn dot.
    const phone = root.querySelector(".topbar-right .mobile-only") as HTMLElement;
    expect([phone.querySelector(".status-dot")?.className, phone.textContent]).toEqual([
      "status-dot warn",
      "憑證剩 10 天",
    ]);
    // The sidebar footer carries it too (1-05).
    const tag = root.querySelector(".sidebar-footer .sg-tag") as HTMLElement;
    expect([tag.className, tag.textContent]).toEqual(["sg-tag warn", "憑證剩 10 天"]);
    unmount();
    const far = await ready({ certExpiresAt: 1_800_000_000_000 + 90 * DAY });
    expect(far.root.querySelector(".topbar-right .desktop-only")?.textContent).toBe("花費與模型");
    const ok = far.root.querySelector(".sidebar-footer .sg-tag") as HTMLElement;
    expect([ok.className, ok.textContent]).toEqual(["sg-tag", "連線憑證正常"]);
    far.unmount();
    const gone = await ready({ certExpiresAt: 1_800_000_000_000 - DAY });
    expect(gone.root.querySelector(".sidebar-footer .sg-tag")?.className).toBe("sg-tag error");
    gone.unmount();
    // Not said yet: no footer.
    const unknown = await ready({});
    expect(unknown.root.querySelector(".sidebar-footer")).toBeNull();
    unknown.unmount();
  });
});

describe("the drawer and the status sheet hold the focus; Esc closes them", () => {
  const press = (key: string, shiftKey = false) =>
    act(
      async () =>
        void document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })),
    );

  // Tab staying inside is Base UI's focus trap, which moves the focus by real Tab presses onto
  // its guard elements; jsdom moves no focus on a dispatched Tab, so tools/visual/csp.ts checks
  // it in Chromium.
  test("the drawer below 1024px: focus goes in, Esc closes and the menu button has it back", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    const menu = root.querySelector('[aria-label="展開對話列表"]') as HTMLButtonElement;
    // A popup under document.body, kept there closed and inert: Tab and a screen reader skip it.
    const drawer = document.querySelector(".sidebar") as HTMLElement;
    expect(drawer.hasAttribute("inert")).toBe(true);
    menu.focus();
    await act(async () => menu.click());
    await frame();
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.hasAttribute("inert")).toBe(false);
    expect(drawer.contains(document.activeElement)).toBe(true);
    await press("Escape");
    expect(drawer.hasAttribute("inert")).toBe(true);
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
    await frame();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("關閉");
    await press("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("關閉");
    await press("Escape");
    expect(document.querySelector(".sheet-panel")).toBeNull();
    expect(document.activeElement).toBe(opener);
    unmount();
  });
});

test("往返延遲: measured from connecting, every half minute, and when the sheet opens; shown in the top bar", async () => {
  // The frames too: Base UI asks for one when the sheet opens, and jsdom would build its frame
  // loop on the faked setInterval, which stops every later frame in this file. Nothing focused
  // leaves the page while they are faked, so jsdom's focus fixup does not start that loop here.
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  try {
    const h = socketHarness();
    const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
    await act(async () => h.last().ready());
    await act(async () => h.last().receive(server("relay.status", { online: true })));
    const asked = () =>
      h
        .last()
        .messages()
        .filter((m) => m.kind === "status.get");
    const pill = () => root.querySelector(".conn-pill") as HTMLElement;
    expect(asked()).toHaveLength(1);
    expect(pill().querySelector(".conn-latency")).toBeNull();
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
    expect(pill().querySelector(".conn-latency")).toBeNull();
    await act(async () => h.advance(80));
    await act(async () => h.last().receive(server("status", status, { re: asked()[0]?.id ?? "" })));
    const latency = pill().querySelector(".conn-latency") as HTMLElement;
    expect([pill().textContent, latency.getAttribute("aria-hidden")]).toEqual([
      "在線180 ms",
      "true",
    ]);

    await act(async () => void vi.advanceTimersByTime(29_999));
    expect(asked()).toHaveLength(1);
    await act(async () => void vi.advanceTimersByTime(1));
    expect(asked()).toHaveLength(2);

    await act(async () =>
      (root.querySelector(".topbar-right .desktop-only") as HTMLButtonElement).click(),
    );
    expect(asked()).toHaveLength(3);
    const sheet = document.querySelector(".sheet-panel") as HTMLElement;
    expect(sheet.textContent).toContain("往返延遲180 ms");
    unmount();
  } finally {
    vi.useRealTimers();
  }
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
    expect(root.querySelector("[role=alert]:not(.sr-only)")).toBeNull();
    unmount();
  });

  test("a new conversation: the default shown, another picked, and the message names it", async () => {
    const { root, send, submitted, unmount } = await ready(true);
    const seg = root.querySelector(".run-seg") as HTMLButtonElement;
    expect(seg.textContent).toBe("模型Model A");
    await act(async () => seg.click());
    const menu = document.querySelector("[role=menu][aria-label=選擇模型]") as HTMLElement;
    const g = [...menu.querySelectorAll<HTMLButtonElement>(".model-menu-option")].find((b) =>
      b.textContent?.startsWith("G"),
    );
    // Base UI marks a menu item off with aria-disabled; it keeps no native disabled.
    expect(g?.getAttribute("aria-disabled")).toBe("true");
    expect(g?.textContent).toContain("這家 provider 沒有 API 金鑰");
    // A new conversation switches in place: no sheet.
    await act(async () => button(menu, "Model Bcontext 100K").click());
    expect(document.querySelector("[aria-labelledby=model-sheet-title]")).toBeNull();
    expect(root.querySelector(".run-seg")?.textContent).toBe("模型Model B");
    expect(root.querySelector(".empty-state p")?.textContent).toBe(
      "目前用 Model B。要換模型或推理強度，在輸入框右下角選。送出第一則訊息後，模型就綁在這個對話上。",
    );
    await send("嗨");
    expect(submitted()?.p).toMatchObject({
      text: "嗨",
      model: { provider: "anthropic", id: "model-b" },
    });
    expect(submitted()?.conv).toBeUndefined();
    unmount();
  });

  test("a new conversation starts on the model of the one updated last, while it is usable", async () => {
    const start = async (models: readonly object[]) => {
      const h = socketHarness();
      const r = await render(<App socket={h.socket} now={h.now} />);
      await act(async () => h.last().ready());
      const asked = h
        .last()
        .messages()
        .find((m) => m.kind === "models.get");
      await act(async () => {
        h.last().receive(server("relay.status", { online: true }));
        // conv-2 is listed second but updated last.
        h.last().receive(
          server("conv.list.result", {
            convs: [CONVS[0], { ...CONVS[1], updatedAt: 3 }],
          }),
        );
        h.last().receive(server("models.result", { models }, { re: asked?.id ?? "" }));
      });
      return { h, ...r };
    };
    const used = await start(MODELS);
    expect(used.root.querySelector(".run-seg")?.textContent).toBe("模型Model B");
    await act(async () => (used.root.querySelector(".new-chat-btn") as HTMLElement).click());
    expect(used.root.querySelector(".empty-state p")?.textContent).toContain("目前用 Model B。");
    used.unmount();
    // Model B can no longer be used: the local end's default.
    const gone = await start(
      MODELS.map((m) => (m.id === "model-b" ? { ...m, unusable: "no_key" } : m)),
    );
    expect(gone.root.querySelector(".run-seg")?.textContent).toBe("模型Model A");
    gone.unmount();
    // Where room is short the maker goes: the composer's button and the list, not the header.
    const named = await start(
      MODELS.map((m) => (m.id === "model-b" ? { ...m, label: "Claude Model B" } : m)),
    );
    expect(named.root.querySelector(".run-seg")?.textContent).toBe("模型Model B");
    expect(named.root.querySelector(".conv-header-model")?.textContent).toBe("Claude Model B");
    named.unmount();
    // No models listed: the page says so instead of naming one.
    const none = await start([]);
    await act(async () => (none.root.querySelector(".new-chat-btn") as HTMLElement).click());
    expect(none.root.querySelector(".empty-state p")?.textContent).toBe(
      "還沒有可用的模型。請先在本機終端更新模型清單。",
    );
    none.unmount();
  });

  test("/model opens the model menu on a new conversation and the continue sheet on one with messages", async () => {
    const { root, send, submitted, unmount } = await ready(true);
    await send("/model");
    expect(document.querySelector("[role=menu][aria-label=選擇模型]")).not.toBeNull();
    expect(submitted()).toBeUndefined();
    await act(async () => (root.querySelector(".conv-item") as HTMLButtonElement).click());
    await send("/model");
    expect(document.querySelector("[aria-labelledby=model-sheet-title]")).not.toBeNull();
    expect(submitted()).toBeUndefined();
    unmount();
  });

  test("the header names the model and provider; continuing waits for a message", async () => {
    const { root, unmount } = await ready(true);
    // List entries name the model by its label, without the maker (1-04).
    expect(
      [...root.querySelectorAll(".conv-item .conv-meta span:first-child")].map(
        (e) => e.textContent,
      ),
    ).toEqual(["Model A", "Model B", "接續自「甲」"]);
    const header = () => root.querySelector(".conv-header-bar") as HTMLElement;
    const fork = () => button(header(), "以另一個模型接續");
    // A new conversation: its model, and nothing to carry yet (9-06).
    expect(header().querySelector(".conv-header-model")?.textContent).toBe("Model A");
    expect(header().querySelector(".sg-tag")?.textContent).toBe("Anthropic");
    expect([fork().disabled, fork().title]).toEqual([true, "對話還沒有訊息，直接在輸入框換模型"]);
    expect(fork().querySelector("svg")).not.toBeNull();
    await act(async () => (root.querySelector(".conv-item") as HTMLButtonElement).click());
    expect(header().querySelector(".conv-header-model")?.textContent).toBe("Model A");
    expect([fork().disabled, fork().title]).toEqual([false, ""]);
    unmount();
  });

  test("continuing: the cost said first, then a new conversation that carries this one", async () => {
    const { h, root, send, submitted, unmount } = await ready(true);
    await act(async () => (root.querySelector(".conv-item") as HTMLButtonElement).click());
    expect(button(root, "以另一個模型接續").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button(root, "以另一個模型接續").click());
    expect(button(root, "以另一個模型接續").getAttribute("aria-expanded")).toBe("true");
    const sheet = document.querySelector("[aria-labelledby=model-sheet-title]") as HTMLElement;
    expect(sheet.textContent).toContain("來源對話：甲（原模型 Model A）");
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
    expect(root.querySelector("[role=alert]:not(.sr-only)")?.textContent).toContain(
      "把帶入範圍改成更少的回合",
    );
    expect(root.querySelector(".composer-wrap .task-notice.active")).not.toBeNull();
    await act(async () => button(root, "取消").click());
    expect(h.last().messages().at(-1)).toMatchObject({ kind: "conv.open", conv: "conv-1" });
    expect(root.querySelector(".composer-wrap .task-notice.active")).toBeNull();
    unmount();
  });

  test("no pull behind the model DropdownMenu or the continuing Popover", async () => {
    const { root, unmount } = await ready(true);
    try {
      await act(async () => (root.querySelector(".conv-item") as HTMLButtonElement).click());
      const main = root.querySelector(".thread-scroll") as HTMLElement;
      const pulled = () => {
        const moves = drag(main, PULL_PX + 20, true);
        touch(main, "touchcancel", [], [{ y: 190 }]);
        return moves.some((e) => e.defaultPrevented);
      };
      expect(pulled()).toBe(true);
      await act(async () => (root.querySelector(".run-seg") as HTMLButtonElement).click());
      expect(document.querySelector("[role=menu]")).not.toBeNull();
      expect(pulled()).toBe(false);
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await frame();
      await act(async () => button(root, "以另一個模型接續").click());
      expect(document.querySelector("[aria-labelledby=model-sheet-title]")).not.toBeNull();
      expect(pulled()).toBe(false);
    } finally {
      unmount();
    }
  });

  test("the list says which conversation one continues", async () => {
    const { root, unmount } = await ready(true);
    const rows = [...root.querySelectorAll(".conv-item")].map((e) => e.textContent ?? "");
    expect(rows[1]).toContain("接續自「甲」");
    expect(rows[0]).not.toContain("接續自");
    unmount();
  });
});

describe("cards from other conversations: set off, and told apart", () => {
  // Titles come from the first message: two conversations can have the same one.
  const SAME = "11/20 19:45 晚餐 錢包";
  const CONVS = [
    {
      id: "conv-1",
      title: SAME,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      updatedAt: Date.UTC(2026, 10, 20, 7, 11),
    },
    {
      id: "conv-2",
      title: SAME,
      provider: "gemini",
      model: "gemini-2.5-pro",
      updatedAt: Date.UTC(2026, 10, 21, 2, 30),
    },
    {
      id: "conv-3",
      title: "其他",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      updatedAt: 1,
    },
  ];
  const request = (id: string, conv: string, hash: string) =>
    server("approval.request", {
      approval: {
        approvalId: id,
        conv,
        hash,
        action: "run_script",
        script: "fava-ledger",
        version: "v1",
        summary: "記一筆",
        effects: "external-write",
        domains: [],
        secret: null,
        argv: [],
        expiresAt: 600_000,
      },
    });
  async function onConv3() {
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
          b.textContent?.startsWith("其他"),
        ) as HTMLButtonElement
      ).click(),
    );
    const heads = () =>
      [...r.root.querySelectorAll(".pinned-approvals .approval-origin-bar")].map((e) => ({
        kind: e.querySelector(".approval-origin-text span")?.textContent,
        title: e.querySelector(".approval-origin-title")?.textContent,
        detail: e.querySelector(".approval-origin-detail")?.textContent,
      }));
    return { h, ...r, heads };
  }

  test("two of the same title: each card says its time and model, waiting or decided", async () => {
    const { h, root, heads, unmount } = await onConv3();
    expect(root.querySelector(".pinned-approvals")).toBeNull();
    await act(async () => {
      h.last().receive(request("approval-00000001", "conv-1", "a".repeat(64)));
      h.last().receive(request("approval-00000002", "conv-2", "b".repeat(64)));
      h.last().receive(
        server("approval.resolved", {
          approvalId: "approval-00000001",
          state: "approved",
          via: "remote",
        }),
      );
    });
    const dock = root.querySelector(".pinned-approvals") as HTMLElement;
    expect(dock.querySelector(".pinned-head")?.textContent).toBe("其他對話的核准（2）");
    const time = (ms: number) => shortTime(ms);
    expect(heads()).toEqual([
      {
        kind: "已決定（來自其他對話）",
        title: SAME,
        detail: `${time(CONVS[0]?.updatedAt ?? 0)} · claude-sonnet-5-5`,
      },
      {
        kind: "待核准（來自其他對話）",
        title: SAME,
        detail: `${time(CONVS[1]?.updatedAt ?? 0)} · gemini-2.5-pro`,
      },
    ]);
    expect(heads()[0]?.detail).not.toBe(heads()[1]?.detail);
    unmount();
  });

  test("a conversation the list does not have: another conversation, and the card's hash", async () => {
    const { h, heads, unmount } = await onConv3();
    await act(async () =>
      h.last().receive(request("approval-00000003", "conv-old", "c0ffee12" + "0".repeat(56))),
    );
    expect(heads()).toEqual([
      { kind: "待核准（來自其他對話）", title: "另一個對話", detail: "核准 c0ffee12" },
    ]);
    unmount();
  });

  test("cut off by its bound, the dock says there is more; scrolled to the end, it does not", async () => {
    const { h, root, unmount } = await onConv3();
    await act(async () => h.last().receive(request("approval-00000001", "conv-1", "a".repeat(64))));
    const scroll = root.querySelector(".pinned-scroll") as HTMLElement;
    // jsdom lays nothing out: the sizes a phone would have.
    Object.defineProperty(scroll, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 320, configurable: true });
    await act(async () => void scroll.dispatchEvent(new Event("scroll")));
    expect(root.querySelector(".pinned-more")?.textContent).toBe("還有內容，向下捲動");
    scroll.scrollTop = 580;
    await act(async () => void scroll.dispatchEvent(new Event("scroll")));
    expect(root.querySelector(".pinned-more")).toBeNull();
    unmount();
  });
});

describe("effort: the level beside the model, its menu, and what the message carries", () => {
  const MODELS = [
    {
      provider: "anthropic",
      id: "model-a",
      label: "Model A",
      window: 200_000,
      isDefault: true,
      effortLevels: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
    {
      provider: "anthropic",
      id: "model-b",
      label: "Model B",
      window: 100_000,
      isDefault: false,
      effortLevels: ["low", "medium"],
      defaultEffort: "medium",
    },
    { provider: "anthropic", id: "model-c", label: "Model C", isDefault: false, effortLevels: [] },
  ];
  const CONVS = [
    {
      id: "conv-1",
      title: "甲",
      provider: "anthropic",
      model: "model-a",
      updatedAt: 2,
      effort: "high",
    },
    {
      id: "conv-3",
      title: "丙",
      provider: "anthropic",
      model: "model-c",
      updatedAt: 1,
      effort: "medium",
    },
  ];
  const media = window.matchMedia;
  afterEach(() => {
    window.matchMedia = media;
  });
  /** A phone: both the drawer's and the menus' widths match. */
  const asPhone = () => {
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  };
  async function ready(models: readonly unknown[] = MODELS) {
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
      h.last().receive(server("models.result", { models }, { re: asked?.id ?? "" }));
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
    const openConv = async (title: string) => {
      // On a phone the list is in the drawer, which is there only while open.
      const menu = r.root.querySelector<HTMLButtonElement>('[aria-label="展開對話列表"]');
      if (r.root.querySelector(".conv-item") === null && menu !== null)
        await act(async () => menu.click());
      await act(async () =>
        (
          [...document.querySelectorAll<HTMLButtonElement>(".conv-item")].find((b) =>
            b.textContent?.startsWith(title),
          ) as HTMLButtonElement
        ).click(),
      );
    };
    const seg = () => r.root.querySelector(".effort-anchor .run-seg") as HTMLButtonElement | null;
    const menu = () => document.querySelector("[role=menu]") as HTMLElement | null;
    // Base UI moves a menu's focus by keys on the next frame.
    const key = async (k: string) => {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, bubbles: true }),
        );
      });
      await frame();
    };
    return { h, ...r, send, submitted, openConv, seg, menu, key };
  }

  test("model and effort are not changed while a turn runs or the local end is away, and say why", async () => {
    const { h, root, seg, menu, openConv, unmount } = await ready();
    await openConv("甲");
    const model = () => root.querySelector(".model-anchor .run-seg") as HTMLButtonElement;
    const both = () => [model(), seg() as HTMLButtonElement].map((b) => [b.disabled, b.title]);
    expect(both()).toEqual([
      [false, "選擇模型"],
      [false, "調整推理強度"],
    ]);
    await act(async () => model().click());
    expect(menu()).not.toBeNull();
    await act(async () =>
      h.last().receive(server("turn", { turn: "t-1", state: "started" }, { conv: "conv-1" })),
    );
    expect(both()).toEqual([
      [true, "回合結束後才能改"],
      [true, "回合結束後才能改"],
    ]);
    // An open menu goes with it.
    expect(menu()).toBeNull();
    await act(async () =>
      h.last().receive(server("turn", { turn: "t-1", state: "completed" }, { conv: "conv-1" })),
    );
    await act(async () => h.last().receive(server("relay.status", { online: false })));
    expect(both()).toEqual([
      [true, "本機端離線，暫時無法送出訊息。"],
      [true, "本機端離線，暫時無法送出訊息。"],
    ]);
    unmount();
  });

  test("a local end whose list has no levels: no effort control, nothing about it in the header", async () => {
    const { root, seg, openConv, unmount } = await ready(
      MODELS.map((m) => ({
        provider: m.provider,
        id: m.id,
        label: m.label,
        isDefault: m.isDefault,
      })),
    );
    await openConv("甲");
    expect(seg()).toBeNull();
    expect(root.querySelector(".conv-header-effort")).toBeNull();
    expect(root.querySelector(".run-seg")?.textContent).toBe("模型Model A");
    unmount();
  });

  test("a conversation: its level shown; the menu moves by keys, closes on Esc, picks, says when it applies; the message carries it", async () => {
    const { root, seg, menu, key, openConv, send, submitted, unmount } = await ready();
    await openConv("甲");
    expect(root.querySelector(".conv-header-effort")?.textContent).toBe("推理：高");
    expect(seg()?.textContent).toBe("推理高");
    await act(async () => seg()?.click());
    await frame();
    expect(seg()?.getAttribute("aria-expanded")).toBe("true");
    const options = () => [
      ...(menu()?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []),
    ];
    expect(options().map((o) => [o.textContent, o.getAttribute("aria-checked")])).toEqual([
      ["低（low）回應最快，思考最少", "false"],
      ["中（medium）預設平衡（建議）", "false"],
      ["高（high）較仔細，花費較高", "true"],
    ]);
    expect(document.activeElement).toBe(options()[2]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(options()[0]);
    await key("End");
    expect(document.activeElement).toBe(options()[2]);
    await key("Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(seg());

    await act(async () => seg()?.click());
    // The toast's timeout only: jsdom builds its frame loop on setInterval when the picked item
    // leaves with the focus, and on a faked one every later frame in this file stops.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => options()[0]?.click());
      expect(menu()).toBeNull();
      expect(seg()?.textContent).toBe("推理低");
      expect(document.activeElement).toBe(seg());
      const toast = root.querySelector(".effort-toast") as HTMLElement;
      expect([toast.hidden, toast.textContent]).toEqual([false, "下一則訊息起生效"]);
      await act(async () => void vi.advanceTimersByTime(2_600));
      expect(toast.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    await send("再想想");
    expect(submitted()).toMatchObject({ conv: "conv-1", p: { text: "再想想", effort: "low" } });
    unmount();
  });

  test("an untouched conversation sends no level; a model that takes none says so and cannot open", async () => {
    const { root, seg, openConv, send, submitted, unmount } = await ready();
    await openConv("甲");
    await send("嗨");
    expect(submitted()?.p).not.toHaveProperty("effort");
    await openConv("丙");
    expect(root.querySelector(".conv-header-effort")?.textContent).toBe("推理：不適用");
    expect([seg()?.textContent, seg()?.disabled, seg()?.title]).toEqual([
      "推理不適用",
      true,
      "這個模型不支援推理強度",
    ]);
    unmount();
  });

  test("a new conversation: the model's default; a level its next model lacks moves to the nearest, with a warning, and is sent", async () => {
    const { root, seg, menu, send, submitted, unmount } = await ready();
    expect(seg()?.textContent).toBe("推理中");
    await act(async () => seg()?.click());
    await act(async () => button(menu() as HTMLElement, "高（high）較仔細，花費較高").click());
    expect(seg()?.querySelector(".status-dot")).toBeNull();
    await act(async () =>
      (root.querySelector(".model-anchor .run-seg") as HTMLButtonElement).click(),
    );
    await act(async () =>
      button(
        document.querySelector("[aria-label=選擇模型]") as HTMLElement,
        "Model Bcontext 100K · 推理 低–中",
      ).click(),
    );
    expect(seg()?.querySelector(".status-dot.warn")).not.toBeNull();
    expect(seg()?.textContent).toBe("這個模型不支援推理 高，改用 中：推理中");
    await send("嗨");
    expect(submitted()?.p).toMatchObject({
      model: { provider: "anthropic", id: "model-b" },
      effort: "medium",
    });
    expect(submitted()?.conv).toBeUndefined();
    unmount();
  });

  test("a continuation keeps the conversation's level, moved to the nearest the new model takes", async () => {
    const { root, seg, openConv, send, submitted, unmount } = await ready();
    await openConv("甲");
    await act(async () => button(root, "以另一個模型接續").click());
    const sheet = document.querySelector("[aria-labelledby=model-sheet-title]") as HTMLElement;
    await act(async () => button(sheet, "Model Bmodel-b100K").click());
    await act(async () => button(sheet, "建立接續對話").click());
    expect(seg()?.textContent).toBe("這個模型不支援推理 高，改用 中：推理中");
    await send("繼續");
    expect(submitted()?.p).toMatchObject({ from: "conv-1", effort: "medium" });
    unmount();
  });

  test("thinking used the output up: a card that opens the menu; a moved level in words", async () => {
    const { h, root, menu, openConv, unmount } = await ready();
    await openConv("甲");
    await act(async () => {
      h.last().receive(
        server(
          "notice",
          { code: "effort_clamped", data: { effort: "medium" } },
          { conv: "conv-1" },
        ),
      );
      h.last().receive(server("notice", { code: "effort_truncated" }, { conv: "conv-1" }));
    });
    const cards = () =>
      [...root.querySelectorAll(".thread .task-notice")].map((e) => [
        e.className,
        e.querySelector(".task-notice-title")?.textContent,
        e.querySelector(".task-notice-desc")?.textContent,
      ]);
    // conv-1 asked for 高; the local end said it used 中.
    expect(cards()).toEqual([
      [
        "task-notice warn",
        "模型不支援「高」，已改用「中」",
        "點開右下角的推理強度重選後，這個警告就會消失。",
      ],
      [
        "task-notice warn",
        "輸出上限被思考用完，請降低推理強度",
        "這次請求用完了單次輸出上限，但沒有輸出正文。",
      ],
    ]);
    const card = root.querySelectorAll(".thread .task-notice")[1] as HTMLElement;
    await act(async () => button(card, "調整推理強度").click());
    expect(menu()?.getAttribute("aria-label")).toBe("選擇推理強度");
    await act(async () => button(menu() as HTMLElement, "低（low）回應最快，思考最少").click());
    // Picked again: the downgrade warning is done with; the truncation card stays.
    expect(cards().map((c) => c[1])).toEqual(["輸出上限被思考用完，請降低推理強度"]);
    unmount();
  });

  test("a phone: the level is picked in a sheet", async () => {
    asPhone();
    const { root, seg, menu, openConv, unmount } = await ready();
    await openConv("甲");
    expect(seg()?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => seg()?.click());
    expect(menu()).toBeNull();
    expect(seg()?.getAttribute("aria-expanded")).toBe("true");
    const sheet = document.querySelector("[aria-labelledby=effort-sheet-title]") as HTMLElement;
    expect(sheet.querySelector("h2")?.textContent).toBe("選擇推理強度（Model A）");
    await act(async () => button(sheet, "低（low）回應最快，思考最少").click());
    expect(document.querySelector("[aria-labelledby=effort-sheet-title]")).toBeNull();
    expect(seg()?.getAttribute("aria-expanded")).toBe("false");
    expect(seg()?.textContent).toBe("推理低");
    expect((root.querySelector(".effort-toast") as HTMLElement).hidden).toBe(false);
    unmount();
  });

  /** The composer's text box, typed into and keyed as the owner does. */
  const box = (root: HTMLElement) => {
    const area = root.querySelector("textarea") as HTMLTextAreaElement;
    const type = (value: string) =>
      act(async () => {
        // oxlint-disable-next-line typescript/unbound-method
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        set?.call(area, value);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const press = (key: string) =>
      act(async () => {
        area.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    const rows = () =>
      [...root.querySelectorAll<HTMLElement>(".slash-item")].map((b) => ({
        cmd: b.querySelector(".slash-cmd")?.textContent,
        args: b.querySelector(".slash-args")?.textContent,
        checked: b.querySelector("svg") !== null,
        off: b.getAttribute("aria-disabled") === "true",
      }));
    const label = () => root.querySelector(".slash-group-label")?.textContent;
    const foot = () => root.querySelector(".slash-menu-foot span")?.textContent;
    const said = () => root.querySelector(".composer-inline-err")?.textContent;
    return { area, type, press, rows, label, foot, said };
  };

  test("/effort in the menu, with what goes after it; `/effort ` lists the levels, the one in use checked", async () => {
    const { root, seg, openConv, send, submitted, unmount } = await ready();
    await openConv("甲");
    const b = box(root);
    await b.type("/");
    expect(b.rows().find((r) => r.cmd === "/effort")).toEqual({
      cmd: "/effort",
      args: "<等級>",
      checked: false,
      off: false,
    });
    // Picked from the menu, it opens the second menu.
    await b.type("/eff");
    await b.press("Enter");
    expect(b.area.value).toBe("/effort ");
    expect(b.label()).toBe("選擇推理強度（Model A）");
    expect(b.rows()).toEqual([
      { cmd: "/effort low", args: "低", checked: false, off: false },
      { cmd: "/effort medium", args: "中", checked: false, off: false },
      { cmd: "/effort high", args: "高", checked: true, off: false },
    ]);
    expect(b.foot()).toBe("選取後自下一則訊息生效");
    // Narrowed by the level's name or its word; Enter picks it as the effort control does.
    await b.type("/effort 低");
    expect(b.rows().map((r) => r.cmd)).toEqual(["/effort low"]);
    await b.press("Enter");
    expect(b.area.value).toBe("");
    expect(seg()?.textContent).toBe("推理低");
    const toast = root.querySelector(".effort-toast") as HTMLElement;
    expect([toast.hidden, toast.textContent]).toEqual([false, "下一則訊息起生效"]);
    await send("再想想");
    expect(submitted()).toMatchObject({ conv: "conv-1", p: { text: "再想想", effort: "low" } });
    unmount();
  });

  test("/effort with a level the model lacks says which it takes and keeps the line; with none it opens the control", async () => {
    const { root, seg, menu, openConv, unmount } = await ready();
    await openConv("甲");
    const b = box(root);
    await b.type("/effort max");
    expect(b.rows()).toEqual([]);
    await b.press("Enter");
    expect(b.said()).toBe("不支援的推理強度「max」，此模型可選：low、medium、high");
    expect(b.area.value).toBe("/effort max");
    expect(seg()?.textContent).toBe("推理高");
    await b.type("/effort ");
    await b.press("Escape");
    await b.press("Enter");
    expect(b.area.value).toBe("");
    expect(seg()?.getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.querySelectorAll("[role=menuitemradio]")).toHaveLength(3);
    unmount();
  });

  test("a model that takes no level: the second menu says so and has nothing to pick (14-21)", async () => {
    const { root, openConv, unmount } = await ready();
    await openConv("丙");
    const b = box(root);
    await b.type("/effort ");
    expect(b.label()).toBe("選擇推理強度（Model C）");
    expect(b.rows()).toEqual([{ cmd: "/effort", args: undefined, checked: false, off: true }]);
    expect(root.querySelector(".slash-desc")?.textContent).toBe("這個模型不支援推理強度");
    expect(b.foot()).toBe("沒有可選的推理強度");
    await b.press("Enter");
    expect(b.said()).toBe("這個模型不支援推理強度");
    unmount();
  });

  test("while a turn runs, the levels are listed but cannot be picked, and say why", async () => {
    const { h, root, seg, openConv, unmount } = await ready();
    await openConv("甲");
    await act(async () =>
      h.last().receive(server("turn", { turn: "t-1", state: "started" }, { conv: "conv-1" })),
    );
    const b = box(root);
    await b.type("/effort ");
    expect(b.rows().map((r) => r.off)).toEqual([true, true, true]);
    expect(root.querySelector(".slash-desc")?.textContent).toBe("回合結束後才能改");
    await b.type("/effort low");
    await b.press("Escape");
    await b.press("Enter");
    expect(b.said()).toBe("回合結束後才能改");
    expect(seg()?.textContent).toBe("推理高");
    unmount();
  });

  test("a phone: /effort alone opens the level sheet", async () => {
    asPhone();
    const { root, openConv, unmount } = await ready();
    await openConv("甲");
    const b = box(root);
    await b.type("/effort ");
    await b.press("Escape");
    await b.press("Enter");
    const sheet = document.querySelector("[aria-labelledby=effort-sheet-title]") as HTMLElement;
    expect(sheet.querySelector("h2")?.textContent).toBe("選擇推理強度（Model A）");
    unmount();
  });
});

describe("the model menu: spending by provider, each model's window and levels, a menu on a desktop", () => {
  const MODELS = [
    {
      provider: "anthropic",
      id: "model-a",
      label: "Model A",
      window: 200_000,
      isDefault: true,
      effortLevels: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
    {
      provider: "anthropic",
      id: "model-c",
      label: "Model C",
      window: 128_000,
      isDefault: false,
      effortLevels: [],
    },
    {
      provider: "gemini",
      id: "g",
      label: "G",
      window: 1_000_000,
      isDefault: false,
      effortLevels: ["low", "high"],
      defaultEffort: "low",
    },
  ];
  const CONVS = [
    {
      id: "conv-1",
      title: "甲",
      provider: "anthropic",
      model: "model-a",
      updatedAt: 2,
      effort: "medium",
    },
  ];
  const provider = (name: string, spentUsd: number) => ({
    name,
    spentUsd,
    quotaUsd: 100,
    warnUsd: 80,
    stopUsd: 95,
    stopped: false,
  });
  const media = window.matchMedia;
  afterEach(() => {
    window.matchMedia = media;
  });
  async function ready() {
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
      h.last().receive(server("models.result", { models: MODELS }, { re: asked?.id ?? "" }));
      h.last().receive(
        server("status", {
          now: 1,
          providers: [provider("anthropic", 12.4), provider("gemini", 96)],
          pricesWarn: false,
          pendingApprovals: 0,
          turnRunning: false,
          notify: "ok",
        }),
      );
    });
    const seg = () => r.root.querySelector(".model-anchor .run-seg") as HTMLButtonElement;
    const menu = () =>
      document.querySelector("[role=menu][aria-label=選擇模型]") as HTMLElement | null;
    // Base UI moves a menu's focus by keys on the next frame.
    const key = async (k: string) => {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, bubbles: true }),
        );
      });
      await frame();
    };
    return { h, ...r, seg, menu, key };
  }

  test("a new conversation: groups with their spending, a stopped one closed, each model's line; keys reach what cannot be picked, which says why", async () => {
    const { seg, menu, key, unmount } = await ready();
    await act(async () => seg().click());
    await frame();
    expect(seg().getAttribute("aria-expanded")).toBe("true");
    const heads = [...(menu()?.querySelectorAll(".model-menu-head") ?? [])].map(
      (e) => e.textContent,
    );
    expect(heads).toEqual(["Anthropic本期 12.40 / 100 USD 估", "Gemini已達停用門檻（95%）"]);
    expect(menu()?.querySelector(".model-menu-head .sg-tag.error")?.textContent).toBe(
      "已達停用門檻（95%）",
    );
    const options = [
      ...(menu()?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []),
    ];
    // Base UI marks a menu item off with aria-disabled; it keeps no native disabled.
    const off = (o: HTMLElement) => o.getAttribute("aria-disabled") === "true";
    expect(options.map((o) => [o.textContent, o.getAttribute("aria-checked"), off(o)])).toEqual([
      ["Model Acontext 200K · 推理 低–高", "true", false],
      ["Model Ccontext 128K · 不支援推理強度", "false", false],
      ["Gcontext 1M · 推理 低–高", "false", true],
    ]);
    expect(menu()?.querySelector(".model-menu-note")?.textContent).toBe(
      "這個對話還沒有訊息，可以直接換模型。送出第一則訊息後，模型就綁在對話上。",
    );
    expect(document.activeElement).toBe(options[0]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(options[1]);
    // Base UI keeps an item that is off in the key order, as the WAI-ARIA menu pattern has it:
    // reached, it says why it cannot be picked; Enter on it does nothing.
    await key("ArrowDown");
    expect(document.activeElement).toBe(options[2]);
    await key("Enter");
    expect(menu()).not.toBeNull();
    await key("ArrowDown");
    expect(document.activeElement).toBe(options[0]);
    await key("Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(seg());
    unmount();
  });

  test("a conversation with messages: another model in the menu opens the continue sheet on it, which shows the spending too", async () => {
    const { root, seg, menu, unmount } = await ready();
    await act(async () => (root.querySelector(".conv-item") as HTMLButtonElement).click());
    await act(async () => seg().click());
    expect(menu()?.querySelector(".model-menu-note")?.textContent).toBe(
      "模型綁在對話上。這個對話已有訊息，選另一個模型會開新對話接續。",
    );
    await act(async () =>
      button(menu() as HTMLElement, "Model Ccontext 128K · 不支援推理強度").click(),
    );
    expect(menu()).toBeNull();
    const sheet = document.querySelector("[aria-labelledby=model-sheet-title]") as HTMLElement;
    expect(sheet.querySelector("h2")?.textContent).toBe("以另一個模型接續對話");
    expect(sheet.querySelector(".model-option.selected")?.textContent).toContain("Model C");
    expect([...sheet.querySelectorAll(".provider-group-head")].map((e) => e.textContent)).toEqual([
      "Anthropic本期 12.40 / 100 USD 估",
      "Gemini已達停用門檻（95%）",
    ]);
    const g = [...sheet.querySelectorAll<HTMLButtonElement>(".model-option")].find((b) =>
      b.textContent?.startsWith("G"),
    );
    expect(g?.disabled).toBe(true);
    unmount();
  });

  test("a phone: the model button opens the sheet, not a menu", async () => {
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    const { seg, menu, unmount } = await ready();
    expect(seg().getAttribute("aria-haspopup")).toBe("dialog");
    expect(seg().getAttribute("aria-expanded")).toBe("false");
    await act(async () => seg().click());
    expect(menu()).toBeNull();
    expect(document.querySelector("[aria-labelledby=model-sheet-title] h2")?.textContent).toBe(
      "選擇模型",
    );
    expect(seg().getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="關閉"]')?.click(),
    );
    expect(document.querySelector("[aria-labelledby=model-sheet-title]")).toBeNull();
    expect(seg().getAttribute("aria-expanded")).toBe("false");
    unmount();
  });
});

// main.tsx passes performance.now(): a clock for durations, not for dates. The list's times use the local end's wall clock.
test("the list's times come from the local end's clock, not the page's monotonic one", async () => {
  const h = socketHarness();
  const { root, unmount } = await render(<App socket={h.socket} now={h.now} />);
  const at = new Date(2026, 10, 22, 13, 12).getTime();
  await act(async () => h.last().ready());
  await act(async () => {
    h.last().receive(server("relay.status", { online: true }));
    h.last().receive(
      server("status", {
        now: at + 60_000,
        providers: [],
        pricesWarn: false,
        pendingApprovals: 0,
        turnRunning: false,
        notify: "ok",
      }),
    );
    h.last().receive(
      server("conv.list.result", {
        convs: [
          { id: "c1", title: "今天", provider: "anthropic", model: "m", updatedAt: at },
          {
            id: "c2",
            title: "昨天",
            provider: "anthropic",
            model: "m",
            updatedAt: at - 86_400_000,
          },
        ],
      }),
    );
  });
  expect([...root.querySelectorAll(".conv-item .num")].map((n) => n.textContent)).toEqual([
    "13:12",
    "昨天",
  ]);
  unmount();
});
