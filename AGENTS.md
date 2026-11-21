# tars

給在這個 repo 寫程式的 agent 讀。只寫看程式碼看不出來的事。TypeScript 與 Bun 的慣例在 `ts-bun-conventions` skill。

## 指令

- 安裝：`bun install --frozen-lockfile`。新套件要擁有者核可，不自己 `bun add`。
- 交出改動前：`bun run check`，全部通過才交給審查。
- `bun run check` 另外需要 Node（`apps/web` 的 Vite+）。

## tars 的請求怎麼走

```
tars install ─ 複製 tars-skills/ 的每個 skill（外部的列在 upstream.json）
   │
   └ tars-mode（自建）
       └ 路由表 ── 去處是 playbook 或 skill
            ├ 流程 playbook ── 載入其他 skill（記帳、學習、投資）
            ├ memory skill ── 用 tars memory 指令
            └ script-mode.md ── 用 tars script / tars secret 指令
                              └ search 找到庫裡的腳本（使用者核可、不隨安裝）
```

`tars chat` 是自建迴圈，工具只有 `skill_load`、`file_read` 與白名單內的 `tars` 子指令。白名單在 `src/features/agent/tars-tool.ts`；CLI 加新的子指令或選項時不會自動放行。白名單含 `wiki` 的五個唯讀子指令（`search`、`list`、`show`、`source`、`status`）；`wiki sync` 會寫入，只在擁有者自己的終端執行，不進白名單。

遠端入口：`src/features/serve/` 是本機端，`apps/web/` 是網頁與 Worker，`packages/protocol/` 是兩邊共用的訊息定義。改訊息時三處一起改。

## 新增 playbook、skill、腳本

| 要加的 | 放哪裡 | 怎麼接上 | 邊界 |
|---|---|---|---|
| playbook | `tars-skills/tars-mode/playbooks/<名稱>.md`，照 `reference/playbook-template.md` 寫 | 在 tars-mode 的路由表加一列。不帶「hey tars」也要進來時，description 加上請求的字詞 | tars 處理一類請求的流程。自己沒有觸發條件，只從路由表進入 |
| 使用者的 playbook | 不進 repo。agent 在使用者的 tars session 寫到 `$TARS_DATA_DIR/playbooks/` | 不改路由表。路由表沒命中時，tars-mode 用 `tars script search` 依開頭的 `summary` 找到它 | 配合使用者腳本的流程。`tars install` 不碰它 |
| skill | `tars-skills/<名稱>/SKILL.md`。外部的照原樣複製，記進 `upstream.json` | `scripts/build.ts` 打包整個 `tars-skills/`，不用另外登記。要從 tars-mode 進入時，路由表加一列 | 有自己的 description，能單獨觸發，也能被 playbook 載入。用到 tars 指令時，用法寫在這個 skill |
| 腳本 | 不進 repo。使用者在 tars session 請 agent 寫，走 `script-mode.md` 三道關入庫。`examples/scripts/` 只是範本 | 不改路由表與 `script-mode.md`，playbook 不點名個別腳本。agent 執行時用 `tars script search` 與 `list` 找 | 對外部服務做事或取資料，而且會重複做、要用金鑰或會寫到外部。只在沙盒跑，入庫只由使用者核可 |

同一個功能在不同使用者或流程裡重複出現時，才抽成共用腳本，或移進 tars CLI。

tars 指令在 `src/features/<名稱>/`。用法寫在使用它的 skill 或 playbook，指令改了同一個 PR 一起改。

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
