import type { WireModel } from "@tars/protocol";
import { useRef } from "react";
import { Icon } from "./Icon.tsx";
import { type ModelRef, type Spend, SpendText, windowText } from "./ModelSheet.tsx";
import { reasonText } from "../reasons.ts";
import { providerName } from "./StatusBar.tsx";
import { useModal } from "./modal.ts";
import { usePopover } from "./popover.ts";

/** The local end's levels, lowest first: how a level the model lacks is moved, as it moves it. */
const ORDER = ["low", "medium", "high", "xhigh", "max"];

const NAMES: Readonly<Record<string, string>> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "極高",
  max: "最高",
};

const NOTES: Readonly<Record<string, string>> = {
  low: "回應最快，思考最少",
  medium: "預設平衡（建議）",
  high: "較仔細，花費較高",
  xhigh: "深度推理，等待較久",
  max: "最高推理上限",
};

/** A level the page does not know is shown by its name. */
export const effortName = (level: string) => NAMES[level] ?? level;

/**
 * The level a turn on a model with `levels` goes with, as the local end's effectiveEffort picks
 * it: the one wanted, else the nearest below, else the lowest. None when the model takes none.
 */
export function clampEffort(
  levels: readonly string[],
  wanted: string | undefined,
): string | undefined {
  if (levels.length === 0) return undefined;
  if (wanted === undefined) return levels.includes("medium") ? "medium" : levels[0];
  if (levels.includes(wanted)) return wanted;
  const below = levels.filter((l) => ORDER.indexOf(l) < ORDER.indexOf(wanted));
  return below.at(-1) ?? levels[0];
}

/** A model's levels as the prototype's menu says them: the lowest to the highest. */
export function effortRange(levels: readonly string[] | undefined): string | undefined {
  if (levels === undefined) return undefined;
  const [low, high] = [levels[0], levels.at(-1)];
  if (low === undefined || high === undefined) return "不支援推理強度";
  return low === high ? `推理 ${effortName(low)}` : `推理 ${effortName(low)}–${effortName(high)}`;
}

export interface ModelControl {
  readonly label: string;
  readonly models: readonly WireModel[];
  /** The model the next message goes to. */
  readonly current: ModelRef | undefined;
  readonly spend: (provider: string) => Spend | undefined;
  /** Under the list: what picking does here (switch, or continue in a new conversation). */
  readonly note: string;
  readonly open: boolean;
  /** On a phone this opens the model sheet instead. */
  readonly onOpen: (open: boolean) => void;
  readonly onChoose: (model: ModelRef) => void;
}

const isModel = (m: WireModel, r: ModelRef | undefined) =>
  r !== undefined && m.provider === r.provider && m.id === r.id;

export interface EffortControl {
  /** What the model takes, lowest first; empty when none. */
  readonly levels: readonly string[];
  /** The level the next message goes with. */
  readonly current: string | undefined;
  /** The level wanted, when the model does not take it and `current` is the nearest. */
  readonly movedFrom?: string;
  /** Why it cannot be changed now. */
  readonly disabled?: string;
  readonly open: boolean;
  readonly onOpen: (open: boolean) => void;
  readonly onPick: (level: string) => void;
}

const optionsOf = (e: EffortControl) =>
  e.levels.map((level) => ({ level, on: level === e.current }));

/**
 * The prototype's joined control beside the send button: the model, then the effort level. On a
 * desktop the level drops a menu from its button; a phone gets the sheet (EffortSheet) instead.
 */
export function RunSetup(props: {
  compact: boolean;
  model: ModelControl;
  effort: EffortControl | undefined;
  /** Just picked: says when it applies. */
  toast: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const modelAnchor = useRef<HTMLDivElement>(null);
  const modelMenu = useRef<HTMLDivElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const m = props.model;
  const e = props.effort;
  const none = e !== undefined && e.levels.length === 0;
  const dropped = e !== undefined && e.open && !props.compact && !none;
  const modelDropped = m.open && !props.compact;
  usePopover(anchor, menu, dropped, () => e?.onOpen(false));
  usePopover(modelAnchor, modelMenu, modelDropped, () => m.onOpen(false));
  const providers = [...new Set(m.models.map((x) => x.provider))];
  return (
    <>
      <span className="effort-toast" role="status" hidden={!props.toast}>
        下一則訊息起生效
      </span>
      <div
        className="run-setup"
        role="group"
        aria-label={e === undefined ? "模型" : "模型與推理強度"}
      >
        <div className="model-anchor" ref={modelAnchor}>
          <button
            ref={modelTrigger}
            className="run-seg"
            type="button"
            aria-haspopup={props.compact ? "dialog" : "menu"}
            aria-expanded={modelDropped}
            title="選擇模型"
            onClick={() => m.onOpen(!m.open)}
          >
            <span className="run-seg-label">模型</span>
            <span>{m.label}</span>
            <Icon name="chevron" />
          </button>
          {modelDropped ? (
            <div
              ref={modelMenu}
              className="model-popover sg-popover"
              role="menu"
              aria-label="選擇模型"
            >
              {m.models.length === 0 ? (
                <div className="task-notice warn">
                  <div className="task-notice-body">
                    <div className="task-notice-title">還沒有可用的模型</div>
                    <div className="task-notice-desc">
                      請在本機終端更新模型清單：tars models refresh
                    </div>
                  </div>
                </div>
              ) : null}
              {providers.map((p) => {
                const spend = m.spend(p);
                return (
                  <div
                    className="model-menu-group"
                    role="group"
                    aria-label={providerName(p)}
                    key={p}
                  >
                    <div className="model-menu-head">
                      <span>{providerName(p)}</span>
                      <SpendText spend={spend} className="mono" />
                    </div>
                    {m.models
                      .filter((x) => x.provider === p)
                      .map((x) => {
                        const on = isModel(x, m.current);
                        const sub = [
                          x.window === undefined ? undefined : `context ${windowText(x.window)}`,
                          x.unusable === undefined
                            ? effortRange(x.effortLevels)
                            : reasonText(x.unusable),
                        ].filter((t) => t !== undefined);
                        return (
                          <button
                            key={x.id}
                            className={on ? "model-menu-option active" : "model-menu-option"}
                            type="button"
                            role="menuitemradio"
                            aria-checked={on}
                            disabled={!on && (x.unusable !== undefined || spend?.stopped === true)}
                            onClick={() => {
                              m.onChoose({ provider: x.provider, id: x.id });
                              modelTrigger.current?.focus();
                            }}
                          >
                            <span className="model-menu-main">
                              <span className="model-menu-name">{x.label}</span>
                              <span className="model-menu-sub">{sub.join(" · ")}</span>
                            </span>
                            {on ? <Icon name="check" /> : null}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
              <p className="model-menu-note">{m.note}</p>
            </div>
          ) : null}
        </div>
        {e === undefined ? null : (
          <div className="effort-anchor" ref={anchor}>
            <button
              ref={trigger}
              className="run-seg"
              type="button"
              aria-haspopup={props.compact ? "dialog" : "menu"}
              aria-expanded={dropped}
              disabled={none || e.disabled !== undefined}
              title={none ? "這個模型不支援推理強度" : (e.disabled ?? "調整推理強度")}
              onClick={() => e.onOpen(!e.open)}
            >
              {e.movedFrom === undefined || e.current === undefined ? null : (
                <>
                  <span className="status-dot warn" aria-hidden="true" />
                  <span className="sr-only">
                    這個模型不支援推理 {effortName(e.movedFrom)}，改用 {effortName(e.current)}：
                  </span>
                </>
              )}
              <span className="run-seg-label">推理</span>
              <span>{none || e.current === undefined ? "不適用" : effortName(e.current)}</span>
              {none ? null : <Icon name="chevron" />}
            </button>
            {dropped ? (
              <div
                ref={menu}
                className="effort-popover sg-popover"
                role="menu"
                aria-label="選擇推理強度"
              >
                {optionsOf(e).map(({ level, on }) => (
                  <button
                    key={level}
                    className={on ? "effort-option active" : "effort-option"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => {
                      e.onPick(level);
                      // The menu goes with the pick; the focus would fall to the page.
                      trigger.current?.focus();
                    }}
                  >
                    <div>
                      <div className="effort-option-title">
                        {effortName(level)}（{level}）
                      </div>
                      {NOTES[level] === undefined ? null : (
                        <div className="effort-option-note">{NOTES[level]}</div>
                      )}
                    </div>
                    {on ? <Icon name="check" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

/** The phone's effort sheet (the prototype's overlay "effort"). */
export function EffortSheet(props: { effort: EffortControl; modelLabel: string }) {
  const panel = useRef<HTMLElement>(null);
  const close = () => props.effort.onOpen(false);
  useModal(panel, true, close);
  return (
    <div
      className="overlay-backdrop"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <section
        ref={panel}
        className="sheet-panel sg-popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="effort-sheet-title"
      >
        <div className="sheet-head">
          <h2 id="effort-sheet-title">選擇推理強度（{props.modelLabel}）</h2>
          <button className="sg-icon-btn" type="button" aria-label="關閉" onClick={close}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="sheet-body">
          {optionsOf(props.effort).map(({ level, on }) => (
            <button
              key={level}
              className={on ? "model-option selected" : "model-option"}
              type="button"
              aria-pressed={on}
              onClick={() => props.effort.onPick(level)}
            >
              <div>
                <div className="model-option-name">
                  {effortName(level)}（{level}）
                </div>
                {NOTES[level] === undefined ? null : (
                  <div className="model-option-id">{NOTES[level]}</div>
                )}
              </div>
              {on ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
        <div className="sheet-foot">
          <span>選取後自下一則訊息生效</span>
          <button className="sg-btn" type="button" onClick={close}>
            關閉
          </button>
        </div>
      </section>
    </div>
  );
}
