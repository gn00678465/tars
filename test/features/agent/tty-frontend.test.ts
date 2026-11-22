import { describe, expect, test } from "bun:test";
import { TarsError } from "../../../src/core/exit.ts";
import { REASON_TEXT } from "../../../src/features/agent/engine.ts";
import {
  approvalCard,
  argvText,
  noticeText,
  TtyFrontend,
  visible,
} from "../../../src/features/agent/tty-frontend.ts";
import {
  NOTICE_CODES,
  ZERO_USAGE,
  type ApprovalRecord,
  type Item,
  type UserItem,
} from "../../../src/features/agent/types.ts";
import { captureIo, scriptedTerminal } from "../../helpers.ts";

const noTerminal = () => {
  throw new TarsError("no terminal");
};

function frontend(openTerminal: () => ReturnType<typeof scriptedTerminal> = noTerminal as never) {
  const io = captureIo();
  return { io, fe: new TtyFrontend(io, openTerminal, (id) => id / 100) };
}

const item = (i: Omit<Item, "turnId" | "seq">): Item => ({ seq: 1, turnId: "t", ...i }) as Item;

const APPROVAL: ApprovalRecord = {
  id: "01a1f461-1658-7002-a9cf-f903d4f890a4",
  toolCallId: "call-1",
  convId: "conv-1",
  hash: "h",
  state: "pending",
  createdAt: 0,
  expiresAt: Date.parse("2026-11-19T12:10:00Z"),
  fields: {
    action: "run_script",
    script: "pusher",
    version: "v-123",
    summary: "push a note",
    effects: "external-write",
    domains: ["api.example.com"],
    secret: "bark",
    argv: ["script", "run", "pusher", "--expect-version", "v-123", "--", "hi"],
    expiresAt: Date.parse("2026-11-19T12:10:00Z"),
    approvalId: "01a1f461-1658-7002-a9cf-f903d4f890a4",
  },
};

describe("streams", () => {
  test("delta goes to stdout only, as written", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "delta", text: "hel" });
    fe.emit({ type: "delta", text: "lo" });
    expect(io.stdout).toEqual(["hel", "lo"]);
    expect(io.stderr).toEqual([]);
  });

  test("on a terminal, an open reply line ends with a newline before a diagnostic", () => {
    const io = { ...captureIo(), stdoutIsTty: true };
    const fe = new TtyFrontend(io, noTerminal as never, () => 0);
    fe.emit({ type: "delta", text: "partial" });
    fe.emit({ type: "notice", code: "effort_unsupported" });
    expect(io.stdout).toEqual(["partial", "\n"]);
    expect(io.stderr).toHaveLength(1);
  });

  test("redirected, a tool call between two deltas adds nothing to stdout until the turn ends", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "delta", text: "one" });
    fe.emit({
      type: "item",
      item: item({
        kind: "tool_call",
        step: 1,
        body: { callId: "c", providerCallId: "p", name: "tars", input: { argv: ["memory"] } },
      }),
    });
    fe.emit({ type: "notice", code: "effort_unsupported" });
    fe.emit({ type: "delta", text: "two" });
    fe.emit({ type: "turn_end", state: "completed", costUsd: 0, usage: ZERO_USAGE, requests: 2 });
    expect(io.stdout.join("")).toBe("onetwo\n");
    expect(io.stderr).toHaveLength(3);
  });

  test("an empty delta after a newline does not reopen the line", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "delta", text: "line\n" });
    fe.emit({ type: "delta", text: "" });
    fe.emit({ type: "turn_end", state: "completed", costUsd: 0, usage: ZERO_USAGE, requests: 1 });
    expect(io.stdout.join("")).toBe("line\n");
  });

  test("a reply already ending in a newline gets no extra one", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "delta", text: "line\n" });
    fe.emit({ type: "notice", code: "effort_unsupported" });
    expect(io.stdout).toEqual(["line\n"]);
  });

  test("turn_end ends the reply line and prints usage on stderr", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "delta", text: "done" });
    fe.emit({
      type: "turn_end",
      state: "completed",
      costUsd: 0.5,
      usage: { ...ZERO_USAGE, uncachedInputTokens: 10, cacheReadTokens: 5, outputTokens: 7 },
      requests: 2,
    });
    expect(io.stdout).toEqual(["done", "\n"]);
    expect(io.stderr).toEqual([
      "用量：輸入 15（快取讀 5、寫 0）、輸出 7（思考 0），2 個請求，0.50 USD",
    ]);
  });

  test("a failed turn_end prints the reason text and the detail", () => {
    const { io, fe } = frontend();
    fe.emit({
      type: "turn_end",
      state: "failed",
      reason: "bad_request",
      detail: "messages: invalid",
      costUsd: 0,
      usage: ZERO_USAGE,
      requests: 1,
    });
    expect(io.stderr[1]).toBe(`失敗：${REASON_TEXT.bad_request}\nmessages: invalid`);
    expect(io.stdout).toEqual([]);
  });

  test("an aborted turn_end says so", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "turn_end", state: "aborted", costUsd: 0, usage: ZERO_USAGE, requests: 1 });
    expect(io.stderr.at(-1)).toBe("已中止");
  });
});

describe("items and notices", () => {
  test("turn_start and approval_resolved print nothing: the owner typed and answered here", () => {
    const { io, fe } = frontend();
    expect(fe.via).toBe("tty");
    fe.emit({
      type: "turn_start",
      convId: "c",
      turnId: "t",
      items: [item({ step: 0, kind: "user", body: { text: "hi" } }) as UserItem],
    });
    fe.emit({
      type: "approval_resolved",
      approvalId: APPROVAL.id,
      state: "approved",
      via: "tty",
      at: 1,
    });
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([]);
  });

  test("thinking is shown once per request; a usage item starts the next request", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "thinking" });
    fe.emit({ type: "thinking" });
    fe.emit({ type: "item", item: item({ step: 1, kind: "usage", body: { usageId: 1 } }) });
    fe.emit({ type: "thinking" });
    expect(io.stderr).toEqual(["（思考中）", "（思考中）"]);
  });

  test("a tars tool call shows its argv; the read tools show their name or path", () => {
    const { io, fe } = frontend();
    const call = (name: string, input: unknown) =>
      fe.emit({
        type: "item",
        item: item({
          step: 1,
          kind: "tool_call",
          body: { callId: "c", providerCallId: "p", name, input },
        }),
      });
    call("tars", { argv: ["script", "run", "weather", "--", "Taipei"] });
    call("skill_load", { name: "demo" });
    call("file_read", { path: "tars-mode/playbooks/x.md" });
    expect(io.stderr).toEqual([
      "→ tars script run weather -- Taipei",
      "→ skill_load demo",
      "→ file_read tars-mode/playbooks/x.md",
    ]);
  });

  test("a tool result shows its status and the first 5 lines", () => {
    const { io, fe } = frontend();
    fe.emit({
      type: "item",
      item: item({
        step: 1,
        kind: "tool_result",
        body: { callId: "c", status: "done", text: "1\n2\n3\n4\n5\n6\n7", truncated: false },
      }),
    });
    expect(io.stderr).toEqual(["← done\n  1\n  2\n  3\n  4\n  5"]);
  });

  test("a compaction item shows its count, size and the cost of its usage row", () => {
    const { io, fe } = frontend();
    fe.emit({
      type: "item",
      item: item({
        step: 1,
        kind: "compaction",
        body: {
          firstKeptSeq: 5,
          summary: "s",
          tokensBefore: 152000,
          replacedCount: 12,
          trigger: "auto",
          usageId: 25,
        },
      }),
    });
    expect(io.stderr).toEqual(["已壓縮 12 個項目。壓縮前約 152000 tokens，花費 0.25 USD"]);
  });

  test("user, assistant, usage and error items print nothing", () => {
    const { io, fe } = frontend();
    fe.emit({ type: "item", item: item({ step: 0, kind: "user", body: { text: "hi" } }) });
    fe.emit({
      type: "item",
      item: item({
        step: 1,
        kind: "assistant",
        body: { text: "x", state: "complete", native: [] },
      }),
    });
    fe.emit({
      type: "item",
      item: item({ step: 1, kind: "error", body: { code: "auth", message: "m" } }),
    });
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toEqual([]);
  });

  test("every notice code renders a non-empty line on stderr", () => {
    const data = {
      reason: "daily_cap",
      spentUsd: 81,
      quotaUsd: 100,
      days: 40,
      percent: 62,
      autoCompact: "on",
      attempt: 1,
      waitMs: 2000,
      maxTokens: 4000,
      effort: "high",
    };
    for (const code of NOTICE_CODES) {
      const { io, fe } = frontend();
      fe.emit({ type: "notice", code, data });
      expect(io.stderr).toHaveLength(1);
      expect(io.stderr[0]?.trim()).not.toBe("");
      expect(io.stderr[0]).not.toContain("undefined");
      expect(io.stdout).toEqual([]);
    }
  });

  test("notices with data put the values in", () => {
    expect(noticeText("compact_failed", { reason: "compact_bad_summary" })).toContain(
      REASON_TEXT.compact_bad_summary,
    );
    expect(noticeText("retrying", { attempt: 2, waitMs: 8000 })).toContain("8 秒");
    expect(noticeText("blocked", { reason: "memory remember 不在白名單上" })).toContain(
      "memory remember",
    );
    expect(noticeText("effort_clamped", { effort: "high" })).toContain("high");
  });
});

describe("askApproval", () => {
  const signal = () => new AbortController().signal;

  test("without a terminal: the approval_no_tty notice and denied", async () => {
    const { io, fe } = frontend();
    expect(await fe.askApproval(APPROVAL, signal())).toBe("denied");
    expect(io.stderr).toEqual([noticeText("approval_no_tty")]);
  });

  test("the terminal is opened once, on the first approval", async () => {
    let opened = 0;
    const terminal = scriptedTerminal(["yes", "yes"]);
    const { fe } = frontend(() => {
      opened++;
      return terminal;
    });
    await fe.askApproval(APPROVAL, signal());
    await fe.askApproval(APPROVAL, signal());
    expect(opened).toBe(1);
    fe.close();
    expect(terminal.closed).toBe(true);
  });

  test("yes approves; the card is written to the terminal before the question", async () => {
    const terminal = scriptedTerminal([" yes "]);
    const { io, fe } = frontend(() => terminal);
    expect(await fe.askApproval(APPROVAL, signal())).toBe("approved");
    expect(terminal.transcript).toEqual([approvalCard(APPROVAL), "核准？輸入 yes 或 no："]);
    expect(io.stdout).toEqual([]);
  });

  test("any other answer, an empty line or end of input denies", async () => {
    for (const answer of ["no", "y", "", undefined]) {
      const { fe } = frontend(() => scriptedTerminal([answer]));
      expect(await fe.askApproval(APPROVAL, signal())).toBe("denied");
    }
  });

  test("a cancelled read is cancelled; another terminal error denies", async () => {
    const failing = (message: string) =>
      scriptedTerminal([
        () => {
          throw new TarsError(message);
        },
      ]);
    expect(await frontend(() => failing("cancelled")).fe.askApproval(APPROVAL, signal())).toBe(
      "cancelled",
    );
    expect(
      await frontend(() => failing("cannot read from the terminal")).fe.askApproval(
        APPROVAL,
        signal(),
      ),
    ).toBe("denied");
  });

  test("an aborted signal while waiting is cancelled", async () => {
    const controller = new AbortController();
    const terminal = scriptedTerminal([() => new Promise(() => {})]);
    const { fe } = frontend(() => terminal);
    const answer = fe.askApproval(APPROVAL, controller.signal);
    controller.abort();
    expect(await answer).toBe("cancelled");
  });

  test("the card holds every field the owner approves", () => {
    const card = approvalCard(APPROVAL);
    for (const part of [
      "pusher",
      "v-123",
      "push a note",
      "external-write",
      "api.example.com",
      "bark",
      "tars script run pusher --expect-version v-123 -- hi",
      "2026-11-19T12:10:00.000Z",
      "f903d4f890a4".slice(-8),
    ])
      expect(card).toContain(part);
    expect(
      approvalCard({ ...APPROVAL, fields: { ...APPROVAL.fields, secret: null, domains: [] } }),
    ).toContain("金鑰：（無）");
  });
});

describe("what reaches the screen", () => {
  const withArgv = (argv: string[]) =>
    approvalCard({ ...APPROVAL, fields: { ...APPROVAL.fields, argv } });
  const ESC = "\u001b";

  test("argument boundaries show: one argument with a space differs from two", () => {
    const one = withArgv(["script", "run", "pusher", "--", "a b"]);
    const two = withArgv(["script", "run", "pusher", "--", "a", "b"]);
    expect(one).not.toBe(two);
    expect(one).toContain('-- "a b"');
    expect(two).toContain("-- a b");
  });

  test("empty, blank, quoted and multi-line arguments are each visible", () => {
    expect(argvText(["", " ", 'say "hi"', "a\\b", "line1\nline2", "tab\there"])).toBe(
      '"" " " "say \\"hi\\"" "a\\\\b" "line1\\nline2" "tab\\there"',
    );
    expect(argvText(["Taipei", "台北", "--city=x/y.z"])).toBe("Taipei 台北 --city=x/y.z");
  });

  test("control characters in argv and in fields never reach the terminal raw", () => {
    const card = approvalCard({
      ...APPROVAL,
      fields: {
        ...APPROVAL.fields,
        summary: `ok${ESC}[2J\r\nfake line`,
        argv: ["script", "run", "pusher", "--", `x${ESC}[8m`, "\u202eevil", "\u0085", "\u007f"],
      },
    });
    // oxlint-disable-next-line no-control-regex -- the test looks for exactly these
    expect(card).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
    expect(card).toContain("用途：ok\\u{1b}[2J\\r\\nfake line");
    expect(card).toContain('"x\\u{1b}[8m" "\\u{202e}evil" "\\u{85}" "\\u{7f}"');
    expect(card.split("\n").filter((l) => l.startsWith("用途："))).toHaveLength(1);
  });

  test("tool lines and results on stderr escape controls but keep line breaks", () => {
    const { io, fe } = frontend();
    fe.emit({
      type: "item",
      item: item({
        kind: "tool_call",
        step: 1,
        body: {
          callId: "c",
          providerCallId: "p",
          name: "tars",
          input: { argv: ["script", `${ESC}[2J`] },
        },
      }),
    });
    fe.emit({
      type: "item",
      item: item({
        kind: "tool_result",
        step: 1,
        body: { callId: "c", status: "done", text: `one${ESC}[31m\ntwo\r` },
      }),
    });
    const err = io.stderr.join("\n");
    expect(err).not.toContain(ESC);
    expect(err).not.toContain("\r");
    expect(io.stderr[0]).toBe('→ tars script "\\u{1b}[2J"');
    expect(io.stderr[1]).toBe("← done\n  one\\u{1b}[31m\n  two\\r");
  });

  test("the reply is escaped on a terminal and byte for byte when redirected", () => {
    const text = `hi${ESC}[8m\tthere\n`;
    const piped = frontend();
    piped.fe.emit({ type: "delta", text });
    expect(piped.io.stdout).toEqual([text]);
    const io = { ...captureIo(), stdoutIsTty: true };
    new TtyFrontend(io, noTerminal as never, () => 0).emit({ type: "delta", text });
    expect(io.stdout).toEqual(["hi\\u{1b}[8m\tthere\n"]);
    expect(visible("a\u2066b")).toBe("a\\u{2066}b");
  });
});
