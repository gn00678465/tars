import { REASONS } from "../reasons.ts";
import { CopyCommand } from "./CopyCommand.tsx";

/** ui_spec 5.6: what happened, and the command that fixes it, copied in one press. */
export function ErrorCard(props: { code: string; provider: string | undefined }) {
  const reason = REASONS[props.code];
  // The conversation's provider when the page knows it; otherwise a placeholder to fill in.
  const fix = reason?.fix?.(props.provider ?? "<provider>");
  return (
    <div className="task-notice error" role="status">
      <div className="task-notice-body">
        <div className="task-notice-title">{reason?.text ?? `錯誤：${props.code}`}</div>
        {fix === undefined ? null : (
          <>
            <div className="task-notice-desc">在本機終端執行：</div>
            <CopyCommand command={fix} />
          </>
        )}
      </div>
    </div>
  );
}
