import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";

/** How long 已複製 shows before the button reads 複製指令 again, as the prototype. */
export const COPIED_MS = 1_800;

/** A command for the owner's terminal, copied in one press (the prototype's cli-copy-row). */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | undefined>(undefined);
  useEffect(() => {
    if (copied !== "yes") return;
    const t = setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      <div className="cli-copy-row">
        <code className="cli-copy-cmd">{command}</code>
        <button
          className="sg-btn sg-btn-sm"
          type="button"
          onClick={() => {
            // No clipboard (an old browser, a page not in a secure context): the command is
            // still there to select by hand.
            const write = navigator.clipboard?.writeText(command);
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
  );
}
