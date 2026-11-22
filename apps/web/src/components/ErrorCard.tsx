import { REASONS } from "../reasons.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { Icon } from "./Icon.tsx";
import { providerName } from "./StatusBar.tsx";

/** ui_spec 5.6: what happened, what it means, and the command that fixes it, copied in one press. */
export function ErrorCard(props: { code: string; provider: string | undefined }) {
  const reason = REASONS[props.code];
  // The conversation's provider when the page knows it; otherwise words, or a placeholder to
  // fill in for the command.
  const fix = reason?.fix?.(props.provider ?? "<provider>");
  const desc = reason?.desc?.(
    props.provider === undefined ? "這家 provider" : providerName(props.provider),
  );
  return (
    <div className={`task-notice ${reason?.tone ?? "error"}`} role="status">
      <div className="task-notice-body">
        <div className="task-notice-title">
          <Icon name="alert" />
          {reason?.text ?? `錯誤：${props.code}`}
        </div>
        {desc === undefined ? null : <div className="task-notice-desc">{desc}</div>}
        {fix === undefined ? null : <CopyCommand command={fix} />}
      </div>
    </div>
  );
}
