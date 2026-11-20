import type { Database } from "bun:sqlite";
import type { Env, TarsPaths } from "../../core/paths.ts";
import type { Provider, SecretStore } from "../../core/secrets.ts";
import { isRecord } from "../script/metadata.ts";
import { loadBoot } from "../session/boot.ts";
import * as approvals from "./approvals.ts";
import { estimateTokens, utf8Bytes } from "./bytes.ts";
import {
  buildActiveHistory,
  buildSummaryPrompt,
  latestCompaction,
  planCompaction,
  sentBytes,
  SUMMARIZATION_SYSTEM,
  validateSummary,
} from "./compaction.ts";
import type { WikiSpend } from "../wiki/db.ts";
import type { Limits, ProviderConfig } from "./config.ts";
import { effectiveEffort } from "./effort.ts";
import type { Frontend } from "./frontend.ts";
import {
  effectiveWindow,
  estimateInput,
  insertReserved,
  limitReached,
  recordEnd,
  reserve,
  spent,
  turnSpent,
} from "./ledger.ts";
import type { Log } from "./log.ts";
import {
  buildSystem,
  loadSkillIndex,
  prefixKey,
  thinkingKey,
  TOOL_SPECS,
  type SkillEntry,
} from "./prompt.ts";
import type { AdapterFor } from "./provider.ts";
import {
  consume,
  errorText,
  failureOf,
  prepareModel,
  REASON_TEXT,
  rejected,
  retryWait,
  settleFailure,
  type Consumed,
  type Rejected,
  type Setup,
} from "./request.ts";
import * as store from "./store.ts";
import { classify, REFUSAL_TEXT, runSelf, toolText, type Classified } from "./tars-tool.ts";
import { runTool, type ToolOutcome } from "./tools.ts";
import {
  ZERO_USAGE,
  type CompactionItem,
  type ContextItem,
  type Effort,
  type FailReason,
  type Item,
  type ModelRequest,
  type NewItem,
  type ReasonCode,
  type SystemBlock,
  type ToolCallEndState,
  type ToolCallItem,
  type TurnState,
  type Usage,
} from "./types.ts";

export { REASON_TEXT };

export interface EngineDeps {
  readonly db: Database;
  readonly paths: TarsPaths;
  readonly env: Env;
  readonly secrets: SecretStore;
  readonly adapterFor: AdapterFor;
  readonly selfCommand: readonly string[];
  approveCommand(name: string): string;
  now(): Date;
  /** Resolves after `ms`, or as soon as the signal fires. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  readonly log: Log;
  /** Setup warnings: a cleared ANTHROPIC_* variable, a skill without front matter. */
  warn(message: string): void;
  /** What wiki sync spent with this provider; undefined when wiki.db cannot be read. */
  otherSpend(provider: Provider, cfg: ProviderConfig, now: Date): WikiSpend | undefined;
}

export interface TurnInput {
  /** Absent: the turn starts a conversation. */
  readonly convId?: string;
  readonly provider: Provider;
  readonly model: string;
  /** The conversation's level; what is sent may be lower (effectiveEffort). */
  readonly effort: Effort;
  readonly text: string;
}

type EndState = Exclude<TurnState, "running" | "interrupted">;

export type TurnOutcome =
  | Rejected
  | {
      readonly kind: "ended";
      readonly convId: string;
      readonly turnId: string;
      readonly state: EndState;
      readonly reason?: FailReason;
    };

export type CompactOutcome =
  | { readonly kind: "compacted"; readonly item: CompactionItem; readonly costUsd: number }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "failed";
      readonly reason: ReasonCode;
      readonly message: string;
      readonly detail?: string;
    }
  | { readonly kind: "aborted" };

/** The new message's place before it has a seq: after everything stored. */
const PENDING_SEQ = Number.MAX_SAFE_INTEGER;

const TEXT = {
  skipped: "前一個動作沒有執行，這個已略過",
  interrupted: "中斷，結果不明",
  denied: "擁有者拒絕，沒有執行",
  expired: "核准已過期，沒有執行",
  cancelled: "已取消，沒有執行",
  changed: "腳本或路徑在核准後變了，沒有執行",
};

export const sleepAbortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

const addUsage = (a: Usage, b: Usage): Usage => ({
  uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  thinkingTokens: a.thinkingTokens + b.thinkingTokens,
});

/** A chat turn while it runs. */
interface Turn {
  readonly s: Setup;
  readonly convId: string;
  readonly turnId: string;
  readonly effort: Effort | undefined;
  readonly system: readonly SystemBlock[];
  readonly skills: readonly SkillEntry[];
  readonly prefix: string;
  readonly thinkingKey: string;
  readonly frontend: Frontend;
  readonly signal: AbortSignal;
  step: number;
  usage: Usage;
}

/** A call that stops the rest of its step; with `end`, the turn ends after the step. */
interface Halt {
  readonly end?: { readonly state: "failed" | "aborted"; readonly reason?: FailReason };
}

export function createEngine(deps: EngineDeps) {
  const { db } = deps;
  /** effort_unsupported and compact_skipped: once per conversation per process. */
  const effortNoticed = new Set<string>();
  const skipNoticed = new Set<string>();

  const activeHistory = (convId: string) => buildActiveHistory(store.readActiveItems(db, convId));
  const historyBytes = (items: readonly ContextItem[], limits: Limits) =>
    items.reduce((n, i) => n + sentBytes(i, limits.tool_result_bytes), 0);
  /** Read at every check, never kept: rather not send than count short. */
  const otherSpend = (s: Setup) => deps.otherSpend(s.model.provider, s.cfg, deps.now());

  /**
   * The input tokens a chat request with this history is expected to take. The last measured
   * total only stands for what came before it under the same prefix: after SOUL.md, MEMORY.md or
   * the skills change, everything is counted again from bytes.
   */
  function estimateChat(
    t: Pick<Turn, "s" | "system" | "prefix">,
    conv: store.Conversation | undefined,
    history: readonly ContextItem[],
  ): number {
    const fixed =
      utf8Bytes(JSON.stringify(TOOL_SPECS)) + t.system.reduce((n, b) => n + utf8Bytes(b.text), 0);
    const lastSeq = conv === undefined ? 0 : store.lastFinalUsageSeq(db, conv.id);
    return estimateInput({
      fullBytes: fixed + historyBytes(history, t.s.limits),
      newBytes: historyBytes(
        history.filter((i) => i.seq > lastSeq),
        t.s.limits,
      ),
      lastTotal: conv?.lastPrefixKey === t.prefix ? conv.lastTotalInputTokens : 0,
    });
  }

  function reserveChat(
    t: Pick<Turn, "s" | "system" | "prefix">,
    conv: store.Conversation | undefined,
    history: readonly ContextItem[],
    turnId: string | undefined,
  ) {
    const { s } = t;
    const other = otherSpend(s);
    if (other === undefined) return { ok: false, reason: "budget_unreadable" } as const;
    const estInput = estimateChat(t, conv, history);
    return reserve({
      other,
      db,
      provider: s.cfg,
      limits: s.limits,
      model: s.model,
      conv,
      prefixKey: t.prefix,
      estInput,
      turnId,
      turnKind: "chat",
      maxOutput: Math.min(s.limits.max_output_tokens, s.model.maxOutput),
      now: deps.now(),
    });
  }

  function insertRequest(
    s: Setup,
    ids: { turnId: string; convId: string; step: number; attempt: number },
    r: { maxTokens: number; inputUsd: number },
  ): number {
    const usageId = insertReserved(db, {
      ...ids,
      model: s.model,
      cacheTtl: s.limits.cache_ttl,
      maxTokens: r.maxTokens,
      inputUsd: r.inputUsd,
      now: deps.now(),
    });
    store.addTurnRequest(db, ids.turnId);
    return usageId;
  }

  function append(convId: string, turnId: string, items: readonly NewItem[]): Item[] {
    const seqs = store.appendItems(db, convId, turnId, items, deps.now().getTime());
    return items.map((item, i) => ({ ...item, seq: seqs[i] as number, turnId }) as Item);
  }

  // --- Chat turns.

  async function runTurn(
    input: TurnInput,
    frontend: Frontend,
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    const s = await prepareModel(deps, input.provider, input.model);
    if ("kind" in s) return s;
    if (otherSpend(s) === undefined) return rejected("budget_unreadable");
    let system: SystemBlock[];
    let skills: SkillEntry[];
    try {
      const boot = await loadBoot(deps.paths);
      const index = await loadSkillIndex(deps.paths);
      index.warnings.forEach((w) => deps.warn(w));
      skills = index.skills;
      system = buildSystem(boot, skills);
    } catch (err) {
      return rejected("boot_failed", errorText(err));
    }
    const choice = effectiveEffort(s.model, input.effort);
    const prefix = prefixKey({
      model: s.model.id,
      effort: choice.effort,
      cacheTtl: s.limits.cache_ttl,
      toolResultBytes: s.limits.tool_result_bytes,
      system,
      tools: TOOL_SPECS,
    });
    const pending: ContextItem = {
      seq: PENDING_SEQ,
      turnId: "",
      step: 0,
      kind: "user",
      body: { text: input.text },
    };
    const read = (convId: string | undefined) => {
      const conv = convId === undefined ? undefined : store.getConversation(db, convId);
      const items = conv === undefined ? [] : store.readActiveItems(db, conv.id);
      return { conv, items, history: [...buildActiveHistory(items), pending] };
    };
    let current = read(input.convId);
    if (current.conv !== undefined) {
      const aborted = await autoCompact(
        s,
        current.conv,
        estimateChat({ s, system, prefix }, current.conv, current.history),
        frontend,
        signal,
      );
      if (aborted) return rejected("aborted");
      current = read(input.convId);
    }
    const { conv, items, history } = current;
    const first = reserveChat({ s, system, prefix }, conv, history, undefined);
    if (!first.ok) return rejected(first.reason);

    const convId = conv?.id ?? store.newId();
    const turnId = store.newId();
    const now = deps.now().getTime();
    let usageId = 0;
    db.transaction(() => {
      if (conv === undefined)
        store.createConversation(db, {
          id: convId,
          text: input.text,
          provider: input.provider,
          model: input.model,
          effort: input.effort,
          now,
        });
      store.beginTurn(db, { id: turnId, convId, kind: "chat", effort: choice.effort ?? null, now });
      append(convId, turnId, [{ kind: "user", step: 0, body: { text: input.text } }]);
      usageId = insertRequest(s, { turnId, convId, step: 1, attempt: 1 }, first);
    })();
    deps.log.log("turn_start", { turn: turnId, conv: convId, turnKind: "chat" });

    if (s.pricesWarn)
      frontend.emit({ type: "notice", code: "prices_warn", data: { days: s.priceAgeDays } });
    if (choice.notice === "effort_clamped")
      frontend.emit({ type: "notice", code: "effort_clamped", data: { effort: choice.effort } });
    if (choice.notice === "effort_unsupported" && !effortNoticed.has(convId)) {
      effortNoticed.add(convId);
      frontend.emit({ type: "notice", code: "effort_unsupported" });
    }
    const t: Turn = {
      s,
      convId,
      turnId,
      effort: choice.effort,
      system,
      skills,
      prefix,
      // Fixed for the turn: a compaction or a new system only happens before a turn starts.
      thinkingKey: thinkingKey({
        system,
        tools: TOOL_SPECS,
        toolResultBytes: s.limits.tool_result_bytes,
        compactionId: latestCompaction(items)?.turnId ?? "",
      }),
      frontend,
      signal,
      step: 1,
      usage: ZERO_USAGE,
    };
    return chatLoop(t, { usageId, maxTokens: first.maxTokens, capped: first.capped });
  }

  /**
   * true when an automatic compaction was aborted, and the message must not be sent. It is judged
   * on the estimate the reservation checks next, and the compact line is below the stop line, so
   * a message is never stopped for length without a compaction tried first.
   */
  async function autoCompact(
    s: Setup,
    conv: store.Conversation,
    estInput: number,
    frontend: Frontend,
    signal: AbortSignal,
  ): Promise<boolean> {
    const line = effectiveWindow(s.model, s.limits) * s.limits.context_compact_ratio;
    if (!s.limits.auto_compact || estInput < line) return false;
    const r = await compactWith(s, conv, { trigger: "auto" }, frontend, signal);
    if (r.kind === "aborted") return true;
    if (r.kind === "skipped" && !skipNoticed.has(conv.id)) {
      skipNoticed.add(conv.id);
      frontend.emit({ type: "notice", code: "compact_skipped" });
    }
    if (r.kind === "failed")
      frontend.emit({ type: "notice", code: "compact_failed", data: { reason: r.reason } });
    return false;
  }

  interface Reserved {
    readonly usageId: number;
    readonly maxTokens: number;
    readonly capped: boolean;
  }

  async function chatLoop(t: Turn, first: Reserved): Promise<TurnOutcome> {
    let next: Reserved | undefined = first;
    let attempt = 1;
    for (;;) {
      if (next === undefined) {
        if (store.turnRequests(db, t.turnId) >= t.s.limits.max_requests_per_turn)
          return endTurn(t, "failed", "request_limit");
        const r = reserveChat(
          t,
          store.getConversation(db, t.convId),
          activeHistory(t.convId),
          t.turnId,
        );
        if (!r.ok) return endTurn(t, "failed", r.reason);
        const ids = { turnId: t.turnId, convId: t.convId, step: t.step, attempt };
        next = { usageId: db.transaction(() => insertRequest(t.s, ids, r))(), ...r };
      }
      const { usageId, maxTokens, capped } = next;
      next = undefined;
      if (capped) t.frontend.emit({ type: "notice", code: "output_capped", data: { maxTokens } });
      deps.log.log("request", { turn: t.turnId, step: t.step, attempt });
      const got = await consume(
        db,
        t.s.adapter,
        chatRequest(t, maxTokens),
        usageId,
        t.signal,
        (ev) => t.frontend.emit(ev),
      );
      if (got.error !== undefined) {
        settleFailure(db, usageId, got);
        const wait = retryWait(got.error, attempt);
        if (wait !== undefined) {
          t.frontend.emit({ type: "notice", code: "retrying", data: { attempt, waitMs: wait } });
          deps.log.log("retry", { turn: t.turnId, errorKind: got.error.kind, attempt, ms: wait });
          await deps.sleep(wait, t.signal);
          if (t.signal.aborted) return endTurn(t, "aborted");
          attempt++;
          continue;
        }
        const reason = failureOf(got.error);
        writePartial(t, got.text, reason === "aborted" ? "aborted" : "incomplete");
        return reason === "aborted"
          ? endTurn(t, "aborted")
          : endTurn(t, "failed", reason, got.error.detail);
      }
      const end = got.end as NonNullable<Consumed["end"]>;
      const calls = recordAnswer(t, usageId, got, end);
      if (end.stop !== "tool_use" || calls.length === 0) return endTurn(t, "completed");
      const halt = await runCalls(t, calls);
      if (halt !== undefined) return endTurn(t, halt.state, halt.reason);
      t.step++;
      attempt = 1;
    }
  }

  function chatRequest(t: Turn, maxTokens: number): ModelRequest {
    const { limits, model } = t.s;
    return {
      model: model.id,
      maxOutputTokens: maxTokens,
      system: t.system,
      tools: TOOL_SPECS,
      history: activeHistory(t.convId),
      cacheTtl: limits.cache_ttl,
      cacheHistory: true,
      ...(t.effort === undefined ? {} : { effort: t.effort }),
      toolResultBytes: limits.tool_result_bytes,
      thinkingKey: t.thinkingKey,
      capabilities: { thinkingTypes: model.thinkingTypes },
    };
  }

  /** What arrived before the response broke off: its text only, never a partial native. */
  function writePartial(t: Turn, text: string, state: "aborted" | "incomplete"): void {
    if (text === "") return;
    const [item] = append(t.convId, t.turnId, [
      { kind: "assistant", step: t.step, body: { text, state, native: null } },
    ]);
    t.frontend.emit({ type: "item", item: item as Item });
  }

  /** end arrived: usage final, the answer and its tool calls stored, in one transaction. */
  function recordAnswer(
    t: Turn,
    usageId: number,
    got: Consumed,
    end: NonNullable<Consumed["end"]>,
  ): ToolCallItem[] {
    const native = end.native.length > 0 ? end.native : null;
    const answer: NewItem[] =
      native === null && got.text === ""
        ? []
        : [
            {
              kind: "assistant",
              step: t.step,
              body: {
                text: got.text,
                state: end.stop === "max_tokens" ? "truncated" : "complete",
                native,
                thinkingKey: t.thinkingKey,
              },
            },
          ];
    const calls: NewItem[] =
      end.stop === "tool_use"
        ? got.calls.map((c) => ({
            kind: "tool_call",
            step: t.step,
            body: {
              callId: store.newId(),
              providerCallId: c.providerCallId,
              name: c.name,
              input: c.input,
            },
          }))
        : [];
    const written = db.transaction(() => {
      recordEnd(db, {
        usageId,
        usage: end.usage,
        ...(end.costUsd === undefined ? {} : { costUsd: end.costUsd }),
        turnKind: "chat",
        prefixKey: t.prefix,
      });
      const items = append(t.convId, t.turnId, [
        { kind: "usage", step: t.step, body: { usageId } },
        ...answer,
        ...calls,
      ]);
      const toolCalls = items.filter((i): i is ToolCallItem => i.kind === "tool_call");
      store.recordToolCalls(
        db,
        toolCalls.map((c) => ({
          id: c.body.callId,
          turnId: t.turnId,
          convId: t.convId,
          step: t.step,
          providerCallId: c.body.providerCallId,
          name: c.body.name,
          input: c.body.input,
        })),
      );
      return items;
    })();
    t.usage = addUsage(t.usage, end.usage);
    deps.log.log("request_end", {
      turn: t.turnId,
      step: t.step,
      state: "final",
      inputTokens:
        end.usage.uncachedInputTokens + end.usage.cacheReadTokens + end.usage.cacheWriteTokens,
      outputTokens: end.usage.outputTokens,
    });
    for (const item of written) t.frontend.emit({ type: "item", item });
    if (end.stop === "max_tokens" && got.text === "")
      t.frontend.emit({ type: "notice", code: "effort_truncated" });
    return written.filter((i): i is ToolCallItem => i.kind === "tool_call");
  }

  // --- Tool calls. Every call of a tool_use step ends with exactly one tool_result.

  async function runCalls(
    t: Turn,
    calls: readonly ToolCallItem[],
  ): Promise<NonNullable<Halt["end"]> | undefined> {
    let halted = false;
    let end: Halt["end"];
    for (const call of calls) {
      if (!halted && t.signal.aborted) {
        halted = true;
        end = { state: "aborted" };
      }
      if (halted) {
        finish(t, call, { status: "skipped", text: TEXT.skipped, truncated: false });
        continue;
      }
      const halt = await runCall(t, call);
      if (halt !== undefined) {
        halted = true;
        end = halt.end;
      }
    }
    return end;
  }

  function finish(
    t: Turn,
    call: ToolCallItem,
    outcome: ToolOutcome | { status: ToolCallEndState; text: string; truncated: boolean },
  ): void {
    const item = store.finishToolCall(
      db,
      { id: call.body.callId, turnId: t.turnId, convId: t.convId, step: call.step },
      {
        status: outcome.status,
        text: outcome.text,
        truncated: outcome.truncated,
        ...("exit" in outcome && outcome.exit !== undefined ? { exit: outcome.exit } : {}),
      },
      deps.now().getTime(),
    );
    deps.log.log("tool", { turn: t.turnId, state: outcome.status, step: call.step });
    if (item !== undefined) t.frontend.emit({ type: "item", item });
  }

  const ended = (t: Turn, call: ToolCallItem, status: ToolCallEndState, text: string) =>
    finish(t, call, { status, text, truncated: false });

  async function runCall(t: Turn, call: ToolCallItem): Promise<Halt | undefined> {
    const { name, input } = call.body;
    if (name === "skill_load" || name === "file_read") {
      const ctx = {
        paths: deps.paths,
        skills: t.skills,
        toolResultBytes: t.s.limits.tool_result_bytes,
      };
      finish(t, call, await runTool(name, input, ctx));
      return undefined;
    }
    if (name !== "tars") {
      ended(t, call, "failed", `沒有工具 ${name}`);
      return undefined;
    }
    const argv = isRecord(input) ? input.argv : undefined;
    const cctx = { paths: deps.paths, approveCommand: deps.approveCommand };
    const first = await classify(argv, cctx);
    if (first.kind === "refuse") {
      ended(t, call, "refused", `${REFUSAL_TEXT}\n原因：${first.reason}`);
      t.frontend.emit({ type: "notice", code: "blocked", data: { reason: first.reason } });
      return undefined;
    }
    if (first.kind === "approve") {
      const halt = await approve(t, call, first);
      if (halt !== undefined) return halt;
    }
    const budget = budgetHalt(t, call);
    if (budget !== undefined) return budget;
    // The script or the --out target may have changed while the owner was deciding.
    const again = await classify(argv, cctx);
    if (
      again.kind !== first.kind ||
      JSON.stringify(again.canonicalArgv) !== JSON.stringify(first.canonicalArgv)
    ) {
      ended(t, call, "refused", `${REFUSAL_TEXT}\n原因：${TEXT.changed}`);
      return undefined;
    }
    return execute(t, call, first);
  }

  /** Budget first: with the quota spent, the owner should not be asked to approve anything. */
  function budgetHalt(t: Turn, call: ToolCallItem): Halt | undefined {
    const other = otherSpend(t.s);
    const reason =
      other === undefined
        ? "budget_unreadable"
        : limitReached(db, {
            provider: t.s.model.provider,
            cfg: t.s.cfg,
            limits: t.s.limits,
            turnId: t.turnId,
            now: deps.now(),
            other,
          });
    if (reason === null) return undefined;
    ended(t, call, "refused", `${REASON_TEXT[reason]}，沒有執行`);
    return { end: { state: "failed", reason } };
  }

  async function approve(
    t: Turn,
    call: ToolCallItem,
    c: Extract<Classified, { kind: "approve" }>,
  ): Promise<Halt | undefined> {
    const budget = budgetHalt(t, call);
    if (budget !== undefined) return budget;
    const now = deps.now().getTime();
    const record = approvals.create(db, {
      toolCallId: call.body.callId,
      convId: t.convId,
      fields: c.fields,
      now,
      timeoutS: t.s.limits.approval_timeout_s,
    });
    deps.log.log("approval", { turn: t.turnId, state: "pending", script: c.fields.script });
    const wait = AbortSignal.any([
      t.signal,
      AbortSignal.timeout(Math.max(0, record.expiresAt - now)),
    ]);
    const answer = await t.frontend.askApproval(record, wait);
    // The approval and the tool call end in one transaction, and the call takes the state the
    // compare-and-set left the approval in: an answer given after expiry is an expiry.
    const state = db.transaction(() => {
      if (answer === "approved" || answer === "denied")
        approvals.decide(db, {
          id: record.id,
          decision: answer,
          hash: record.hash,
          via: "tty",
          now: deps.now().getTime(),
        });
      else if (t.signal.aborted) approvals.cancel(db, record.id);
      if (approvals.stateOf(db, record.id) === "pending") approvals.expire(db, record.id);
      const settled = approvals.stateOf(db, record.id);
      if (settled === "approved") store.setToolCallState(db, call.body.callId, "approved");
      else if (settled !== "pending") ended(t, call, settled, TEXT[settled]);
      return settled;
    })();
    deps.log.log("approval", { turn: t.turnId, state });
    if (state === "approved") return undefined;
    return state === "cancelled" ? { end: { state: "aborted" } } : {};
  }

  async function execute(
    t: Turn,
    call: ToolCallItem,
    c: Exclude<Classified, { kind: "refuse" }>,
  ): Promise<Halt | undefined> {
    const id = call.body.callId;
    store.setToolCallState(db, id, "running", { now: deps.now().getTime() });
    let result;
    try {
      result = await runSelf(c.canonicalArgv, c.timeoutMs, {
        selfCommand: deps.selfCommand,
        paths: deps.paths,
        env: deps.env,
        signal: t.signal,
        onSpawn: (pid, start) =>
          store.setToolCallState(db, id, "running", { childPid: pid, childStart: start }),
      });
    } catch (err) {
      ended(t, call, "failed", `無法啟動 tars：${errorText(err)}`);
      return undefined;
    }
    if (t.signal.aborted) {
      ended(t, call, "interrupted", TEXT.interrupted);
      return { end: { state: "aborted" } };
    }
    finish(t, call, toolText(result));
    return undefined;
  }

  function endTurn(t: Turn, state: EndState, reason?: FailReason, detail?: string): TurnOutcome {
    db.transaction(() => {
      store.endTurn(db, {
        id: t.turnId,
        convId: t.convId,
        state,
        reason,
        now: deps.now().getTime(),
      });
      if (state === "failed" && reason !== undefined)
        append(t.convId, t.turnId, [
          {
            kind: "error",
            step: t.step,
            body: {
              code: reason,
              message: REASON_TEXT[reason],
              ...(detail === undefined ? {} : { detail }),
            },
          },
        ]);
    })();
    endNotices(t);
    const costUsd = turnSpent(db, t.turnId);
    t.frontend.emit({
      type: "turn_end",
      state,
      reason,
      detail,
      costUsd,
      usage: t.usage,
      requests: store.turnRequests(db, t.turnId),
      effort: t.effort,
    });
    deps.log.log("turn_end", { turn: t.turnId, state, reason, costUsd });
    return { kind: "ended", convId: t.convId, turnId: t.turnId, state, reason };
  }

  function endNotices(t: Turn): void {
    const { s } = t;
    const conv = store.getConversation(db, t.convId);
    const window = effectiveWindow(s.model, s.limits);
    if (conv.lastTotalInputTokens >= window * s.limits.context_warn_ratio)
      t.frontend.emit({
        type: "notice",
        code: "context_warn",
        data: {
          percent: Math.round((conv.lastTotalInputTokens / window) * 100),
          autoCompact: s.limits.auto_compact ? "on" : "off",
        },
      });
    const other = otherSpend(s);
    if (other === undefined) return;
    const spentUsd = spent(db, s.model.provider, s.cfg, deps.now()) + other.period;
    if (spentUsd >= s.cfg.quota_usd * s.cfg.warn_ratio)
      t.frontend.emit({
        type: "notice",
        code: "budget_warn",
        data: { spentUsd, quotaUsd: s.cfg.quota_usd },
      });
  }

  // --- Compaction.

  async function compact(
    convId: string,
    opts: { trigger: "manual" | "auto"; focus?: string },
    frontend: Frontend,
    signal: AbortSignal,
  ): Promise<CompactOutcome> {
    const conv = store.getConversation(db, convId);
    const s = await prepareModel(deps, conv.provider, conv.model);
    if ("kind" in s) return { kind: "failed", reason: s.reason, message: s.message };
    return compactWith(s, conv, opts, frontend, signal);
  }

  const compactFailed = (reason: ReasonCode, detail?: string): CompactOutcome => ({
    kind: "failed",
    reason,
    message: REASON_TEXT[reason],
    ...(detail === undefined ? {} : { detail }),
  });

  async function compactWith(
    s: Setup,
    conv: store.Conversation,
    opts: { trigger: "manual" | "auto"; focus?: string },
    frontend: Frontend,
    signal: AbortSignal,
  ): Promise<CompactOutcome> {
    const items = store.readActiveItems(db, conv.id);
    const plan = planCompaction(items, s.limits);
    if (plan === null) return { kind: "skipped" };
    const maxOut = Math.min(s.limits.compact_max_output_tokens, s.model.maxOutput);
    const window = effectiveWindow(s.model, s.limits);
    const estimate = (prompt: string) =>
      estimateInput({
        fullBytes: utf8Bytes(SUMMARIZATION_SYSTEM) + utf8Bytes(prompt),
        newBytes: 0,
        lastTotal: 0,
      });
    // The same estimate the reservation below checks, with room left for the summary itself.
    const room = window * s.limits.context_stop_ratio - maxOut;
    const prompt = buildSummaryPrompt(
      plan.toSummarize,
      latestCompaction(items)?.body.summary,
      opts.focus,
      (p) => estimate(p) <= room,
    );
    if (prompt === undefined) return compactFailed("compact_too_large");
    const other = otherSpend(s);
    if (other === undefined) return compactFailed("budget_unreadable");
    const r = reserve({
      other,
      db,
      provider: s.cfg,
      limits: s.limits,
      model: s.model,
      conv: undefined,
      prefixKey: "",
      estInput: estimate(prompt),
      turnId: undefined,
      turnKind: "compaction",
      maxOutput: maxOut,
      now: deps.now(),
    });
    if (!r.ok) return compactFailed(r.reason);

    const turnId = store.newId();
    const usageId = db.transaction(() => {
      store.beginTurn(db, {
        id: turnId,
        convId: conv.id,
        kind: "compaction",
        effort: null,
        now: deps.now().getTime(),
      });
      return insertRequest(s, { turnId, convId: conv.id, step: 1, attempt: 1 }, r);
    })();
    deps.log.log("turn_start", { turn: turnId, conv: conv.id, turnKind: "compaction" });
    frontend.emit({ type: "notice", code: "compact_start" });
    const req: ModelRequest = {
      model: s.model.id,
      maxOutputTokens: r.maxTokens,
      system: [{ text: SUMMARIZATION_SYSTEM, cache: false }],
      tools: [],
      history: [{ seq: 1, turnId, step: 0, kind: "user", body: { text: prompt } }],
      cacheTtl: s.limits.cache_ttl,
      // The summary request is sent once; writing it to the cache would pay for nothing.
      cacheHistory: false,
      effort: "off",
      toolResultBytes: s.limits.tool_result_bytes,
      thinkingKey: "",
      capabilities: { thinkingTypes: s.model.thinkingTypes },
    };
    // The summary is not a reply to the owner, so its text is not shown.
    const got = await consume(db, s.adapter, req, usageId, signal, () => {});
    const close = (state: EndState, reason?: FailReason) => {
      store.endTurn(db, { id: turnId, convId: conv.id, state, reason, now: deps.now().getTime() });
      deps.log.log("turn_end", { turn: turnId, turnKind: "compaction", state, reason });
    };
    if (got.error !== undefined) {
      const reason = failureOf(got.error);
      db.transaction(() => {
        settleFailure(db, usageId, got);
        close(
          reason === "aborted" ? "aborted" : "failed",
          reason === "aborted" ? undefined : reason,
        );
      })();
      return reason === "aborted" ? { kind: "aborted" } : compactFailed(reason, got.error.detail);
    }
    const end = got.end as NonNullable<Consumed["end"]>;
    const final = (fn: () => void) =>
      db.transaction(() => {
        recordEnd(db, {
          usageId,
          usage: end.usage,
          ...(end.costUsd === undefined ? {} : { costUsd: end.costUsd }),
          turnKind: "compaction",
          prefixKey: "",
        });
        fn();
      })();
    const check = validateSummary(got.text, end.stop);
    if (!check.ok) {
      final(() => close("failed", check.reason));
      return compactFailed(check.reason);
    }
    const body = {
      firstKeptSeq: plan.firstKeptSeq,
      summary: check.summary,
      tokensBefore:
        conv.lastTotalInputTokens > 0
          ? conv.lastTotalInputTokens
          : estimateTokens(historyBytes(buildActiveHistory(items), s.limits)),
      replacedCount: plan.replacedCount,
      trigger: opts.trigger,
      usageId,
    };
    let seq = 0;
    final(() => {
      seq = store.finishCompaction(db, {
        convId: conv.id,
        turnId,
        body,
        now: deps.now().getTime(),
      });
    });
    deps.log.log("turn_end", { turn: turnId, turnKind: "compaction", state: "completed" });
    const item: CompactionItem = { seq, turnId, step: 1, kind: "compaction", body };
    frontend.emit({ type: "item", item });
    return { kind: "compacted", item, costUsd: turnSpent(db, turnId) };
  }

  return { runTurn, compact };
}

export type Engine = ReturnType<typeof createEngine>;
