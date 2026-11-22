import type { WireModel, WireStatus } from "@tars/protocol";
import { reasonText } from "../reasons.ts";
import { Icon } from "./Icon.tsx";
import { periodName, providerName, providerSpend } from "./StatusBar.tsx";

interface Hint {
  readonly tone: "warn" | "error";
  readonly title: string;
  readonly desc: string;
  readonly action: string;
}

/**
 * Why this conversation's model cannot take the next message, said before the owner sends one
 * (9-02, 9-03). models.result lists only active models, so one missing from a non-empty list
 * was retired from the local end's catalog.
 */
function hints(
  conv: { readonly provider: string; readonly model: string },
  models: readonly WireModel[],
  status: WireStatus | undefined,
): Hint[] {
  const out: Hint[] = [];
  const m = models.find((x) => x.provider === conv.provider && x.id === conv.model);
  if (m === undefined && models.length > 0)
    out.push({
      tone: "warn",
      title: "這個模型已停用，請以另一個模型接續",
      desc: `本機端的模型清單已沒有 ${conv.model}。`,
      action: "選擇接續模型",
    });
  else if (m?.unusable !== undefined)
    out.push({
      tone: "warn",
      title: "這個模型目前無法使用，請以另一個模型接續",
      desc: `${reasonText(m.unusable)}。`,
      action: "選擇接續模型",
    });
  const p = status?.providers.find((x) => x.name === conv.provider);
  if (p !== undefined && providerSpend(status, conv.provider)?.stopped === true) {
    const others = (status?.providers ?? [])
      .filter((x) => x.name !== conv.provider && providerSpend(status, x.name)?.stopped === false)
      .map((x) => providerName(x.name));
    const period = periodName(p);
    out.push({
      tone: "error",
      title: `${providerName(conv.provider)} 已達${period}上限，可以改用其他 provider 接續`,
      desc: `${period}已用 ${p.spentUsd.toFixed(2)} / ${p.quotaUsd.toLocaleString("en-US")} USD${
        p.estimated === false ? "" : "（估）"
      }${others.length === 0 ? "。" : `，${others.join(" 與 ")} 仍可正常使用。`}`,
      action: "改用其他模型",
    });
  }
  return out;
}

export function ContinueHints(props: {
  conv: { readonly provider: string; readonly model: string };
  models: readonly WireModel[];
  status: WireStatus | undefined;
  onContinue: () => void;
}) {
  return hints(props.conv, props.models, props.status).map((h) => (
    <div className={`task-notice ${h.tone}`} key={h.title}>
      <div className="task-notice-body">
        <div className="task-notice-title">
          <Icon name="alert" />
          {h.title}
        </div>
        <div className="task-notice-desc">{h.desc}</div>
      </div>
      <button className="sg-btn" type="button" onClick={props.onContinue}>
        {h.action}
      </button>
    </div>
  ));
}
