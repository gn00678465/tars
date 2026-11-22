/**
 * What the local end's reason codes mean (src/features/agent/request.ts REASON_TEXT, worded for
 * this page) and, where the owner fixes it at the terminal, the command to run there. The
 * protocol carries only the code, so the text lives here; a code not listed shows as itself.
 */
export const REASONS: Record<string, { text: string; fix?: (provider: string) => string }> = {
  aborted: { text: "已取消" },
  config_invalid: { text: "本機的 config.toml 有問題，請在終端檢查" },
  catalog_invalid: { text: "本機的 models.json 有問題，請在終端檢查" },
  boot_failed: { text: "本機端讀不到 SOUL.md 或 MEMORY.md" },
  provider_disabled: { text: "這家 provider 沒有啟用" },
  no_key: { text: "這家 provider 沒有 API 金鑰", fix: (p) => `tars llm key set ${p}` },
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
    fix: (p) => `tars models confirm-prices --provider ${p}`,
  },
  conv_too_long: { text: "對話太長，超過硬停線。請開新對話" },
  // Continuing in another model: the local end's CARRY_TEXT, with the page's controls for it.
  carry_summary_too_long: {
    text: "前一個對話的摘要太長，帶不進這個模型。把帶入範圍改成「最後幾個回合」，或選視窗較大的模型",
  },
  carry_turn_too_long: {
    text: "最近一個回合就超過這個模型能帶入的長度，縮小帶入範圍也帶不進去。選視窗較大的模型，或開新對話",
  },
  carry_over_stop: {
    text: "這則訊息加上帶入的內容太長。縮短訊息，或把帶入範圍改成更少的回合",
  },
  budget_stopped: { text: "本期花費已到停用門檻" },
  daily_cap: { text: "今日花費已到上限，明天重算" },
  turn_cap: { text: "這個回合的花費已到上限" },
  budget_unreadable: { text: "本機端讀不到用量帳，請更新 tars" },
  request_limit: { text: "這個回合的模型請求次數已到上限" },
  provider_spend_limit: { text: "provider 端的花費上限已到" },
  auth: { text: "provider 拒絕了 API 金鑰", fix: (p) => `tars llm key set ${p}` },
  bad_request: { text: "provider 拒絕了這個請求" },
  provider_error: { text: "provider 暫時無法回應，重試用完了，請稍後再試" },
  stream_interrupted: { text: "回應中途斷線" },
  compact_too_large: { text: "要壓縮的內容太大" },
  compact_truncated: { text: "摘要超過輸出上限" },
  compact_bad_summary: { text: "摘要的格式不對" },
};

export const reasonText = (code: string) => REASONS[code]?.text ?? code;
