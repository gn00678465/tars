# Script

## 目的

使用者要的外部動作（推播、下載、呼叫某個 API）完成，而且是由使用者核可過、在沙盒裡執行的腳本完成的。

## 前提條件

- 進入：要對外部服務做事或取資料，而且這件事會重複做、要用金鑰，或會寫到外部。例如「推播一則通知」「把這個網址的檔案存下來」。
- 不進入：只查一次公開資訊，用自己的網頁工具。記帳用 `bookkeeping.md`，記憶用 `memory` skill。
- 開始前：`tars` 指令可以執行。`tars script list` 失敗時，把錯誤訊息原樣告訴使用者，請使用者重新安裝 tars，不自己修。

## 步驟

1. 從請求取 2 到 3 個關鍵字，執行 `tars script search <關鍵字1> <關鍵字2> --json`。
2. 有命中時，執行 `tars script show <名稱>`，讀呼叫方式、結束碼與 notes，再到步驟 3。輸出是 `[]` 時，跳到步驟 6。
3. 執行 `tars script run <名稱> -- <參數>`。腳本要存檔時加 `--out <目錄>`。目錄用 `out/<子目錄>`，或 `$TARS_LAUNCH_DIR`（使用者開 session 時所在的目錄）底下的子目錄。相對路徑以 shell 的目前目錄為準。session 從 workspace 開始，所以 `out/<子目錄>` 落在 workspace 的 `out/` 底下。換過目錄時寫絕對路徑。
4. 照 `show` 列的結束碼解讀結果。124 是逾時，128 以上是被訊號中斷。結束碼 1 而且 stderr 是一行 `error: …` 時，是 tars 在腳本開始前就拒絕了，照那行訊息處理。
5. 這次學到下次用得到的事（參數的坑、服務的限制）時，執行 `tars script note <名稱> "<一句話>"`。到此完成。
6. 告訴使用者庫裡沒有，說明要寫一支新腳本，最後要使用者自己在終端機核可。問一題：要不要寫。使用者不要時結束。
7. 讀 `reference/script-writing.md`，把腳本寫在 `drafts/<名稱>/script.py`（相對於 workspace）。更新庫裡的腳本時，先建好 `drafts/<名稱>/`，再用 `tars script show <名稱> --source > drafts/<名稱>/script.py` 取得目前的全文。
8. 執行 `tars script submit drafts/<名稱>`。失敗時照 `gate 1:` 開頭的行修改，再送一次。
9. 開一個 subagent 做對抗式檢查。只給它 `tars script show <名稱> --pending` 的輸出與下面這段指示。更新時那份輸出只有和庫裡版本的差異，另外附上草稿全文。
   「用 `tars script trial <名稱> -- <參數>` 讓這支腳本出錯：錯誤參數、空輸入、缺金鑰、網路錯誤。腳本會寫檔時加 `--out out/trial`。trial 不給金鑰，也連不到 `"secret:url"` 的主機；`external-write` 的腳本在 trial 完全沒有網路，不會真的寫出去。把每次試了什麼、結束碼、輸出寫成報告，存成 `drafts/<名稱>/review.md`。再執行 `tars script review <名稱> --report drafts/<名稱>/review.md`。不要改腳本。」
10. 報告找到問題時，改草稿，回到步驟 8。重新送審後，舊的 trial 與報告不算數，步驟 9 要重做。
11. 把 `submit` 印出的最後一行原樣交給使用者，請使用者在自己的終端機執行。那一行是 `tars script approve <名稱>`，資料目錄不是預設值時前面帶著 `TARS_DATA_DIR=…`。等使用者說核可了。
12. 執行 `tars script show <名稱>` 確認已入庫，回到步驟 3 完成原本的請求。

## 判斷標準

- 金鑰不經過對話。`run` 或 `submit` 回報缺金鑰或格式不符時，請使用者在自己的終端機執行 `tars secret set <種類>`，並說明格式。腳本宣告 `"secret:url"` 時是 `{"url": "<服務網址>", "key": "<金鑰>"}`，網址用 http 或 https。其他照腳本的說明。不要請使用者把金鑰貼進對話，不要把金鑰放進參數。
- 腳本宣告的金鑰在 `submit` 時就要在 keyring 裡，沒有時 gate 1 不通過。要寫用金鑰的腳本時，先請使用者設好金鑰。
- 要 Google 登入（`google-oauth` 型別的金鑰）的服務，tars 還不能交給腳本，gate 1 會拒絕。告訴使用者這件事，不寫這種腳本。
- 只用 `tars script run` 與 `trial` 執行腳本。不用 `python`、`uv run` 直接跑，那樣沒有沙盒。
- 不自己執行 `tars script approve`，不用 `script`、`expect` 這類工具開終端機替使用者輸入，不清掉 `TARS_IN_SESSION`，不改 `$TARS_DATA_DIR/scripts/` 底下的任何檔案。入庫只由使用者決定。
- gate 1 回報 OSV 公告時，換成修正過、發布滿 7 天的版本再送。不刪檢查，不換套件名稱繞過。
- 庫裡的腳本差一點就能用時，改那支腳本、用同一個名稱送審（更新），不另寫一支。
- `run` 說庫裡的檔案和核可紀錄不符、拒絕執行時，告訴使用者庫裡的檔案被改過，不要自己修。
- 環境沒有 subagent 時，跳過步驟 9，告訴使用者這次沒有對抗式檢查；`approve` 會標出沒有報告。

## 驗證

- 「推播一則通知說會議改到三點」，庫裡有 `bark-push` → 先有 `tars script search`，再有 `tars script run bark-push`，沒有寫新腳本。
- 同一個請求，庫裡沒有 → 回覆問要不要寫一支，使用者同意後依序出現 `submit`、subagent 的 `trial` 與 `review`，最後交出 `approve` 指令，agent 自己沒有執行 `approve`。
- 腳本要金鑰而 keyring 沒有 → 回覆請使用者執行 `tars secret set <種類>`，對話裡沒有出現金鑰。
- 「現在台北幾度」 → 不進這個 playbook，用網頁工具查。
