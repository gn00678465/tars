import { useState } from "react";

export function Composer(props: {
  /** Why nothing can be sent now; undefined when it can. */
  blocked: string | undefined;
  /** A turn runs in this conversation: it can be stopped. */
  canAbort: boolean;
  error: string | undefined;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const [text, setText] = useState("");
  const off = props.blocked !== undefined;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (off || text.trim() === "") return;
        props.onSend(text);
        setText("");
      }}
    >
      <textarea
        aria-label="訊息"
        value={text}
        disabled={off}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" disabled={off || text.trim() === ""}>
        送出
      </button>
      <button type="button" disabled={!props.canAbort} onClick={props.onAbort}>
        中止
      </button>
      {off ? <p className="reason">{props.blocked}</p> : null}
      {props.error === undefined ? null : (
        <p className="reason" role="alert">
          {props.error}
        </p>
      )}
    </form>
  );
}
