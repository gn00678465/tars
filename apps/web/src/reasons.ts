/**
 * What the local end's reason codes mean (src/features/agent/request.ts REASON_TEXT, worded for
 * this page) and, where the owner fixes it at the terminal, the command to run there. The
 * protocol carries only the code, so the text lives here; a code not listed shows as itself.
 * desc is the error card's second line (ui_spec 5.6, the prototype's scene 10); tone is warn for
 * a stop the owner expected or can undo here, error otherwise.
 */
export interface Reason {
  readonly text: string;
  readonly desc?: (provider: string) => string;
  readonly tone?: "warn";
  readonly fix?: (provider: string) => string;
}

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
    desc: (p) => `${p} 暫停使用。若帳單頁的實際花費較低，請在本機終端校正。`,
    fix: (p) => `tars cost adjust ${p} --spent <金額>`,
  },
  daily_cap: {
    text: "今日花費已到上限，明天重算",
    desc: () => "這個回合已自動結束。要提高上限，請在本機的設定檔調整。",
    tone: "warn",
  },
  turn_cap: {
    text: "這個回合的花費已到上限",
    desc: () => "這個回合已自動結束。要提高上限，請在本機的設定檔調整。",
    tone: "warn",
  },
  budget_unreadable: { text: "本機端讀不到用量帳，請更新 tars" },
  request_limit: {
    text: "這個回合的模型請求次數已到上限",
    desc: () => "這個回合已自動停止。請檢視進度，再決定是否繼續。",
    tone: "warn",
  },
  provider_spend_limit: {
    text: "provider 端的花費上限已到",
    desc: (p) => `這個回合已停止。${p} 在下次重算或調高上限前無法使用，其他 provider 不受影響。`,
  },
  auth: {
    text: "provider 拒絕了 API 金鑰",
    desc: (p) => `${p} 回絕這個金鑰。請在本機終端重新設定金鑰。`,
    fix: (p) => `tars llm key set ${p}`,
  },
  bad_request: { text: "provider 拒絕了這個請求" },
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
