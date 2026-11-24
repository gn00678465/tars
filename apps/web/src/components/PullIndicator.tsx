import type { Pull, PullState } from "../usePullToRefresh.ts";

const TEXT: Record<Pull, string> = {
  idle: "",
  pulling: "下拉重新整理",
  ready: "放開重新整理",
  busy: "重新整理中…",
  blocked: "有未送出的文字，先送出或清除",
  back: "",
};

/**
 * The indicator in the space the moved page leaves at the top (app.css). One box in every state:
 * the wheel's place is kept when it is not turning, and the text is one line, so nothing moves
 * from 放開重新整理 to 重新整理中….
 */
export function PullIndicator({ state }: { state: PullState }) {
  if (!state.touched) return null;
  return (
    <div className="pull-indicator" role="status" data-pull={state.pull}>
      <span
        className={state.pull === "busy" ? "tars-sprite wheel" : "tars-sprite pull-mark"}
        aria-hidden="true"
      />
      <span className="pull-text">{TEXT[state.pull]}</span>
    </div>
  );
}
