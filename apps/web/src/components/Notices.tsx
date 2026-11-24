import type { Notice } from "../state.ts";
import { reasonText } from "../reasons.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { NoticeItem } from "./NoticeItem.tsx";
import { effortName } from "./RunSetup.tsx";

type Tone = "" | "active" | "warn" | "error";

interface Shown {
  readonly tone: Tone;
  readonly title: string;
  readonly desc?: string;
  readonly command?: string;
  /** Offers the effort control, when the page has one. */
  readonly effort?: boolean;
}

/** What a notice is about: the conversation's provider and effort, when the page knows them. */
interface NoticeContext {
  readonly provider: string | undefined;
  readonly effort: string | undefined;
}

const num = (v: string | number | undefined) => (typeof v === "number" ? v : Number(v));
const usd = (v: string | number | undefined) => num(v).toFixed(2);

/**
 * The local end's notice codes (src/features/agent/types.ts NOTICE_CODES) as the prototype's
 * task-notice: a title, what it means, and a command when the owner fixes it at the terminal.
 * The data is what the engine sends with each code; a code not listed shows as itself.
 */
function shown(n: Notice, c: NoticeContext): Shown {
  const d = n.data ?? {};
  switch (n.code) {
    case "compact_start":
      return {
        tone: "active",
        // The owner's own compaction is not about the limit; a local end older than trigger
        // starts one only near it.
        title: d.trigger === "manual" ? "正在壓縮較早的部分" : "上下文接近上限，正在壓縮較早的部分",
        desc: "較早的訊息會換成摘要，本機資料庫的原始紀錄仍完整保存。",
      };
    case "compact_skipped":
      return {
        tone: "warn",
        title: "上下文接近上限，但沒有可以壓縮的部分",
        desc: "可以開新對話，或以另一個模型接續。",
      };
    case "compact_failed":
      return {
        tone: "warn",
        title: "自動壓縮失敗",
        desc: `${reasonText(String(d.reason ?? ""))}。這則訊息照常送出。`,
      };
    case "blocked":
      return {
        tone: "warn",
        title: "已擋下：這個入口不提供這個指令",
        ...(d.reason === undefined ? {} : { desc: String(d.reason) }),
      };
    case "budget_warn":
      return {
        tone: "warn",
        title: `本期已用 ${usd(d.spentUsd)} / ${usd(d.quotaUsd)} USD，已過提醒門檻`,
        desc: "到停用門檻時，本機端會停止送出這家 provider 的請求。",
      };
    case "prices_warn":
      return {
        tone: "warn",
        title: `模型價目已 ${num(d.days)} 天沒有確認`,
        desc: "價目太舊時會暫停使用這個模型。核對官方價目後，在本機終端確認。",
        command: `tars models confirm-prices --provider ${c.provider ?? "<provider>"}`,
      };
    case "context_warn":
      return {
        tone: "warn",
        title: `上下文已用 ${num(d.percent)}%`,
        desc:
          d.autoCompact === "on"
            ? "達到壓縮門檻時，會自動把較早的部分壓縮成摘要。"
            : "自動壓縮沒有開啟。用完之前，請開新對話或以另一個模型接續。",
      };
    case "retrying":
      return {
        tone: "active",
        title: `provider 暫時無法回應，${num(d.waitMs) / 1000} 秒後重試`,
        desc: `已失敗 ${num(d.attempt)} 次。`,
      };
    case "output_capped":
      return {
        tone: "warn",
        title: `這次的輸出上限降到 ${num(d.maxTokens).toLocaleString("en-US")} tokens`,
        desc: "剩下的預算不夠原本的輸出上限，回覆可能被截斷。",
      };
    case "effort_unsupported":
      return {
        tone: "",
        title: "這個模型不支援推理強度",
        desc: "這次請求不帶推理強度設定。",
      };
    case "effort_clamped": {
      const now = effortName(String(d.effort ?? ""));
      return {
        tone: "warn",
        title:
          c.effort === undefined || c.effort === d.effort
            ? `模型不支援原本的推理強度，已改用「${now}」`
            : `模型不支援「${effortName(c.effort)}」，已改用「${now}」`,
        desc: "點開右下角的推理強度重選後，這個警告就會消失。",
      };
    }
    case "effort_truncated":
      return {
        tone: "warn",
        title: "輸出上限被思考用完，請降低推理強度",
        desc: "這次請求用完了單次輸出上限，但沒有輸出正文。",
        effort: true,
      };
    case "usage_missing":
      return {
        tone: "warn",
        title: "這個請求沒有回報用量",
        desc: "這次的花費依輸入與輸出長度估算。",
      };
    default: {
      const data = Object.entries(d)
        .map(([k, v]) => `${k}=${v}`)
        .join("，");
      return { tone: "", title: `本機端通知：${n.code}`, ...(data === "" ? {} : { desc: data }) };
    }
  }
}

export function NoticeCard(props: {
  notice: Notice;
  context: NoticeContext;
  /** Opens the effort control; absent when the page offers none. */
  onEffort?: () => void;
}) {
  const s = shown(props.notice, props.context);
  return (
    <NoticeItem
      tone={s.tone}
      role="status"
      title={s.title}
      {...(s.desc === undefined ? {} : { desc: s.desc })}
      {...(s.effort === true && props.onEffort !== undefined
        ? {
            action: (
              <button className="sg-btn" type="button" onClick={props.onEffort}>
                調整推理強度
              </button>
            ),
          }
        : {})}
    >
      {s.command === undefined ? null : <CopyCommand command={s.command} />}
    </NoticeItem>
  );
}
