# tars

給在這個 repo 寫程式的 agent 讀。只寫看程式碼看不出來的事。TypeScript 與 Bun 的慣例在 `ts-bun-conventions` skill。

## 指令

- 安裝：`bun install --frozen-lockfile`。新套件要擁有者核可，不自己 `bun add`。
- 交出改動前：`bun run check`，全部通過才交給審查。

## 兩種 skill

- `tars-skills/`：tars 用的 skill，安裝 tars 時複製進使用者的資料目錄。
  - `upstream.json` 列出從外部複製的 skill。那些檔案和上游保持一致，不在這裡改。
- `.agents/skills/`、`.claude/skills/`：開發用的 skill，不隨 tars 安裝。
  - 外部的用 `npx skills@1.7.6 add <url> --skill <名稱> -a claude-code -a codex --copy -y` 安裝，來源鎖在 `skills-lock.json`。不手改。
  - 自己寫的正本在 `.agents/skills/`。改完用 `npx skills@1.7.6 add ./.agents/skills/<名稱> -a claude-code --copy -y` 同步到 `.claude/skills/`。
  - 執行 `npx` 時設 `npm_config_ignore_scripts=true`、`npm_config_min_release_age=7`、`DISABLE_TELEMETRY=1`。

## 約束

- repo 公開。網址、帳號、本機路徑寫成佔位符，實際的值從環境變數注入。
- 測試不連真的外部服務，不讀真的 HOME 與 keyring。

## 這份檔案

- 上限 8 KB。新增內容要擁有者同意。
- 同一個坑踩第二次才寫進來。
