import type { WireModel } from "@tars/protocol";
import { type RefObject, useState } from "react";
import { reasonText } from "../reasons.ts";
import { Panel } from "./Panel.tsx";
import { providerName } from "./StatusBar.tsx";

export interface Spend {
  readonly text: string;
  readonly stopped: boolean;
}

/** Beside a provider's name in either model menu: its spending, or a red tag once stopped. */
export function SpendText(props: { spend: Spend | undefined; className?: string }) {
  if (props.spend === undefined) return null;
  return props.spend.stopped ? (
    <span className="sg-tag error">{props.spend.text}</span>
  ) : (
    <span className={props.className ?? "mono provider-group-sub"}>{props.spend.text}</span>
  );
}

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

const same = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  a !== undefined && b !== undefined && a.provider === b.provider && a.id === b.id;

/** The local end's carryoverMaxBytes: 40% of the new model's effective window. */
const CARRY_SHARE = 0.4;

/**
 * What continuing costs, said before it is chosen. The page cannot measure this conversation's
 * text, so the figure is the upper bound the window allows.
 */
export const carryNote = (window: number) =>
  `會帶入這個對話的文字，最多約為新模型視窗的 40%（約 ${Math.round(window * CARRY_SHARE).toLocaleString("en-US")} tokens，上限估計）。新對話第一則請求以全價計費，之後才吃得到快取；工具輸出不會帶入。`;

export const windowText = (w: number) =>
  w >= 1_000_000 ? `${(w / 1_000_000).toLocaleString("en-US")}M` : `${Math.round(w / 1000)}K`;

/**
 * The prototype's model sheet (ui_spec 5.x): a new conversation's model, or another model to
 * continue this conversation in (`from`). A model the local end cannot use is shown, not
 * choosable, with the reason.
 */
export function ModelSheet(props: {
  models: readonly WireModel[];
  picked: ModelRef | undefined;
  from?: { readonly title: string; readonly model: ModelRef };
  onConfirm: (model: ModelRef) => void;
  onClose: () => void;
  phone: boolean;
  /** The composer's model button: on a wider screen the sheet rises from it. */
  at?: RefObject<HTMLButtonElement | null>;
  /** A provider's spending, from status; past its stop threshold its models cannot be chosen. */
  spend?: (provider: string) => Spend | undefined;
}) {
  const usable = (m: WireModel) =>
    m.unusable === undefined &&
    !same(m, props.from?.model) &&
    props.spend?.(m.provider)?.stopped !== true;
  const [choice, setChoice] = useState<ModelRef | undefined>(() => {
    const start =
      props.models.find((m) => same(m, props.picked)) ?? props.models.find((m) => m.isDefault);
    return start !== undefined && usable(start) ? start : props.models.find(usable);
  });
  const chosen = props.models.find((m) => same(m, choice));
  const providers = [...new Set(props.models.map((m) => m.provider))];
  const fork = props.from !== undefined;
  return (
    <Panel
      phone={props.phone}
      {...(props.at === undefined ? {} : { at: { ref: props.at, side: "top" as const } })}
      title={fork ? "以另一個模型接續對話" : "選擇模型"}
      titleId="model-sheet-title"
      wide
      onClose={props.onClose}
      foot={
        <>
          <span>模型綁在對話上；換模型會開新對話接續</span>
          <button
            className="sg-btn sg-btn-primary"
            type="button"
            disabled={choice === undefined}
            onClick={() => {
              if (choice !== undefined) props.onConfirm(choice);
            }}
          >
            {fork ? "建立接續對話" : "使用這個模型"}
          </button>
        </>
      }
    >
      {props.from === undefined ? null : (
        <div className="fork-banner">
          <span>
            來源對話：{props.from.title}（原模型{" "}
            {props.models.find(
              (m) => m.provider === props.from?.model.provider && m.id === props.from.model.id,
            )?.label ?? props.from.model.id}
            ）
          </span>
        </div>
      )}
      {props.models.length === 0 ? (
        <div className="task-notice warn">
          <div className="task-notice-body">
            <div className="task-notice-title">還沒有可用的模型</div>
            <div className="task-notice-desc">請在本機終端更新模型清單：tars models refresh</div>
          </div>
        </div>
      ) : (
        providers.map((p) => (
          <div className="provider-group" key={p} role="group" aria-label={providerName(p)}>
            <div className="provider-group-head">
              <span>{providerName(p)}</span>
              <SpendText spend={props.spend?.(p)} />
            </div>
            {props.models
              .filter((m) => m.provider === p)
              .map((m) => (
                <button
                  key={m.id}
                  className={same(m, choice) ? "model-option selected" : "model-option"}
                  type="button"
                  aria-pressed={same(m, choice)}
                  disabled={!usable(m)}
                  onClick={() => setChoice({ provider: m.provider, id: m.id })}
                >
                  <div>
                    <div className="model-option-name">
                      {m.label}
                      {m.isDefault ? <span className="sg-tag">預設</span> : null}
                      {same(m, props.from?.model) ? <span className="sg-tag">目前</span> : null}
                    </div>
                    <div className="mono model-option-id">
                      {m.unusable === undefined ? m.id : `${m.id}：${reasonText(m.unusable)}`}
                    </div>
                  </div>
                  {m.window === undefined ? null : (
                    <span className="mono model-option-ctx">{windowText(m.window)}</span>
                  )}
                </button>
              ))}
          </div>
        ))
      )}
      {fork && chosen?.window !== undefined ? (
        <div className="task-notice warn">
          <div className="task-notice-body">
            <div className="task-notice-title">接續的成本</div>
            <div className="task-notice-desc">{carryNote(chosen.window)}</div>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

const SCOPES = [undefined, 10, 3, 1] as const;

/**
 * Above the composer while the next message will continue a conversation in another model: what
 * it costs, how much it carries (keepLast; the summary only with all of it), and a way back.
 */
export function ContinueBanner(props: {
  title: string;
  label: string;
  window: number | undefined;
  keepLast: number | undefined;
  onKeepLast: (n: number | undefined) => void;
  onCancel: () => void;
}) {
  return (
    <div className="task-notice active" role="status">
      <div className="task-notice-body">
        <div className="task-notice-title">
          下一則訊息會用 {props.label} 開新對話，接續「{props.title}」
        </div>
        {props.window === undefined ? null : (
          <div className="task-notice-desc">{carryNote(props.window)}</div>
        )}
        <div className="btn-chip-row" role="group" aria-label="帶入範圍">
          {SCOPES.map((n) => (
            <button
              key={n ?? "all"}
              className={
                n === props.keepLast ? "sg-btn sg-btn-sm sg-btn-primary" : "sg-btn sg-btn-sm"
              }
              type="button"
              aria-pressed={n === props.keepLast}
              onClick={() => props.onKeepLast(n)}
            >
              {n === undefined ? "全部（含摘要）" : `最後 ${n} 回合`}
            </button>
          ))}
        </div>
      </div>
      <button className="sg-btn sg-btn-sm" type="button" onClick={props.onCancel}>
        取消
      </button>
    </div>
  );
}
