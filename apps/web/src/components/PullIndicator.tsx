import { LoaderCircleIcon } from "lucide-react";
import type { Pull, PullState } from "../usePullToRefresh.ts";

const TEXT: Record<Pull, string> = {
  idle: "",
  pulling: "下拉重新整理",
  ready: "放開重新整理",
  busy: "重新整理中…",
  blocked: "有未送出的文字，先送出或清除",
  back: "",
};

/** The spinner shows and turns from the first pull on: after the let-go the page reloads in 0.2 s. */
const SPINS = new Set<Pull>(["pulling", "ready", "busy"]);

/**
 * The indicator in the space the moved page leaves at the top (app.css). One box in every state:
 * the spinner's place is kept where it is not shown (a message, the way back), and the text is one line, so nothing moves
 * from 放開重新整理 to 重新整理中…. The spinner is lucide's, the library the other icons come from.
 */
export function PullIndicator({ state }: { state: PullState }) {
  if (!state.touched) return null;
  return (
    <div className="pull-indicator" role="status" data-pull={state.pull}>
      <span
        className={SPINS.has(state.pull) ? "pull-mark pull-spin" : "pull-mark"}
        aria-hidden="true"
      >
        <LoaderCircleIcon />
      </span>
      <span className="pull-text">{TEXT[state.pull]}</span>
    </div>
  );
}
