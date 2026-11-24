import { type ReactNode, useEffect, useRef, useState } from "react";
import { TEXT_BYTES } from "@tars/protocol";
import { Icon } from "./Icon.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupTextarea,
} from "./ui/input-group.tsx";
import {
  type Builtin,
  type EffortMenu,
  menuFor,
  type Option,
  type Skill,
  slashOf,
  TAKES_ARG,
} from "./slash.ts";

const n = (v: number) => v.toLocaleString("en-US");
const tooLong = (bytes: number) =>
  `訊息超過上限（${n(TEXT_BYTES)} 位元組），目前 ${n(bytes)} 位元組。請縮短內容，或改放進允許的本機檔案再請 TARS 讀取。`;

export function Composer(props: {
  /** Each change gives the text box the focus: a new conversation was started. */
  focus?: number;
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
  /**
   * A built-in to run; `arg` is what follows its name (/wiki's keywords). What it gives back is
   * why it did not run, said under the box with the line kept.
   */
  onCommand: (name: Exclude<Builtin, "help">, arg: string) => string | undefined;
  /** The built-ins this page can run now; all but /wiki, /compact and /effort when absent. */
  builtins?: readonly Builtin[];
  /** /effort's levels, for the menu after `/effort `. */
  effort?: EffortMenu;
  /** Beside the send button: the model and effort control; absent from an older local end. */
  setup?: ReactNode;
  /** Whether there is unsent text, each time that changes. */
  onDraft?: (draft: boolean) => void;
}) {
  const [text, setText] = useState("");
  const { onDraft } = props;
  const draft = text !== "";
  useEffect(() => {
    onDraft?.(draft);
  }, [onDraft, draft]);
  // Esc closes the menu until the text changes.
  const [closed, setClosed] = useState(false);
  const [index, setIndex] = useState(0);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const off = props.blocked !== undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if ((props.focus ?? 0) > 0) input.current?.focus();
  }, [props.focus]);
  // Our own turn says so with the stop button; another one's (another conversation's, or one
  // being sent) says why the send button is off.
  const waitReason = props.canAbort ? undefined : props.busy;
  const menu =
    closed || off ? undefined : menuFor(text, props.skills, props.builtins, props.effort);
  const levels = menu?.some((o) => o.group.startsWith("選擇推理強度")) === true;
  // A press outside the menu, the text box and the / button closes the menu (14-14), as Esc.
  const menuBox = useRef<HTMLDivElement>(null);
  const slashButton = useRef<HTMLButtonElement>(null);
  const shown = menu !== undefined;
  useEffect(() => {
    if (!shown) return;
    const press = (e: PointerEvent) => {
      const at = e.target as Node;
      if ([menuBox, input, slashButton].some((r) => r.current?.contains(at) === true)) return;
      setClosed(true);
    };
    document.addEventListener("pointerdown", press);
    return () => document.removeEventListener("pointerdown", press);
  }, [shown]);
  const enabled = menu?.filter((o) => o.enabled) ?? [];
  const selected = enabled[Math.min(index, enabled.length - 1)];

  const change = (next: string) => {
    setText(next);
    setClosed(false);
    setIndex(0);
    setRefused(undefined);
  };
  const run = (name: Builtin, arg = "") => {
    if (name === "help") return change("/");
    const why = props.onCommand(name, arg);
    if (why === undefined) change("");
    else setRefused(why);
  };
  const apply = (o: Option) => {
    if (!o.enabled) return;
    if (o.level !== undefined) run("effort", o.level);
    else if (o.builtin && !TAKES_ARG.has(o.name as Builtin)) run(o.name as Builtin);
    else change(`/${o.name} `);
  };
  const send = () => {
    if (off || text.trim() === "") return;
    const s = slashOf(text.trim(), props.skills, props.builtins);
    if (s.kind === "builtin") return run(s.name, s.arg);
    if (s.kind === "refused") return setRefused(s.text);
    // Kept as typed until the turn is over.
    if (props.busy !== undefined) return;
    // A plain message goes as typed; a skill goes as the terminal words it.
    const out = s.text === text.trim() ? text : s.text;
    // The local end takes TEXT_BYTES of text, counted as UTF-8 (C4): said here, with both
    // numbers, before the message goes and comes back refused.
    const bytes = new TextEncoder().encode(out).length;
    if (bytes > TEXT_BYTES) return setRefused(tooLong(bytes));
    props.onSend(out);
    change("");
  };
  const move = (by: number) => {
    const n = enabled.length;
    // From the index React holds, not this render's: keys can come faster than renders.
    if (n > 0) setIndex((i) => (Math.min(i, n - 1) + by + n) % n);
  };
  const optionId = (o: Option) => `slash-opt-${o.name.replace(/\s/g, "-")}`;

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
          ref={menuBox}
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
                    title={
                      o.localOnly === true
                        ? "此 skill 僅限在本機終端 tars claude 執行"
                        : o.description
                    }
                    tabIndex={-1}
                    // Keep the focus in the text box.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => apply(o)}
                  >
                    <div className="slash-item-main">
                      <span className="slash-cmd">/{o.name}</span>
                      <span className="slash-desc">{o.description}</span>
                    </div>
                    {o.localOnly === true ? (
                      <span className="sg-tag">僅限本機</span>
                    ) : o.args === undefined && o.checked !== true ? null : (
                      <span className="slash-item-end">
                        {o.args === undefined ? null : (
                          <span className="mono slash-args">{o.args}</span>
                        )}
                        {o.checked === true ? <Icon name="check" /> : null}
                      </span>
                    )}
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="slash-menu-foot">
            <span>
              {!levels
                ? `共 ${menu.length} 項（往下捲動檢視 Skills 與本機限定）`
                : enabled.length > 0
                  ? "選取後自下一則訊息生效"
                  : "沒有可選的推理強度"}
            </span>
            <span>↑↓ 選擇 · Tab/Enter 套用 · Esc 關閉</span>
          </div>
        </div>
      )}
      {/* shadcn's Input Group: the box, the text and the toolbar under it. The prototype's
          classes draw it (styles.css); a box off is drawn as before, not faded. */}
      <InputGroup className="composer-box has-disabled:opacity-100">
        <label htmlFor="composer-input" className="sr-only">
          輸入訊息，或以 / 開啟指令
        </label>
        <InputGroupTextarea
          id="composer-input"
          ref={input}
          className="composer-input disabled:opacity-100"
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
            // A key the IME takes, picking a word: Safari's last one, the Enter that ends it,
            // comes after compositionend with isComposing false and keyCode 229.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
        <InputGroupAddon align="block-end" className="composer-toolbar">
          <div className="composer-toolbar-left">
            <button
              ref={slashButton}
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
            <InputGroupText className="composer-hint desktop-only">
              Enter 送出 · Shift+Enter 換行 · // 跳脫斜線
            </InputGroupText>
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
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
