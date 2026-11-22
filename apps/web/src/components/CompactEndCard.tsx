import { NACK_TEXT, type CompactEnd } from "../state.ts";
import { REASONS } from "../reasons.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { Icon } from "./Icon.tsx";
import { providerName } from "./StatusBar.tsx";

const SAME = "對話內容沒有改變。";

/**
 * How the owner's compaction ended when it wrote no summary (E3): skipped, stopped, or failed
 * with the local end's reason. compactWith writes only on success, so each says the conversation
 * is as it was.
 */
export function CompactEndCard(props: { end: CompactEnd; provider: string | undefined }) {
  const { end } = props;
  const d = end.data ?? {};
  const provider = typeof d.provider === "string" ? d.provider : props.provider;
  const named = provider === undefined ? "這家 provider" : providerName(provider);
  const reason = end.reason === undefined ? undefined : REASONS[end.reason];
  const shown =
    end.state === "skipped"
      ? {
          tone: "warn",
          title: "沒有可以壓縮的部分",
          desc: `較早的內容不夠多，只有近期原文。${SAME}`,
        }
      : end.state === "aborted"
        ? { tone: "", title: "壓縮已取消", desc: `${SAME}可以再壓縮一次。` }
        : {
            tone: "error",
            title: `壓縮失敗：${
              end.nack !== undefined
                ? NACK_TEXT[end.nack]
                : (reason?.title?.(named, d) ?? reason?.text ?? end.reason ?? "本機端沒有說明原因")
            }`,
            desc: `${SAME}${reason?.desc?.(named, d) ?? "可以再壓縮一次。"}`,
          };
  const fix = end.state === "failed" ? reason?.fix?.(provider ?? "<provider>") : undefined;
  return (
    <div className={`task-notice ${shown.tone}`} role="status">
      <div className="task-notice-body">
        <div className="task-notice-title">
          <Icon name="alert" />
          {shown.title}
        </div>
        <div className="task-notice-desc">{shown.desc}</div>
        {fix === undefined ? null : <CopyCommand command={fix} />}
      </div>
    </div>
  );
}
