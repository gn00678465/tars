---
name: ts-bun-conventions
description: tars 這個 repo 寫 TypeScript 與 Bun 程式時的慣例：用哪些工具與 Bun 內建功能、tsconfig、打包、供應鏈檢查、CLI 的輸出與結束碼、私人資訊。在這個 repo 新增或修改程式、加套件、寫 CLI 指令、設定建置或檢查時使用。
---

# TypeScript 與 Bun 的慣例

這份只寫這個 repo 自己的決定。一般的 TypeScript 寫法交給模型本身與 `typescript-magician`，CLI 的設計原則交給 `cli-for-agents`。

## 工具

| 用途 | 用什麼 |
|---|---|
| 參數解析與子命令 | `commander` |
| 資料驗證 | `zod`，在外部輸入進來的邊界驗證一次 |
| lint | `oxlint` |
| 格式化 | `oxfmt` |
| 型別檢查 | TypeScript 7 的 `tsc --noEmit`，加 `@types/bun` |
| 測試 | `bun test` |
| SQLite | `bun:sqlite` |
| keyring | `Bun.secrets` |
| 子程式與 shell | `Bun.spawn`、`Bun.$` |

- Bun 內建做得到的，不加套件。
- 要加上表以外的套件時，先停下來問擁有者。新套件第一次出現要擁有者核可。

## tsconfig

- TypeScript 7 的 `types` 預設是空陣列。要寫 `"types": ["bun"]`，`tsc` 才認得 `bun:sqlite` 與 `Bun.*`。
- 開 `strict`。

## 打包

- 用 `bun build --compile` 打包成單一執行檔。
- 一定加 `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`。不加時，執行檔會讀使用者當下目錄的 `.env` 與 `bunfig.toml`。

## 供應鏈

- 安裝一律用 `bun install --frozen-lockfile`。`bun.lock` 記每個套件的雜湊，被竄改時安裝會失敗。
- `bunfig.toml` 的 `[install] minimumReleaseAge = 604800`：發布不滿 7 天的版本不用。
- `package.json` 寫 `"trustedDependencies": []`：不讓任何套件在安裝時執行程式。
- 漏洞與惡意套件用 OSV-Scanner 掃；套件簽章與來源證明用 `npm audit signatures` 查。

## CLI 的輸出與結束碼

以下參考 Liran Tal 的 [Node.js CLI Apps Best Practices](https://github.com/lirantal/nodejs-cli-apps-best-practices)（CC-BY-SA-4.0）第 1.4、1.8、3.6、6.4 節，用自己的話改寫。

- 指令的結果寫到 stdout。進度、警告、除錯訊息、提問與錯誤寫到 stderr。這樣 `tars <指令> --json | jq` 不會被雜訊弄壞。
- 每次結束都給明確的結束碼：0 成功，1 一般失敗，2 參數用錯。其他結束碼要寫進該指令的說明。
- commander 遇到參數用錯時預設以 1 結束。用 `exitOverride()` 接住，改成 2。
- 設了 `NO_COLOR`，或輸出不是終端機時，不輸出顏色碼。
- 收到 `SIGINT`、`SIGTERM` 時，收掉子程式與暫存檔再結束。

## 私人資訊

- repo 會公開。網址、帳號、本機路徑這類值寫成佔位符，例如 `<BEANCOUNT_FAVA_WEB_URL>`，實際的值從環境變數或其他方式注入。
- 金鑰只放在 keyring。輸出、日誌與錯誤訊息都不出現金鑰。

## 交出改動之前

依序跑完，全部通過才交給審查：

1. `oxfmt --check`
2. `oxlint`
3. `tsc --noEmit`
4. `bun test`
5. `gitleaks dir .`
6. `osv-scanner scan source -L bun.lock`：查 OSV 線上資料庫，連不上時以 127 結束，check 不通過。只掃 `bun.lock`，測試用的鎖檔不掃
