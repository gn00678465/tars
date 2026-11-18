---
name: tars-mode
description: 使用者的訊息以「hey tars」或「tars」開頭時使用，依後面的內容選一個 playbook 或 skill 執行。也用於呼叫外部服務或 API 做事或取資料、會重複做或要用金鑰的事，以及問 tars 有哪些腳本；記帳、查帳、排讀書計畫或備考、檢查學習進度、問學習方法、把模糊想法整理成可執行計畫、覆盤一天的工作、做決策前先列風險、研究科技題材的供應鏈瓶頸與個股。只查事實時不用。
---

# TARS mode

語氣、邊界與 `[吐槽]` 規則來自 session 開始帶進來的 `<soul>` 區塊。這個 skill 只負責把請求交給對的流程。

## 步驟

1. 去掉開頭的「hey tars」或「tars」與後面的標點，剩下的文字是請求。
2. 在路由表找出請求的主要目的，只選一列。一則訊息有兩件不相關的事時，照訊息順序各跑一列。
3. 去處是 playbook 時，讀那個檔案，照它的步驟做完。去處是 skill 時，載入那個 skill，照它做。
4. playbook 可以組合：一個 playbook 的步驟寫「照 `<另一個>.md`」時，讀那個檔案，做完它的步驟再回來繼續。
5. 路由表沒有符合的列時，從請求取 2 到 3 個關鍵字，執行 `tars script search <關鍵字1> <關鍵字2> --json`。有 `kind` 是 `playbook` 而且合用的，讀它的 `path`，照它的步驟做完；它引用的檔案相對於那個檔案所在的目錄。沒有時，照一般請求處理。

完成條件：請求交給一個去處，而且那個去處的最後一步已經做完。

## 路由表

| 請求在講 | 去處 |
|---|---|
| 支出、收入、轉帳、代墊、帳戶餘額、查帳 | `playbooks/bookkeeping.md` |
| 排讀書計畫、準備考試、檢查學習進度、教我學會某個主題或技能、考我、練到熟 | `playbooks/learn.md` |
| 怎麼讀、怎麼記、讀了就忘、學習方法有沒有用或為什麼有效 | `learning-how-to-learn` skill |
| 模糊想法要整理成計畫、覆盤一天的工作、做決策 | `playbooks/coach.md` |
| 探索科技題材的供應鏈瓶頸、找台股與美股的卡點、篩選受惠股 | `playbooks/theme-bottleneck-scan.md` |
| 挑戰單一公司是不是蹭熱點、核實某概念股是不是核心供應商 | `playbooks/company-claim-challenge.md` |
| 比較 2 到 5 檔台股或美股同業，誰的邏輯更硬、誰更值得優先研究 | `playbooks/cross-market-arena.md` |
| 呼叫外部服務或 API 做事或取資料，而且會重複做、要用金鑰或會寫到外部；問庫裡有哪些腳本、腳本的狀態 | `playbooks/script-mode.md` |
| 「記住」「忘掉」「我之前說過什麼」 | `memory` skill |

playbook 的路徑相對於這個 skill 的目錄。在 Claude Code 裡，tars 的 skill 名稱帶 `tars:` 前綴，例如 `memory` skill 是 `tars:memory`。

## 新增 playbook

照 `reference/playbook-template.md` 的骨架寫。

- tars 本身的流程：存到 `playbooks/`，再在路由表加一列。
- 配合使用者腳本的流程：存到 `$TARS_DATA_DIR/playbooks/<名稱>.md`，輔助檔放 `$TARS_DATA_DIR/playbooks/<名稱>/`。不加路由表，從步驟 5 的 `tars script search` 進入。檔案開頭寫 `---`、`summary: <一行，寫出會用到它的請求字詞>`、`---` 三行；search 只比對檔名與 `summary`。不寫死腳本名稱，用 `tars script search` 找。
