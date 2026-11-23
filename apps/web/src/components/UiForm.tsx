import { uiContext, type UiContext, type WireItem } from "@tars/protocol";
import { Component, lazy, type ReactNode, Suspense, useState } from "react";

/** The A2UI half, in its own chunk: fetched the first time a form is drawn (m4_design_a2ui.md 1.5). */
const A2uiCard = lazy(() => import("./A2uiCard.tsx"));

type ToolCall = Extract<WireItem, { kind: "tool_call" }>;

/** The tool whose call is drawn as a form. */
export const UI_SHOW = "ui_show";

/** What a form can do here, from the page: App's, passed down the thread. */
export interface FormHooks {
  /** Sends the form's values. */
  readonly submit: (callId: string, context: UiContext) => void;
  /** Why nothing can be sent now (offline, a turn running), or undefined when it can. */
  readonly blocked: string | undefined;
  /** The call whose form is on its way. */
  readonly sending: string | undefined;
  /** The last form refused and why. */
  readonly error: { readonly callId: string; readonly text: string } | undefined;
}

/**
 * ui_show's input as the page reads it, or undefined when it cannot be drawn: cut short by the
 * protocol's limit, not JSON, or not components and data. A2UI validates the rest.
 */
export function formSpec(call: ToolCall) {
  if (call.truncated) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(call.input);
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null) return undefined;
  const { components, dataModel } = input as Record<string, unknown>;
  if (!Array.isArray(components)) return undefined;
  if (dataModel !== undefined && (typeof dataModel !== "object" || dataModel === null))
    return undefined;
  return {
    components: components as unknown[],
    ...(dataModel === undefined ? {} : { dataModel: dataModel as Record<string, unknown> }),
  };
}

/**
 * The button's context as ui.submit carries it, or undefined when it does not fit. A2UI gives
 * what the fields are bound to: strings and lists of them from the basic catalog's inputs; a
 * number is sent as its text, a field never bound is left out.
 */
export function toContext(context: Readonly<Record<string, unknown>>): UiContext | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "number" || typeof v === "boolean" ? String(v) : v;
  }
  const parsed = uiContext.safeParse(out);
  return parsed.success ? parsed.data : undefined;
}

/** A chunk that would not load: a deploy replaced it while this tab was open. */
class Loaded extends Component<{ children: ReactNode; failed: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.failed : this.props.children;
  }
}

/**
 * A ui_show call as a form, in a frame the model cannot draw: its header says TARS made it and
 * the footer that writing still asks for approval (m4_design_a2ui.md 5.2). Once a message from
 * it is in the thread (sent) it is locked, as it is while on its way; a refusal is said under
 * it. What cannot be drawn falls back to a line and the plain tool step (step).
 */
export function UiForm({
  call,
  sent,
  hooks,
  step,
}: {
  call: ToolCall;
  sent: boolean;
  hooks: FormHooks | undefined;
  step: ReactNode;
}) {
  const spec = formSpec(call);
  const fallback = (line: string) => (
    <>
      <p className="ui-form-fallback">{line}</p>
      {step}
    </>
  );
  if (spec === undefined) return fallback("表單內容不完整，無法顯示。");
  return <Drawn call={call} spec={spec} sent={sent} hooks={hooks} fallback={fallback} />;
}

function Drawn({
  call,
  spec,
  sent,
  hooks,
  fallback,
}: {
  call: ToolCall;
  spec: NonNullable<ReturnType<typeof formSpec>>;
  sent: boolean;
  hooks: FormHooks | undefined;
  fallback: (line: string) => ReactNode;
}) {
  /** Values that do not fit ui.submit: said here, nothing is sent. */
  const [unfit, setUnfit] = useState(false);
  const sending = hooks?.sending === call.callId;
  const locked = sent || sending || hooks === undefined;
  const error = hooks?.error?.callId === call.callId ? hooks.error.text : undefined;
  const problem = unfit ? "有欄位的值太長或格式不對，沒有送出" : error;
  const note = sent
    ? "已送出"
    : sending
      ? "送出中…"
      : (problem ?? (hooks === undefined ? "這裡不能送出表單" : hooks.blocked));
  const onAction = (action: { context: Readonly<Record<string, unknown>> }) => {
    if (locked || hooks.blocked !== undefined) return;
    const context = toContext(action.context);
    setUnfit(context === undefined);
    if (context !== undefined) hooks.submit(call.callId, context);
  };
  const frame = (body: ReactNode) => (
    <section className={sent ? "ui-form state-sent" : "ui-form"} aria-label="表單（由 TARS 產生）">
      <header className="ui-form-head">表單（由 TARS 產生）</header>
      <div className="ui-form-body a2ui-dark" inert={locked}>
        {body}
      </div>
      <footer className="ui-form-foot">送出後 TARS 會先預覽，寫入前會再出核准卡。</footer>
      {note === undefined ? null : (
        <p
          className={
            problem !== undefined && !sent && !sending ? "ui-form-note error" : "ui-form-note"
          }
          role="status"
        >
          {note}
        </p>
      )}
    </section>
  );
  return (
    <Loaded failed={fallback("表單載不到，請重新整理頁面。")}>
      <Suspense fallback={frame(<p className="ui-form-loading">表單載入中…</p>)}>
        <A2uiCard
          callId={call.callId}
          spec={spec}
          onAction={onAction}
          frame={frame}
          invalid={fallback("表單的格式不對，無法顯示。")}
        />
      </Suspense>
    </Loaded>
  );
}
