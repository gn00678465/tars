import type { WireItem } from "@tars/protocol";
import { Fragment, type ReactNode, useState } from "react";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { ErrorCard } from "./ErrorCard.tsx";
import { NoticeCard } from "./Notices.tsx";
import { Markdown } from "./Markdown.tsx";
import { CompactEndCard } from "./CompactEndCard.tsx";
import { effortName } from "./RunSetup.tsx";
import { clock, shortId } from "./time.ts";
import { type FormHooks, UI_SHOW, UiForm } from "./UiForm.tsx";

const cut = (truncated: boolean) => (truncated ? "（已截斷）" : "");
const n = (v: number) => v.toLocaleString("en-US");

const ASSISTANT_STATE: Record<string, string> = {
  truncated: "（輸出被截斷）",
  aborted: "（已中止）",
  incomplete: "（不完整）",
};

/** A started turn's phase as the prototype's status line (D1); an older local end sends none. */
const PHASE: Record<string, string> = {
  thinking: "思考中…",
  replying: "回覆中",
  running_script: "執行腳本",
  waiting_approval: "等待核准",
};

/**
 * ui_spec 5.3: a tool step's results, as the prototype's tags, keyed by the local end's
 * ToolCallEndState. A refused one says why when the local end does (REFUSAL); an older local end
 * says only that it did not run.
 */
const RESULT: Record<string, [string, string]> = {
  done: ["ok", "完成"],
  failed: ["error", "失敗"],
  denied: ["error", "已拒絕"],
  expired: ["error", "已過期"],
  cancelled: ["", "已取消"],
  skipped: ["", "已略過"],
  refused: ["warn", "沒有執行"],
  interrupted: ["warn", "中斷（結果不明）"],
};

const REFUSAL: Record<string, string> = {
  not_offered: "這個入口不提供",
  changed: "腳本已變更，沒有執行",
  budget: "預算已到上限，沒有執行",
};

/** A tool's time as the prototype writes it: seconds, two decimals. */
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

const OUTPUT_LINES = 20;

type ToolCall = Extract<WireItem, { kind: "tool_call" }>;
type ToolResult = Extract<WireItem, { kind: "tool_result" }>;

function ToolStep({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [tone, plain] =
    result === undefined ? ["active", "執行中"] : (RESULT[result.status] ?? ["", result.status]);
  const label =
    result?.status === "refused" && result.refusal !== undefined
      ? (REFUSAL[result.refusal] ?? plain)
      : plain;
  // With its time in the summary, the exit code moves into the output (A2); an older local end
  // sends no time, and the code stays where it was.
  const timed = result?.durationMs !== undefined;
  const lines = result === undefined ? [] : result.text.split("\n");
  const shown = full ? lines : lines.slice(0, OUTPUT_LINES);
  return (
    <div className="tool-step">
      <button
        className="tool-step-summary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <div className="tool-step-left">
          <Icon name="terminal" />
          <span>{result?.status === "refused" ? "已擋下" : call.name}</span>
          <span className="tool-step-target">{call.input}</span>
        </div>
        <div className="tool-step-right">
          {result?.durationMs !== undefined ? (
            <span className="mono">{seconds(result.durationMs)}</span>
          ) : result?.exit === undefined ? null : (
            <span className="mono">結束碼 {result.exit}</span>
          )}
          <span className={`sg-tag ${tone}`}>{label}</span>
          <span className="tool-step-chevron">
            <Icon name="chevron" />
          </span>
        </div>
      </button>
      {open ? (
        <div className="tool-step-body">
          <div>
            <div className="tool-kv-label">指令參數{cut(call.truncated)}</div>
            <pre className="tool-code-box">{call.input}</pre>
          </div>
          {result === undefined ? null : (
            <div>
              <div className="tool-kv-label">
                執行輸出（純文字，共 {lines.length} 行）{cut(result.truncated)}
                {timed && result.exit !== undefined ? ` · 結束碼 ${result.exit}` : ""}
              </div>
              <pre className="tool-code-box">{shown.join("\n")}</pre>
              {lines.length > OUTPUT_LINES ? (
                <div className="btn-chip-row">
                  <button className="sg-btn sg-btn-sm" type="button" onClick={() => setFull(!full)}>
                    {full
                      ? `收合至前 ${OUTPUT_LINES} 行`
                      : `展開其餘 ${lines.length - OUTPUT_LINES} 行`}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What is drawn right after an item: the approval cards that belong to it. */
export type After = (seq: number) => ReactNode;

/** A conversation a new one continues: its title and its model's label, when it is listed. */
export type Origin = (conv: string) => { title: string; model: string } | undefined;

/** The forms in the thread: what the page can do with them, and those already sent. */
interface Forms {
  readonly hooks: FormHooks | undefined;
  readonly sent: ReadonlySet<string>;
}

function Rest({
  items,
  after,
  provider,
  origin,
  forms,
}: {
  items: readonly WireItem[];
  after: After;
  provider: string | undefined;
  origin: Origin | undefined;
  forms: Forms;
}) {
  const results = new Map(
    items.filter((i): i is ToolResult => i.kind === "tool_result").map((i) => [i.callId, i]),
  );
  return items.map((item) => (
    <Fragment key={item.seq}>
      <One
        item={item}
        result={item.kind === "tool_call" ? results.get(item.callId) : undefined}
        provider={provider}
        origin={origin}
        forms={forms}
      />
      {after(item.seq)}
    </Fragment>
  ));
}

function One({
  item,
  result,
  provider,
  origin,
  forms,
}: {
  item: WireItem;
  result: ToolResult | undefined;
  provider: string | undefined;
  origin: Origin | undefined;
  forms: Forms;
}) {
  switch (item.kind) {
    case "user":
    case "tool_result":
      return null;
    case "carried": {
      // As the prototype (9-01); one past the list's 500 is named by its id.
      const from = origin?.(item.from);
      return (
        <div key={item.seq} className="fork-banner">
          <span>
            接續自{from === undefined ? `對話 ${shortId(item.from)}` : `「${from.title}」`}
            （只帶入渲染後文字，不含工具執行紀錄）
          </span>
          {from === undefined ? null : <span className="sg-tag">原模型 {from.model}</span>}
        </div>
      );
    }
    case "assistant":
      return (
        <div key={item.seq} className="msg-assistant-text">
          <Markdown text={item.text} />
          {item.truncated || item.state in ASSISTANT_STATE ? (
            <p>{`${cut(item.truncated)}${ASSISTANT_STATE[item.state] ?? ""}`}</p>
          ) : null}
        </div>
      );
    case "tool_call": {
      const step = <ToolStep key={item.seq} call={item} result={result} />;
      // A form the local end refused to show stays a tool step (m4_design_a2ui.md 1.5).
      return item.name === UI_SHOW && (result === undefined || result.status === "done") ? (
        <UiForm
          key={item.seq}
          call={item}
          sent={forms.sent.has(item.callId)}
          hooks={forms.hooks}
          step={step}
        />
      ) : (
        step
      );
    }
    case "usage":
      return <UsageLine key={item.seq} item={item} />;
    case "error":
      return (
        <ErrorCard
          key={item.seq}
          code={item.code}
          provider={provider}
          {...(item.data === undefined ? {} : { data: item.data })}
        />
      );
    case "compaction":
      // One that says where its summary ends is drawn there, by Thread; an older local end's
      // where it came.
      return item.firstKeptSeq === undefined ? (
        <Compaction key={item.seq} item={item} merged={false} />
      ) : null;
  }
}

type CompactionItem = Extract<WireItem, { kind: "compaction" }>;

/** The summary's headings (src/features/agent/compaction.ts SUMMARY_HEADINGS) in Chinese. */
const HEADINGS: Record<string, string> = {
  Goal: "目標",
  "Constraints & Preferences": "限制與偏好",
  Progress: "進度",
  "Key Decisions": "關鍵決定",
  "Scripts, Outputs & Facts": "腳本、輸出與事實",
  "Next Steps": "下一步",
  "Critical Context": "關鍵背景",
};
const SUBHEADINGS: Record<string, string> = {
  Done: "已完成",
  "In Progress": "進行中",
  Blocked: "受阻",
};

/**
 * The summary as its sections, each heading in Chinese and its body as Markdown (only ever
 * text). A summary without the headings (cut short) is shown whole as it is.
 */
function Summary({ text }: { text: string }) {
  const parts = text.split(/^## +(.+?)\s*$/m);
  if (parts.length < 3) return <Markdown text={text} />;
  const sections: ReactNode[] = [];
  if (parts[0]?.trim() !== "") sections.push(<Markdown key="pre" text={parts[0] as string} />);
  for (let i = 1; i < parts.length; i += 2) {
    const head = parts[i] as string;
    // Progress's subsections as bold labels and its checkboxes as plain items, as the prototype;
    // the prompt's "(none)" in the page's words.
    const body = (parts[i + 1] ?? "")
      .replace(/^### +(.+?)\s*$/gm, (_, sub: string) => `**${SUBHEADINGS[sub] ?? sub}**`)
      .replace(/^(\s*[-*+]\s+)\[[ xX]\]\s+/gm, "$1")
      .replace(/^(\s*[-*+]\s+)\(none\)\s*$/gm, "$1（無）");
    sections.push(
      <Fragment key={i}>
        <h2>{HEADINGS[head] ?? head}</h2>
        <Markdown text={body} />
      </Fragment>,
    );
  }
  return sections;
}

const by = (c: CompactionItem) =>
  c.trigger === undefined ? "" : c.trigger === "auto" ? "自動" : "手動";

/**
 * A compaction as the prototype's divider (13-07 to 13-11). The latest opens to its summary; an
 * earlier one was taken into the latest's summary and says so.
 */
function Compaction({ item, merged }: { item: CompactionItem; merged: boolean }) {
  const [open, setOpen] = useState(false);
  const when = item.at === undefined ? "" : `${clock(item.at)} `;
  if (merged)
    return (
      <div className="compaction-divider">
        <div className="compaction-trigger">
          <span className="compaction-trigger-left">
            <Icon name="layers" />
            <span>
              {when}
              {by(item)}壓縮{item.count === undefined ? "" : `（早期 ${n(item.count)} 則）`}
            </span>
          </span>
          <span className="sg-tag">已併入後面的摘要</span>
        </div>
      </div>
    );
  const figures =
    item.count !== undefined && item.beforeTokens !== undefined && item.keptTokens !== undefined
      ? `已壓縮早期 ${n(item.count)} 則訊息（原 ${n(item.beforeTokens)} tokens · 保留近期 ${n(item.keptTokens)} tokens）`
      : "這之前的內容已壓縮成摘要";
  const tag = `${when}${by(item)}`.trim();
  return (
    <div className="compaction-divider">
      <button
        className="compaction-trigger"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="compaction-trigger-left">
          <Icon name="layers" />
          <span>{figures}</span>
          {tag === "" ? null : <span className="sg-tag">{tag}</span>}
        </span>
        <span className="sg-tag">{open ? "收合摘要" : "展開摘要"}</span>
      </button>
      {open ? (
        <div className="compaction-body">
          <div className="compaction-meta">
            {item.costUsd === undefined
              ? ""
              : `本次摘要花費 ${item.costUsd.toFixed(3)} USD（估）· `}
            {item.count === undefined
              ? "原始紀錄仍完整保存於本機資料庫。"
              : `原始 ${n(item.count)} 則紀錄仍完整保存於本機資料庫。`}
          </div>
          <Summary text={item.text} />
          {item.truncated ? <p>{cut(true)}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The prototype's usage line (A1). inputTokens counts cache reads too: they are taken out of
 * 輸入 and said apart, so the two add up to what was sent. Cache writes stay in 輸入. Fields an
 * older local end does not send are left out, never shown as 0.
 */
function UsageLine({ item }: { item: Extract<WireItem, { kind: "usage" }> }) {
  const read = item.cacheReadTokens;
  return (
    <div className="msg-usage-line mono">
      <span>輸入 {n(item.inputTokens - (read ?? 0))}</span>
      {read === undefined ? null : <span>快取讀 {n(read)}</span>}
      <span>
        輸出 {n(item.outputTokens)}
        {item.thinkingTokens === undefined ? "" : `（含思考 ${n(item.thinkingTokens)}）`}
      </span>
      {item.effort === undefined ? null : <span>推理：{effortName(item.effort)}</span>}
      <span>
        {/* Only a cost the provider reported is exact; table and estimate are tars's own. */}
        {item.costUsd.toFixed(3)} USD{item.costSource === "provider" ? "" : " 估"}
      </span>
    </div>
  );
}

/**
 * Under the thread: a running turn's status line, gone once the turn ends (D1). A turn that did
 * not start, or ended without the error item the local end writes for a failure, gets the card
 * here; one with its item has the card in the thread already.
 */
function TurnEnd({
  turn,
  items,
  provider,
  compacting,
}: {
  turn: State["turn"];
  items: readonly WireItem[];
  provider: string | undefined;
  compacting: boolean;
}) {
  if (compacting)
    return (
      <div className="turn-status" role="status">
        <span className="status-glyph" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>壓縮中…</span>
      </div>
    );
  if (turn === undefined) return null;
  if (turn.state === "started")
    return (
      <div className="turn-status" role="status">
        {turn.phase === "thinking" ? (
          <span className="tars-sprite wheel" aria-hidden="true" />
        ) : (
          <span className="status-glyph" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}
        <span>{(turn.phase === undefined ? undefined : PHASE[turn.phase]) ?? "回覆中…"}</span>
      </div>
    );
  const failed = turn.state === "failed" || turn.state === "interrupted";
  if (turn.state !== "rejected" && !failed) return null;
  if (failed && items.some((i) => i.kind === "error" && i.turn === turn.turn)) return null;
  const code =
    turn.reason ??
    (turn.state === "interrupted" ? "interrupted" : turn.state === "failed" ? "turn_failed" : "");
  return (
    <ErrorCard
      code={code}
      provider={provider}
      {...(turn.data === undefined ? {} : { data: turn.data })}
    />
  );
}

/**
 * Where the compactions are drawn: before the group the latest one's first kept item is in, so
 * what it summarized is above it (all.length: after every group). Earlier ones were taken into
 * its summary and are drawn with it, as the prototype (13-09). The groups above are what the
 * model no longer sees, drawn faded (13-10).
 */
function placed(all: ReturnType<typeof groups>, items: readonly WireItem[]) {
  const compactions = items.filter(
    (i): i is CompactionItem => i.kind === "compaction" && i.firstKeptSeq !== undefined,
  );
  const latest = compactions.at(-1);
  if (latest === undefined) return { compactions, latest, faded: 0 };
  const last = (g: (typeof all)[number]) =>
    Math.max(
      g.user?.seq ?? -Infinity,
      ...g.rest.filter((i) => i.kind !== "compaction").map((i) => i.seq),
    );
  const found = all.findIndex((g) => last(g) >= (latest.firstKeptSeq as number));
  return { compactions, latest, faded: found === -1 ? all.length : found };
}

/** Each message the owner sent starts a group; what the turn wrote follows it. */
function groups(items: readonly WireItem[]) {
  const out: { user?: Extract<WireItem, { kind: "user" }>; rest: WireItem[] }[] = [];
  for (const item of items) {
    if (item.kind === "user") out.push({ user: item, rest: [] });
    else if (out.length === 0) out.push({ rest: [item] });
    else out[out.length - 1]?.rest.push(item);
  }
  return out;
}

export function Thread(props: {
  state: State;
  onOlder: () => void;
  after: After;
  /**
   * The new conversation's model label; "" when the local end lists none; absent from a local
   * end older than models.list.
   */
  model?: string;
  /** No conversation was opened or started yet: the page says it is connected. */
  welcome?: boolean;
  /** Opens the effort control; absent when the page offers none. */
  onEffort?: () => void;
  origin?: Origin;
  /** What a form in the thread can do; absent where forms cannot be sent. */
  forms?: FormHooks;
}) {
  const { items, running, turn, more, notices, conv } = props.state;
  if (conv === undefined && items.length === 0)
    return (
      <div className="empty-state">
        <span className="tars-sprite idle" aria-hidden="true" />
        {props.welcome === true ? (
          <>
            <h2>已連線至本機 TARS</h2>
            <p>
              可進行日常對話，或透過白名單查詢與執行已入庫的安全腳本。輸入 / 可查看指令與可用
              skills。
            </p>
          </>
        ) : (
          <>
            <h2>新對話</h2>
            <p>
              {props.model === ""
                ? "還沒有可用的模型。請先在本機終端更新模型清單。"
                : `${props.model === undefined ? "模型用本機端設定的預設。" : `目前用 ${props.model}。要換模型或推理強度，在輸入框右下角選。`}送出第一則訊息後，模型就綁在這個對話上。`}
            </p>
          </>
        )}
      </div>
    );
  const all = groups(items);
  // A message a form sent names it: that form is drawn as sent, after a reload too.
  const forms: Forms = {
    hooks: props.forms,
    sent: new Set(
      items.flatMap((i) => (i.kind === "user" && i.uiCall !== undefined ? [i.uiCall] : [])),
    ),
  };
  const { compactions, latest, faded } = placed(all, items);
  const dividers = compactions.map((c) => (
    <Compaction key={c.seq} item={c} merged={c !== latest} />
  ));
  const here = props.state.convs.find((c) => c.id === conv);
  const provider = here?.provider;
  return (
    <>
      {more ? (
        <div className="btn-chip-row">
          <button className="sg-btn sg-btn-sm" type="button" onClick={props.onOlder}>
            載入更早的訊息
          </button>
        </div>
      ) : null}
      {all.map((g, i) => (
        <Fragment key={g.user?.seq ?? `g${i}`}>
          {i === 0 && faded > 0 ? (
            <div className="compacted-notice-line">模型已看不到以下的原文，只看得到摘要</div>
          ) : null}
          {latest !== undefined && i === faded ? dividers : null}
          <div className={i < faded ? "msg-group compacted-old" : "msg-group"}>
            {g.user === undefined ? null : (
              <div className="msg-user">
                {g.user.text}
                {cut(g.user.truncated)}
              </div>
            )}
            <div className="msg-assistant">
              {g.user === undefined ? null : props.after(g.user.seq)}
              <Rest
                items={g.rest}
                after={props.after}
                provider={provider}
                origin={props.origin}
                forms={forms}
              />
              {i === all.length - 1 && running !== undefined ? (
                <div className="msg-assistant-text streaming">
                  <Markdown text={running.text} />
                </div>
              ) : null}
            </div>
          </div>
        </Fragment>
      ))}
      {latest !== undefined && faded === all.length ? dividers : null}
      {all.length === 0 && running !== undefined ? (
        <div className="msg-assistant-text streaming">
          <Markdown text={running.text} />
        </div>
      ) : null}
      <TurnEnd
        turn={turn}
        items={items}
        provider={provider}
        compacting={props.state.compacting === true}
      />
      {props.state.compactEnd === undefined ? null : (
        <CompactEndCard end={props.state.compactEnd} provider={provider} />
      )}
      {notices.map((n, i) => (
        <NoticeCard
          key={i}
          notice={n}
          context={{ provider, effort: here?.effort }}
          {...(props.onEffort === undefined ? {} : { onEffort: props.onEffort })}
        />
      ))}
    </>
  );
}
