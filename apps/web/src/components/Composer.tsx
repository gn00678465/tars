import { useState } from "react";

export function Composer(props: {
  /** Why nothing can be sent now; undefined when it can. */
  blocked: string | undefined;
  /** A turn runs in this conversation: the send button stops it. */
  canAbort: boolean;
  error: string | undefined;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const [text, setText] = useState("");
  const off = props.blocked !== undefined;
  const send = () => {
    if (off || text.trim() === "") return;
    props.onSend(text);
    setText("");
  };
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
      {props.error === undefined ? null : (
        <div className="composer-inline-err" role="alert">
          {props.error}
        </div>
      )}
      <div className="composer-box">
        <label htmlFor="composer-input" className="sr-only">
          輸入訊息
        </label>
        <textarea
          id="composer-input"
          className="composer-input"
          rows={2}
          aria-label="訊息"
          placeholder="輸入訊息，或輸入 / 開啟指令與 skill…"
          value={text}
          disabled={off}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
