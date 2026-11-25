// @vitest-environment jsdom
import type { ServerMessage } from "@tars/protocol";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { render } from "./render.ts";
import { observers, server, socketHarness } from "./testing.ts";

// M4 owner report (iPhone): a card waiting, the turn at 等待核准 and its 停止, after the page was
// away while the approval expired and the turn ended. iOS freezes the page; the socket drops and
// comes back, and the end of both was sent while it was away. The local end then sends the
// pending approvals again after hello (none) and the conversation's snapshot (no running).

const A = "0a1b2c3d-0000-4000-8000-00000000000a";
const T = "turn-00000001";
const APPROVAL = "approval-00000001";

let o: ReturnType<typeof observers>;
beforeEach(() => {
  vi.useFakeTimers();
  o = observers();
});
afterEach(() => {
  o.restore();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const call = {
  seq: 2,
  turn: T,
  kind: "tool_call",
  callId: "call-00000001",
  name: "run_script",
  input: '{"script":"web-md"}',
  truncated: false,
};
const request = server("approval.request", {
  approval: {
    approvalId: APPROVAL,
    conv: A,
    hash: "a".repeat(64),
    action: "run_script",
    script: "web-md",
    version: "v1",
    summary: "把網頁存成 Markdown",
    effects: "external-read",
    domains: ["example.com"],
    secret: null,
    argv: [],
    expiresAt: 600_000,
    callId: "call-00000001",
  },
});

async function waiting() {
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  const receive = (m: ServerMessage) => act(async () => h.last().receive(m));
  const connect = async () => {
    await act(async () => h.last().ready());
    await receive(server("relay.status", { online: true, localSince: 1 }));
    await receive(
      server("conv.list.result", {
        convs: [{ id: A, title: "存網頁", provider: "anthropic", model: "m", updatedAt: 1 }],
      }),
    );
  };
  await connect();
  await act(async () => r.root.querySelector<HTMLButtonElement>(".conv-item")?.click());
  const user = { seq: 1, turn: T, kind: "user", text: "存這頁", truncated: false };
  await receive(
    server(
      "conv.snapshot",
      {
        epoch: "epoch-1",
        more: false,
        items: [user, call],
        running: { turn: T, text: "", truncated: false, phase: "waiting_approval" },
      },
      { conv: A },
    ),
  );
  await receive(request);
  /** What is on screen that says the turn or the card is still live. */
  const live = () => {
    const card = r.root.querySelector<HTMLElement>(".approval-card");
    const deny = card?.querySelector<HTMLButtonElement>(".sg-btn-danger");
    return {
      status: r.root.querySelector(".turn-status")?.textContent ?? null,
      stop: [...r.root.querySelectorAll("button")].some((b) => b.textContent === "停止"),
      card:
        card === null ? null : (card.querySelector(".approval-state, .sg-tag")?.textContent ?? ""),
      deny: deny === null || deny === undefined ? null : !deny.disabled,
    };
  };
  return { h, ...r, receive, connect, live, user };
}

test("the precondition: a turn waiting on a card, with 停止", async () => {
  const p = await waiting();
  expect(p.live()).toMatchObject({ status: "等待核准", stop: true, deny: true });
  p.unmount();
});

test.each([
  ["30 s", 30_000],
  ["past the card's expiry", 700_000],
])(
  "away %s while it expired and the turn ended: back, the snapshot without running ends both",
  async (_, away) => {
    const p = await waiting();
    await act(async () => p.h.last().end(1006));
    await p.h.advance(away);
    await p.connect();
    const open = p.h
      .last()
      .messages()
      .filter((m) => m.kind === "conv.open");
    expect(open.map((m) => m.conv)).toEqual([A]);
    const expired = {
      seq: 3,
      turn: T,
      kind: "tool_result",
      callId: "call-00000001",
      status: "expired",
      text: "",
      truncated: false,
    };
    await p.receive(
      server(
        "conv.snapshot",
        { epoch: "epoch-1", more: false, items: [p.user, call, expired] },
        { conv: A },
      ),
    );
    expect(p.live()).toMatchObject({ status: null, stop: false, deny: null });
    p.unmount();
  },
);

const without = (items: unknown[]) =>
  server("conv.snapshot", { epoch: "epoch-1", more: false, items }, { conv: A });

test("one sent and not yet started stays 送出中 through a snapshot without running", async () => {
  const p = await waiting();
  await p.receive(without([p.user, call]));
  const box = p.root.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    // oxlint-disable-next-line typescript/unbound-method
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(box, "再試一次");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...p.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "送出")
      ?.click(),
  );
  const submit = p.h
    .last()
    .messages()
    .findLast((m) => m.kind === "turn.submit");
  expect(submit).toBeDefined();
  const busy = () => p.root.querySelector(".composer")?.textContent ?? "";
  expect(busy()).toContain("送出中");
  await p.receive(without([p.user, call]));
  expect(busy()).toContain("送出中");
  // Its start still comes and is drawn.
  await p.receive(
    server(
      "turn",
      { state: "started", turn: "turn-00000002", requestId: submit?.p["requestId"] as string },
      { conv: A },
    ),
  );
  expect(p.live().status).not.toBeNull();
  p.unmount();
});

test("a snapshot without running leaves a decided card, and another conversation's waiting one", async () => {
  const p = await waiting();
  const other = "0a1b2c3d-0000-4000-8000-00000000000b";
  await p.receive(
    server("approval.request", {
      approval: {
        ...(request.p as { approval: Record<string, unknown> }).approval,
        approvalId: "approval-00000002",
        conv: other,
        script: "other-script",
        callId: "call-00000009",
      },
    }),
  );
  await p.receive(
    server("approval.resolved", { approvalId: APPROVAL, state: "denied", via: "remote" }),
  );
  await p.receive(without([p.user, call]));
  const cards = [...p.root.querySelectorAll(".approval-card")].map(
    (c) => c.querySelector(".approval-head .sg-tag")?.textContent,
  );
  expect(cards).toHaveLength(2);
  expect(cards.some((t) => t === "待核准")).toBe(true);
  expect(p.root.textContent).toContain("other-script");
  p.unmount();
});
