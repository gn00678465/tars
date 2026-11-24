import type { Pull, PullState } from "../usePullToRefresh.ts";

const TEXT: Record<Pull, string> = {
  idle: "",
  pulling: "下拉重新整理",
  ready: "放開重新整理",
  busy: "重新整理中…",
  blocked: "有未送出的文字，先送出或清除",
};

/** The bar over the thread while it is pulled; app.css gives each state and step its height. */
export function PullIndicator({ state }: { state: PullState }) {
  if (!state.touched) return null;
  return (
    <div
      className="pull-indicator"
      role="status"
      data-pull={state.pull}
      {...(state.step === 0 ? {} : { "data-step": state.step })}
    >
      {state.pull === "busy" ? <span className="tars-sprite wheel" aria-hidden="true" /> : null}
      <span>{TEXT[state.pull]}</span>
    </div>
  );
}
