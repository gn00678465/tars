import type { WireCatalogEntry, WireStatus } from "@tars/protocol";
import type { State } from "../state.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { Icon } from "./Icon.tsx";
import { providerName } from "./StatusBar.tsx";

type Warn = NonNullable<WireStatus["prices"]>[number];
type Catalog = NonNullable<State["catalog"]>;

/** A model by the label the list gives it, else its id. */
const labelOf = (catalog: Catalog | undefined, provider: string, id: string) =>
  catalog?.entries.find((e) => e.provider === provider && e.id === id)?.label ?? id;

const ageText = (w: Warn) =>
  w.state === "missing" || w.ageDays === undefined ? "沒有價目" : `價目 ${w.ageDays} 天未確認`;

/**
 * The top bar's price warning (8-05): the first model whose price needs confirming, as the
 * prototype's 「Opus 價目 34 天未確認」. Undefined when status names none (a local end older than
 * prices says only pricesWarn).
 */
export function priceButtonText(
  status: WireStatus | undefined,
  catalog: Catalog | undefined,
): string | undefined {
  const w = status?.prices?.[0];
  return w === undefined ? undefined : `${labelOf(catalog, w.provider, w.model)} ${ageText(w)}`;
}

/** The list's last update as the top bar writes it (1-08): MM-DD of the UTC date. */
export const updatedText = (catalog: Catalog | undefined) =>
  catalog?.updatedAt === undefined ? undefined : catalog.updatedAt.slice(5, 10);

/**
 * One notice per provider whose models' prices need confirming (8-02): which models, how old,
 * the candidates not taken on, and the terminal command. Prices are changed only there.
 */
export function PriceNotices(props: { status: WireStatus; catalog: Catalog | undefined }) {
  const warns = props.status.prices ?? [];
  const providers = [...new Set(warns.map((w) => w.provider))];
  const candidates = props.status.candidates ?? 0;
  return providers.map((p, i) => {
    const mine = warns.filter((w) => w.provider === p);
    const name = (w: Warn) => labelOf(props.catalog, w.provider, w.model);
    const one = mine.length === 1 ? (mine[0] as Warn) : undefined;
    const title =
      one === undefined
        ? `${providerName(p)} 有 ${mine.length} 個模型的價目需要確認`
        : `${providerName(p)} ${name(one)} ${one.state === "missing" ? "沒有價目" : `價目已 ${one.ageDays ?? "?"} 天未確認`}`;
    const refused = mine.some((w) => w.state === "refused");
    const missing = mine.every((w) => w.state === "missing");
    const list =
      one === undefined ? `${mine.map((w) => `${name(w)}（${ageText(w)}）`).join("、")}。` : "";
    const desc = missing
      ? "沒有價目的模型無法使用。請在本機終端更新模型清單。"
      : refused
        ? "價目過期太久，這個模型已暫停使用。核對官方價目頁後，在本機終端確認日期。"
        : "超過暫停門檻後會暫停使用。核對官方價目頁後，在本機終端確認日期。";
    return (
      <div className={`task-notice ${refused || missing ? "error" : "warn"}`} key={p}>
        <div className="task-notice-body">
          <div className="task-notice-title">
            <Icon name="alert" />
            {title}
            {i === 0 && candidates > 0 ? ` · 有 ${candidates} 個候選模型未啟用` : ""}
          </div>
          <div className="task-notice-desc">
            {list}
            {desc}
          </div>
          <CopyCommand
            command={
              missing
                ? `tars models refresh --provider ${p}`
                : `tars models confirm-prices --provider ${p}`
            }
          />
        </div>
      </div>
    );
  });
}

const STATUS: Record<string, [string, string]> = {
  active: ["ok", "啟用"],
  candidate: ["warn", "候選"],
  disabled: ["", "停用"],
  retired: ["error", "已下架"],
};
const SOURCE: Record<string, string> = { manual: "手填", openrouter: "OpenRouter" };
const price = (v: number | undefined) => (v === undefined ? "—" : String(v));
const n = (v: number) => v.toLocaleString("en-US");

/**
 * The local list's models and prices, read only (8-01, 8-03, 8-04). Only `tars models` changes
 * them, at the terminal; nothing here sends anything.
 */
export function PriceTable(props: { catalog: Catalog; warns: readonly Warn[] }) {
  const { entries, total, updatedAt } = props.catalog;
  const warned = (e: WireCatalogEntry) =>
    props.warns.some((w) => w.provider === e.provider && w.model === e.id);
  return (
    <div className="provider-group">
      <div className="provider-group-head">
        <span>模型清單與價目表</span>
        {updatedAt === undefined ? null : (
          <span className="mono provider-group-sub">{updatedAt} 更新</span>
        )}
      </div>
      <div className="table-scroll">
        <table className="catalog-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>模型</th>
              <th>狀態</th>
              <th>視窗</th>
              <th>輸入 / 輸出 / 快取讀 / 快取寫（USD/MTok）</th>
              <th>來源與日期</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const [tone, label] = STATUS[e.status] ?? ["", e.status];
              return (
                <tr key={`${e.provider}/${e.id}`}>
                  <td>{providerName(e.provider)}</td>
                  <td>
                    <div className="model-option-name">{e.label}</div>
                    <div className="mono model-option-id">{e.id}</div>
                  </td>
                  <td>
                    <span className={`sg-tag ${tone}`}>{label}</span>
                  </td>
                  <td className="mono">
                    {e.window === undefined ? "—" : `${n(Math.round(e.window / 1000))}K`}
                  </td>
                  <td className="mono">
                    {e.price === undefined
                      ? "—"
                      : [e.price.input, e.price.output, e.price.cacheRead, e.price.cacheWrite]
                          .map(price)
                          .join(" / ")}
                  </td>
                  <td className="mono">
                    {[e.priceSource === undefined ? undefined : SOURCE[e.priceSource], e.pricedAt]
                      .filter((x) => x !== undefined)
                      .join(" · ") || "—"}
                    {warned(e) ? <span className="sg-tag warn">過期警告</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="catalog-note">
        單價是每百萬 tokens 的美元價格，日期是確認價目的 UTC 日期。
        {total !== undefined && total > entries.length
          ? `清單共 ${n(total)} 個模型，這裡列出前 ${n(entries.length)} 個，啟用的在前。`
          : ""}
      </p>
    </div>
  );
}
