import { type ReactNode, useRef, useState } from "react";
import { type Builtin, menuFor, type Option, type Skill, slashOf } from "./slash.ts";

export function Composer(props: {
  /** Why the composer is off; undefined when it is on. */
  blocked: string | undefined;
  /** Why a message cannot go yet (a turn runs, one is being sent); typing goes on. */
  busy: string | undefined;
  /** A turn runs in this conversation: the send button stops it. */
  canAbort: boolean;
  error: string | undefined;
  /** The local end's skills, for the / menu; undefined from a local end that does not say. */
  skills: readonly Skill[] | undefined;
  onSend: (text: string) => void;
  onAbort: () => void;
  onCommand: (name: Exclude<Builtin, "help">) => void;
  /** Beside the send button: the model and effort control; absent from an older local end. */
  setup?: ReactNode;
}) {
  const [text, setText] = useState("");
  // Esc closes the menu until the text changes.
  const [closed, setClosed] = useState(false);
  const [index, setIndex] = useState(0);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const off = props.blocked !== undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  // Our own turn says so with the stop button; another one's (another conversation's, or one
  // being sent) says why the send button is off.
  const waitReason = props.canAbort ? undefined : props.busy;
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
    // Kept as typed until the turn is over.
    if (props.busy !== undefined) return;
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
      {off || waitReason !== undefined ? (
        <div className="composer-disabled-reason reason">
          <span>{props.blocked ?? waitReason}</span>
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
          ref={input}
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
            <button
              className="sg-btn sg-btn-ghost"
              type="button"
              title="插入 / 指令（以 // 開頭可送出純斜線）"
              disabled={off}
              onClick={() => {
                change("/");
                input.current?.focus();
              }}
            >
              <span className="mono">/</span>
              <span>指令</span>
            </button>
            <span className="composer-hint desktop-only">
              Enter 送出 · Shift+Enter 換行 · // 跳脫斜線
            </span>
          </div>
          <div className="composer-toolbar-right">
            {props.setup}
            {props.canAbort ? (
              <button className="sg-btn sg-btn-danger" type="button" onClick={props.onAbort}>
                停止
              </button>
            ) : (
              <button
                className="sg-btn sg-btn-primary"
                type="submit"
                disabled={off || props.busy !== undefined || text.trim() === ""}
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
