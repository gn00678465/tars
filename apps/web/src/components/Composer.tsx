import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { type Builtin, menuFor, type Option, type Skill, slashOf } from "./slash.ts";

export function Composer(props: {
  /** Why nothing can be sent now; undefined when it can. */
  blocked: string | undefined;
  /** A turn runs in this conversation: the send button stops it. */
  canAbort: boolean;
  error: string | undefined;
  /** The local end's skills, for the / menu; undefined from a local end that does not say. */
  skills: readonly Skill[] | undefined;
  onSend: (text: string) => void;
  onAbort: () => void;
  onCommand: (name: Exclude<Builtin, "help">) => void;
  /** The model the next message goes to, and how to pick another; absent from an older local end. */
  model?: { readonly label: string; readonly onPick: () => void };
}) {
  const [text, setText] = useState("");
  // Esc closes the menu until the text changes.
  const [closed, setClosed] = useState(false);
  const [index, setIndex] = useState(0);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const off = props.blocked !== undefined;
  const menu = closed || off ? undefined : menuFor(text, props.skills);
  const enabled = menu?.filter((o) => o.enabled) ?? [];
  const selected = enabled[Math.min(index, enabled.length - 1)];

  const change = (next: string) => {
    setText(next);
    setClosed(false);
    setIndex(0);
    setRefused(undefined);
  };
  const run = (name: Builtin) => {
    if (name === "help") return change("/");
    change("");
    props.onCommand(name);
  };
  const apply = (o: Option) => {
    if (!o.enabled) return;
    if (o.builtin) run(o.name as Builtin);
    else change(`/${o.name} `);
  };
  const send = () => {
    if (off || text.trim() === "") return;
    const s = slashOf(text.trim(), props.skills);
    if (s.kind === "builtin") return run(s.name);
    if (s.kind === "refused") return setRefused(s.text);
    // A plain message goes as typed; a skill goes as the terminal words it.
    props.onSend(s.text === text.trim() ? text : s.text);
    change("");
  };
  const move = (by: number) => {
    const n = enabled.length;
    // From the index React holds, not this render's: keys can come faster than renders.
    if (n > 0) setIndex((i) => (Math.min(i, n - 1) + by + n) % n);
  };
  const optionId = (o: Option) => `slash-opt-${o.name}`;

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {off ? (
        <div className="composer-disabled-reason reason">
          <span>{props.blocked}</span>
        </div>
      ) : null}
      {props.error === undefined && refused === undefined ? null : (
        <div className="composer-inline-err" role="alert">
          {refused ?? props.error}
        </div>
      )}
      {menu === undefined ? null : (
        <div
          id="slash-menu"
          className="slash-menu sg-popover"
          role="listbox"
          aria-label="指令與可用的 skills"
        >
          <div className="slash-menu-scroll">
            {menu.length === 0 ? (
              <div className="slash-group-label">找不到符合的指令或 skill</div>
            ) : (
              menu.map((o, i) => (
                <div key={o.name} className="slash-row" role="presentation">
                  {o.group === menu[i - 1]?.group ? null : (
                    <div className="slash-group-label">{o.group}</div>
                  )}
                  <button
                    id={optionId(o)}
                    className={o === selected ? "slash-item selected" : "slash-item"}
                    type="button"
                    role="option"
                    aria-selected={o === selected}
                    aria-disabled={!o.enabled}
                    tabIndex={-1}
                    // Keep the focus in the text box.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => apply(o)}
                  >
                    <div className="slash-item-main">
                      <span className="slash-cmd">/{o.name}</span>
                      <span className="slash-desc">{o.description}</span>
                    </div>
                    {o.enabled ? null : <span className="sg-tag">僅限本機</span>}
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="slash-menu-foot">
            <span>共 {menu.length} 項</span>
            <span>↑↓ 選擇 · Tab/Enter 套用 · Esc 關閉</span>
          </div>
        </div>
      )}
      <div className="composer-box">
        <label htmlFor="composer-input" className="sr-only">
          輸入訊息，或以 / 開啟指令
        </label>
        <textarea
          id="composer-input"
          className="composer-input"
          rows={2}
          role="combobox"
          aria-label="訊息"
          aria-autocomplete="list"
          aria-controls="slash-menu"
          aria-expanded={menu !== undefined}
          {...(menu !== undefined && selected !== undefined
            ? { "aria-activedescendant": optionId(selected) }
            : {})}
          placeholder="輸入訊息，或輸入 / 開啟指令與 skill…"
          value={text}
          disabled={off}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (menu !== undefined) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                return move(e.key === "ArrowDown" ? 1 : -1);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                return setClosed(true);
              }
              if (((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") && selected) {
                e.preventDefault();
                return apply(selected);
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <span className="composer-hint desktop-only">Enter 送出 · Shift+Enter 換行</span>
          </div>
          <div className="composer-toolbar-right">
            {props.model === undefined ? null : (
              <div className="run-setup" role="group" aria-label="模型">
                <button
                  className="run-seg"
                  type="button"
                  aria-haspopup="dialog"
                  title="選擇模型"
                  onClick={props.model.onPick}
                >
                  <span className="run-seg-label">模型</span>
                  <span>{props.model.label}</span>
                  <Icon name="chevron" />
                </button>
              </div>
            )}
            {props.canAbort ? (
              <button className="sg-btn sg-btn-danger" type="button" onClick={props.onAbort}>
                中止
              </button>
            ) : (
              <button
                className="sg-btn sg-btn-primary"
                type="submit"
                disabled={off || text.trim() === ""}
              >
                送出
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
