import { REASONS, type Data } from "../reasons.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { NoticeItem } from "./NoticeItem.tsx";
import { providerName } from "./StatusBar.tsx";

/** ui_spec 5.6: what happened, what it means, and the command that fixes it, copied in one press. */
export function ErrorCard(props: { code: string; provider: string | undefined; data?: Data }) {
  const reason = REASONS[props.code];
  const d = props.data ?? {};
  // The provider the local end names, else the conversation's when the page knows it; otherwise
  // words, or a placeholder to fill in for the command.
  const provider = typeof d.provider === "string" ? d.provider : props.provider;
  const fix = reason?.fix?.(provider ?? "<provider>");
  const named = provider === undefined ? "這家 provider" : providerName(provider);
  const desc = reason?.desc?.(named, d);
  const title = reason?.title?.(named, d);
  return (
    <NoticeItem
      tone={reason?.tone ?? "error"}
      role="status"
      title={title ?? reason?.text ?? `錯誤：${props.code}`}
      {...(desc === undefined ? {} : { desc })}
    >
      {fix === undefined ? null : <CopyCommand command={fix} />}
    </NoticeItem>
  );
}
