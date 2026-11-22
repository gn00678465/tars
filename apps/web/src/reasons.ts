/** The local end's figures behind a code (an error's or a turn's data). */
export type Data = Readonly<Record<string, string | number>>;

/**
 * What the local end's reason codes mean (src/features/agent/request.ts REASON_TEXT, worded for
 * this page) and, where the owner fixes it at the terminal, the command to run there. The text
 * lives here; a code not listed shows as itself. desc is the error card's second line (ui_spec
 * 5.6, the prototype's scene 10), title its first when the figures make a better one; both are
 * given the data, which a local end older than it does not send ({}). tone is warn for a stop
 * the owner expected or can undo here, error otherwise.
 */
export interface Reason {
  readonly text: string;
  readonly title?: (provider: string, d: Data) => string | undefined;
  readonly desc?: (provider: string, d: Data) => string;
  readonly tone?: "warn";
  readonly fix?: (provider: string) => string;
}

const usd = (v: string | number | undefined) => Number(v).toFixed(2);
const has = (d: Data, ...keys: string[]) => keys.every((k) => d[k] !== undefined);
const period = (d: Data) =>
  d.period === "month" ? "本月" : d.period === "cumulative" ? "累計" : "本期";
const hhmm = (ms: number) => {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
};

export const REASONS: Record<string, Reason> = {
  aborted: { text: "已取消" },
  config_invalid: { text: "本機的 config.toml 有問題，請在終端檢查" },
  catalog_invalid: { text: "本機的 models.json 有問題，請在終端檢查" },
  boot_failed: { text: "本機端讀不到 SOUL.md 或 MEMORY.md" },
  provider_disabled: { text: "這家 provider 沒有啟用" },
  no_key: {
    text: "這家 provider 沒有 API 金鑰",
    desc: (p) => `本機的系統金鑰庫沒有 ${p} 的金鑰。請在本機終端設定。`,
    fix: (p) => `tars llm key set ${p}`,
  },
  unknown_model: {
    text: "模型不在清單上，或沒有啟用",
    fix: (p) => `tars models refresh --provider ${p}`,
  },
  price_incomplete: {
    text: "模型的上限或單價不完整",
    fix: (p) => `tars models refresh --provider ${p}`,
  },
  prices_stale: {
    text: "模型的價目太久沒有確認",
    desc: (p) => `${p} 的價目已過期，暫停送出請求。核對官方價目後，在本機終端確認。`,
    tone: "warn",
    fix: (p) => `tars models confirm-prices --provider ${p}`,
  },
  conv_too_long: { text: "對話太長，超過硬停線。請開新對話", tone: "warn" },
  // Continuing in another model: the local end's CARRY_TEXT, with the page's controls for it.
  carry_summary_too_long: {
    text: "前一個對話的摘要太長，帶不進這個模型。把帶入範圍改成「最後幾個回合」，或選視窗較大的模型",
    tone: "warn",
  },
  carry_turn_too_long: {
    text: "最近一個回合就超過這個模型能帶入的長度，縮小帶入範圍也帶不進去。選視窗較大的模型，或開新對話",
    tone: "warn",
  },
  carry_over_stop: {
    text: "這則訊息加上帶入的內容太長。縮短訊息，或把帶入範圍改成更少的回合",
    tone: "warn",
  },
  budget_stopped: {
    text: "本期花費已到停用門檻",
    title: (_, d) =>
      has(d, "stopUsd", "quotaUsd")
        ? `本機端達停用門檻（${Math.round((Number(d.stopUsd) / Number(d.quotaUsd)) * 100)}%）`
        : undefined,
    desc: (p, d) =>
      has(d, "spentUsd", "quotaUsd")
        ? `${p} ${period(d)}已用 ${usd(d.spentUsd)} / ${Number(d.quotaUsd).toLocaleString("en-US")} USD（估）。若帳單頁實際較低，請在本機終端校正。`
        : `${p} 暫停使用。若帳單頁的實際花費較低，請在本機終端校正。`,
    fix: (p) => `tars cost adjust ${p} --spent <金額>`,
  },
  daily_cap: {
    text: "今日花費已到上限，明天重算",
    title: (_, d) =>
      has(d, "dailyCapUsd") ? `今日花費已到上限（${usd(d.dailyCapUsd)} USD）` : undefined,
    // The local end counts a day in UTC (ledger.ts spentToday): resetAt is the next UTC midnight.
    desc: (p, d) =>
      has(d, "todayUsd", "resetAt")
        ? `${p} 今日已用 ${usd(d.todayUsd)} USD，這個回合已自動結束。UTC 00:00（這台裝置的 ${hhmm(Number(d.resetAt))}）重算，或在本機的設定檔調整上限。`
        : "這個回合已自動結束。要提高上限，請在本機的設定檔調整。",
    tone: "warn",
  },
  turn_cap: {
    text: "這個回合的花費已到上限",
    title: (_, d) =>
      has(d, "turnCapUsd") ? `這個回合的花費已到上限（${usd(d.turnCapUsd)} USD）` : undefined,
    desc: (_, d) =>
      has(d, "turnUsd")
        ? `這個回合累計 ${usd(d.turnUsd)} USD，已自動結束。要提高上限，請在本機的設定檔調整。`
        : "這個回合已自動結束。要提高上限，請在本機的設定檔調整。",
    tone: "warn",
  },
  budget_unreadable: { text: "本機端讀不到用量帳，請更新 tars" },
  request_limit: {
    text: "這個回合的模型請求次數已到上限",
    title: (_, d) => (has(d, "max") ? `達到單回合請求次數上限（${d.max} 次）` : undefined),
    desc: (_, d) =>
      has(d, "max")
        ? `這個回合已執行 ${d.max} 次模型請求後自動停止。請檢視進度，再決定是否繼續。`
        : "這個回合已自動停止。請檢視進度，再決定是否繼續。",
    tone: "warn",
  },
  provider_spend_limit: {
    text: "provider 端的花費上限已到",
    title: (p, d) => (has(d, "provider") ? `${p} 伺服端已達 Spend Limit` : undefined),
    desc: (p) => `這個回合已停止。${p} 在下次重算或調高上限前無法使用，其他 provider 不受影響。`,
  },
  rate_limited: {
    text: "流量限制（HTTP 429）",
    // A refused request is voided at no cost (ledger settleFailure).
    desc: (_, d) =>
      has(d, "attempts")
        ? `已退避重試 ${Number(d.attempts) - 1} 次仍被限流，被拒的請求沒有計費。請稍後再試。`
        : "重試用完仍被限流，被拒的請求沒有計費。請稍後再試。",
    tone: "warn",
  },
  keyring_unavailable: {
    text: "讀不到本機系統金鑰庫",
    desc: () => "本機需要登入桌面環境才能解鎖金鑰庫。解鎖後再送一次。",
  },
  // reconcile, when the local end starts again after it stopped mid-turn.
  interrupted: {
    text: "回合中斷（本機端重啟）",
    title: (_, d) => (d.turnKind === "compaction" ? "壓縮中斷（本機端重啟）" : undefined),
    desc: (_, d) =>
      d.script !== undefined
        ? `腳本 ${d.script} 的結果不明，系統沒有自動重跑。請先確認狀態再繼續。`
        : d.turnKind === "compaction"
          ? "對話內容沒有改變，可以再壓縮一次。"
          : "這則回覆不完整，系統沒有自動重跑。可以再送一次。",
    tone: "warn",
  },
  auth: {
    text: "provider 拒絕了 API 金鑰",
    desc: (p) => `${p} 回絕這個金鑰。請在本機終端重新設定金鑰。`,
    fix: (p) => `tars llm key set ${p}`,
  },
  bad_request: { text: "provider 拒絕了這個請求" },
  // A turn that failed with no reason the local end named (it threw before ending the turn).
  turn_failed: {
    text: "回合失敗",
    desc: () => "本機端沒有說明原因。可以再送一次，或在本機終端查看紀錄。",
  },
  provider_error: { text: "provider 暫時無法回應，重試用完了，請稍後再試" },
  stream_interrupted: {
    text: "回應中途斷線",
    desc: () => "已收到的文字保留在上面。可以再送一次。",
  },
  compact_too_large: { text: "要壓縮的內容太大" },
  compact_truncated: { text: "摘要超過輸出上限" },
  compact_bad_summary: { text: "摘要的格式不對" },
};

export const reasonText = (code: string) => REASONS[code]?.text ?? code;
