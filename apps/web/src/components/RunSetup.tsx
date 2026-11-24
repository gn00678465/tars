import type { WireModel } from "@tars/protocol";
import type { FocusEvent, Ref } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "./Icon.tsx";
import { type ModelRef, type Spend, SpendText, windowText } from "./ModelSheet.tsx";
import { reasonText } from "../reasons.ts";
import { providerName } from "./StatusBar.tsx";
import { Panel } from "./Panel.tsx";

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

/** What a level is for, as the prototype says it; none for a level the page does not know. */
export const effortNote = (level: string): string | undefined => NOTES[level];

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
  /** Why the model cannot be changed now (offline, a turn running); undefined when it can. */
  readonly disabled?: string;
  /** The model button, which the desktop's model sheet rises from. */
  readonly trigger?: Ref<HTMLButtonElement>;
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
 * desktop each drops a menu (shadcn's dropdown-menu, one choice) from its button; a phone gets a
 * sheet instead (ModelSheet, EffortSheet), so the buttons there are plain.
 */
export function RunSetup(props: {
  compact: boolean;
  model: ModelControl;
  effort: EffortControl | undefined;
  /** Just picked: says when it applies. */
  toast: boolean;
}) {
  const m = props.model;
  const e = props.effort;
  const none = e !== undefined && e.levels.length === 0;
  const dropped = e !== undefined && e.open && !props.compact && !none && e.disabled === undefined;
  const modelDropped = m.open && !props.compact && m.disabled === undefined;
  const providers = [...new Set(m.models.map((x) => x.provider))];
  const modelSeg = {
    className: "run-seg",
    disabled: m.disabled !== undefined,
    title: m.disabled ?? "選擇模型",
    children: (
      <>
        <span className="run-seg-label">模型</span>
        <span>{m.label}</span>
        <Icon name="chevron" />
      </>
    ),
  };
  const effortSeg =
    e === undefined
      ? undefined
      : {
          className: "run-seg",
          disabled: none || e.disabled !== undefined,
          title: none ? "這個模型不支援推理強度" : (e.disabled ?? "調整推理強度"),
          children: (
            <>
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
            </>
          ),
        };
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
        <div className="model-anchor">
          {props.compact ? (
            <button
              ref={m.trigger}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={false}
              onClick={() => m.onOpen(true)}
              {...modelSeg}
            />
          ) : (
            <DropdownMenu open={modelDropped} onOpenChange={m.onOpen}>
              <DropdownMenuTrigger ref={m.trigger} {...modelSeg} />
              <DropdownMenuContent
                className="model-popover sg-popover"
                side="top"
                align="end"
                sideOffset={8}
                aria-label="選擇模型"
                onFocus={toChecked}
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
                <DropdownMenuRadioGroup
                  className="model-menu-groups"
                  value={m.current === undefined ? "" : keyOf(m.current)}
                  onValueChange={(v: string) => {
                    const x = m.models.find((y) => keyOf(y) === v);
                    if (x !== undefined) m.onChoose({ provider: x.provider, id: x.id });
                  }}
                >
                  {providers.map((p) => {
                    const spend = m.spend(p);
                    return (
                      <DropdownMenuGroup className="model-menu-group" key={p}>
                        <DropdownMenuLabel className="model-menu-head">
                          <span>{providerName(p)}</span>
                          <SpendText spend={spend} className="mono" />
                        </DropdownMenuLabel>
                        {m.models
                          .filter((x) => x.provider === p)
                          .map((x) => {
                            const on = isModel(x, m.current);
                            const sub = [
                              x.window === undefined
                                ? undefined
                                : `context ${windowText(x.window)}`,
                              x.unusable === undefined
                                ? effortRange(x.effortLevels)
                                : reasonText(x.unusable),
                            ].filter((t) => t !== undefined);
                            return (
                              <DropdownMenuRadioItem
                                key={x.id}
                                value={keyOf(x)}
                                className={on ? "model-menu-option active" : "model-menu-option"}
                                nativeButton
                                render={<button type="button" />}
                                disabled={
                                  !on && (x.unusable !== undefined || spend?.stopped === true)
                                }
                              >
                                <span className="model-menu-main">
                                  <span className="model-menu-name">{x.label}</span>
                                  <span className="model-menu-sub">{sub.join(" · ")}</span>
                                </span>
                              </DropdownMenuRadioItem>
                            );
                          })}
                      </DropdownMenuGroup>
                    );
                  })}
                </DropdownMenuRadioGroup>
                <p className="model-menu-note">{m.note}</p>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {e === undefined || effortSeg === undefined ? null : (
          <div className="effort-anchor">
            {props.compact ? (
              <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={false}
                onClick={() => e.onOpen(!e.open)}
                {...effortSeg}
              />
            ) : (
              <DropdownMenu open={dropped} onOpenChange={e.onOpen}>
                <DropdownMenuTrigger {...effortSeg} />
                <DropdownMenuContent
                  className="effort-popover sg-popover"
                  side="top"
                  align="end"
                  sideOffset={8}
                  aria-label="選擇推理強度"
                  onFocus={toChecked}
                >
                  <DropdownMenuRadioGroup
                    className="effort-options"
                    value={e.current ?? ""}
                    onValueChange={e.onPick}
                  >
                    {optionsOf(e).map(({ level, on }) => (
                      <DropdownMenuRadioItem
                        key={level}
                        value={level}
                        className={on ? "effort-option active" : "effort-option"}
                        nativeButton
                        render={<button type="button" />}
                      >
                        <div>
                          <div className="effort-option-title">
                            {effortName(level)}（{level}）
                          </div>
                          {NOTES[level] === undefined ? null : (
                            <div className="effort-option-note">{NOTES[level]}</div>
                          )}
                        </div>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const keyOf = (r: ModelRef) => `${r.provider}\u0000${r.id}`;

/**
 * Base UI's menu takes the focus to its first item on opening; the prototype's starts on the
 * chosen one, as a select does. Once per opening: the popup is a new element each time.
 */
function toChecked(e: FocusEvent<HTMLDivElement>) {
  const menu = e.currentTarget;
  // The popup itself may take the focus first; the move is on the first item that does.
  if (menu.dataset.started !== undefined || e.target.getAttribute("role") !== "menuitemradio")
    return;
  menu.dataset.started = "";
  const chosen = menu.querySelector<HTMLElement>(
    '[aria-checked="true"]:not([aria-disabled="true"])',
  );
  if (chosen !== null && chosen !== e.target) chosen.focus();
}

/** The phone's effort sheet (the prototype's overlay "effort"). */
export function EffortSheet(props: { effort: EffortControl; modelLabel: string }) {
  const close = () => props.effort.onOpen(false);
  return (
    <Panel
      phone
      title={`選擇推理強度（${props.modelLabel}）`}
      titleId="effort-sheet-title"
      onClose={close}
      foot={
        <>
          <span>選取後自下一則訊息生效</span>
          <button className="sg-btn" type="button" onClick={close}>
            關閉
          </button>
        </>
      }
    >
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
    </Panel>
  );
}
