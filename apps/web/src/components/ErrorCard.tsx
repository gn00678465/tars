import { useState } from "react";
import { REASONS } from "../reasons.ts";
import { Icon } from "./Icon.tsx";

/** ui_spec 5.6: what happened, and the command that fixes it, copied in one press. */
export function ErrorCard(props: { code: string; provider: string | undefined }) {
  const reason = REASONS[props.code];
  // The conversation's provider when the page knows it; otherwise a placeholder to fill in.
  const fix = reason?.fix?.(props.provider ?? "<provider>");
  const [copied, setCopied] = useState<"yes" | "failed" | undefined>(undefined);
  return (
    <div className="task-notice error" role="status">
      <div className="task-notice-body">
        <div className="task-notice-title">{reason?.text ?? `錯誤：${props.code}`}</div>
        {fix === undefined ? null : (
          <>
            <div className="task-notice-desc">在本機終端執行：</div>
            <div className="cli-copy-row">
              <code className="cli-copy-cmd">{fix}</code>
              <button
                className="sg-btn sg-btn-sm"
                type="button"
                onClick={() => {
                  // No clipboard (an old browser, a page not in a secure context): the command
                  // is still there to select by hand.
                  const write = navigator.clipboard?.writeText(fix);
                  if (write === undefined) return setCopied("failed");
                  write.then(
                    () => setCopied("yes"),
                    () => setCopied("failed"),
                  );
                }}
              >
                <Icon name={copied === "yes" ? "check" : "copy"} />
                <span>{copied === "yes" ? "已複製" : "複製指令"}</span>
              </button>
            </div>
            {copied === "failed" ? (
              <div className="task-notice-desc" role="alert">
                無法寫入剪貼簿，請手動選取上面的指令
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
