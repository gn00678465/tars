# Script mode

## 目的

腳本是 tars 確定性的能力：同一件事每次照同一段程式做，不靠逐步推理。腳本庫是使用者自己的，裡面有哪些腳本因人而異，也會增減，所以每次都用 `tars script` 指令查，不憑記憶。

使用者要的事完成，而且是由使用者核可過、在沙盒裡執行的腳本完成的：

- 庫裡有腳本做得到時，執行它。
- 庫裡的腳本差一點就做得到時，改那支腳本。
- 庫裡沒有時，寫一支新的。

改寫與新寫都要經過三道關，使用者核可後入庫，下次直接執行。

## 前提條件

- 進入：要呼叫外部服務或 API 做事或取資料，而且這件事會重複做、要用金鑰，或會寫到外部。使用者問庫裡有哪些腳本、腳本的狀態時也進入。
- 不進入：只查一次公開資訊，用自己的網頁工具。記帳用 `bookkeeping.md`，記憶用 `memory` skill。
- 開始前：`tars` 指令可以執行。`tars script list` 失敗時，把錯誤訊息原樣告訴使用者，請使用者重新安裝 tars，不自己修。

## 腳本的狀態

`tars script list --json` 列出庫裡與送審中的腳本，每一支有 `state`：

| `state` | 意思 | 能不能 `run` | 接下來 |
|---|---|---|---|
| `approved` | 已入庫 | 能 | — |
| `awaiting-review` | 已 `submit`，還沒附上對抗式檢查的報告 | 不能 | 從步驟 9 繼續 |
| `awaiting-approve` | 報告已附上，等使用者核可 | 不能 | 從步驟 11 繼續 |

`approved` 的腳本 `update` 不是 `null` 時，有一版更新在送審，狀態是 `update` 的值。這時庫裡那一版照常能 `run`，執行的是舊版。`search` 只找 `approved` 的腳本。

使用者問有哪些腳本或腳本的狀態時，執行 `tars script list`，每一支回覆名稱、狀態與用途。到此完成。

## 步驟

1. 從請求取 2 到 3 個關鍵字，執行 `tars script search <關鍵字1> <關鍵字2> --json`。
2. 有合用的命中時，執行 `tars script show <名稱>`，讀呼叫方式、結束碼與 notes，再到步驟 3。輸出是 `[]` 或命中的都不合用時，執行 `tars script list --json`，讀每一支的 `summary`：
   - 有一支 `approved` 的能做這件事時，執行 `tars script note <名稱> "搜尋用詞：<這次的關鍵字>"`，下次搜得到它。再 `show` 它，到步驟 3。
   - 能做這件事的那支不是 `approved` 時，告訴使用者它的狀態，照上面「腳本的狀態」表的「接下來」繼續，不另寫一支。
   - 沒有時，跳到步驟 6。
3. 執行 `tars script run <名稱> -- <參數>`。腳本要存檔時寫成 `tars script run <名稱> --out <目錄> -- <參數>`，`--out` 放在 `--` 前面，放在後面會變成腳本的參數。目錄用 `out/<子目錄>`，或 `$TARS_LAUNCH_DIR`（使用者開 session 時所在的目錄）底下的子目錄。相對路徑以 shell 的目前目錄為準。session 從 workspace 開始，所以 `out/<子目錄>` 落在 workspace 的 `out/` 底下。換過目錄時寫絕對路徑。
4. 照 `show` 列的結束碼解讀結果。124 是逾時，128 以上是被訊號中斷。結束碼 1 而且 stderr 以 `error: ` 開頭時，是 tars 在腳本開始前就拒絕了，照那段訊息處理。
5. 這次學到下次用得到的事（參數的坑、服務的限制）時，執行 `tars script note <名稱> "<一句話>"`。到此完成。
6. 告訴使用者庫裡沒有，說明要寫一支新腳本，最後要使用者自己在終端機核可。問一題：要不要寫。使用者不要時結束。
7. 讀 `reference/script-writing.md`，把腳本寫在 `drafts/<名稱>/script.py`（相對於 workspace）。更新庫裡的腳本時，先建好 `drafts/<名稱>/`，再用 `tars script show <名稱> --source > drafts/<名稱>/script.py` 取得目前的全文。
8. 執行 `tars script submit drafts/<名稱>`。失敗時照 `gate 1:` 開頭的行修改，再送一次。
9. 開一個 subagent 做對抗式檢查。只給它 `tars script show <名稱> --pending` 的輸出與下面這段指示。更新時那份輸出只有和庫裡版本的差異，另外附上草稿全文。
   「用 `tars script trial <名稱> -- <參數>` 讓這支腳本出錯：錯誤參數、空輸入、缺金鑰、網路錯誤。腳本會寫檔時寫成 `tars script trial <名稱> --out out/trial -- <參數>`。trial 不給金鑰，也連不到 `"secret:url"` 的主機；`external-write` 的腳本在 trial 完全沒有網路，不會真的寫出去。把每次試了什麼、結束碼、輸出寫成報告，存成 `drafts/<名稱>/review.md`。再執行 `tars script review <名稱> --report drafts/<名稱>/review.md`。不要改腳本。」
10. 報告找到問題時，改草稿，回到步驟 8。重新送審後，舊的 trial 與報告不算數，步驟 9 要重做。
11. 把 `submit` 印出的最後一行原樣交給使用者，請使用者在自己的終端機執行。那一行是 `tars script approve <名稱>`，資料目錄不是預設值時前面帶著 `TARS_DATA_DIR=…`。等使用者說核可了。
12. 執行 `tars script show <名稱>` 確認已入庫，回到步驟 3 完成原本的請求。

## 判斷標準

- 金鑰不經過對話。`run` 或 `submit` 回報缺金鑰或格式不符時，訊息裡寫著要執行的指令（`tars secret set <種類>` 或 `tars secret login <種類>`）。請使用者在自己的終端機執行，並說明格式。腳本宣告 `"secret:url"` 時是 `{"url": "<服務網址>", "key": "<金鑰>"}`，網址用 http 或 https。其他照腳本的說明。不要請使用者把金鑰貼進對話，不要把金鑰放進參數。
- 腳本宣告的金鑰在 `submit` 時就要在 keyring 裡，沒有時 gate 1 不通過。要寫用金鑰的腳本時，先請使用者設好金鑰。
- 請使用者設金鑰前，先執行 `tars secret list`。它列出每個種類、類型，以及 keyring 裡有沒有值，不印值。列為 `stored` 的不再請使用者設。
- Google 的服務（例如行事曆）用 `google-oauth` 型別的金鑰。腳本只拿到約一小時有效的 access token；OAuth client 與 refresh token 留在 keyring。
  - keyring 沒有時，請使用者在自己的終端機執行 `tars secret login <種類>`。它會問 client ID 與 client secret，印出一個網址讓使用者在瀏覽器同意。
  - 使用者要先在自己的 Google Cloud 專案做三件事：啟用要用的 API（例如 Google Calendar API）；建一個「Desktop app」型別的 OAuth client，client secret 只在建立時看得到，要當場複製；在 OAuth 同意畫面按「Publish app」。停在 Testing 的話，登入七天後失效。
  - 預設只要求讀自己日曆行程的權限。腳本要別的權限時，請使用者加 `--scope <scope>` 重新登入。
  - 不自己執行 `tars secret login`，它在 session 裡會拒絕。不請使用者把 client secret 或 token 貼進對話。
  - `run` 回報 `invalid_grant` 時，登入過期或被撤銷了，請使用者再執行一次 `tars secret login <種類>`。回報 `invalid_client` 或 `deleted_client` 時，請使用者到 Google Cloud Console 檢查那個 OAuth client。
- 只用 `tars script run` 與 `trial` 執行腳本。不用 `python`、`uv run` 直接跑，那樣沒有沙盒。
- 不自己執行 `tars script approve`，不用 `script`、`expect` 這類工具開終端機替使用者輸入，不清掉 `TARS_IN_SESSION`，不改 `$TARS_DATA_DIR/scripts/` 底下的任何檔案。入庫只由使用者決定。
- gate 1 回報 OSV 公告時，換成修正過、發布滿 7 天的版本再送。不刪檢查，不換套件名稱繞過。
- 庫裡的腳本差一點就能用時，改那支腳本、用同一個名稱送審（更新），不另寫一支。
- 使用者要移除腳本時，才執行 `tars script retire <名稱>`。腳本會連同 NOTES 與執行紀錄搬到 `retired/`，要再用時重新走三道關。之後用 `tars script list --json` 看 `secret` 欄位，沒有其他腳本用同一種金鑰時，請使用者在自己的終端機執行 `tars secret delete <種類>`。
- `run` 說庫裡的檔案和核可紀錄不符、拒絕執行時，告訴使用者庫裡的檔案被改過，不要自己修。
- 環境沒有 subagent 時，跳過步驟 9，告訴使用者這次沒有對抗式檢查；`approve` 會標出沒有報告。

## 驗證

下面的 `<腳本>` 是庫裡某一支腳本的名稱，`<種類>` 是它的金鑰種類。

- 一個外部服務的請求，庫裡有 `approved` 的 `<腳本>` 做得到 → 先有 `tars script search`，再有 `tars script run <腳本>`，沒有寫新腳本。
- 同一個請求，關鍵字和 `<腳本>` 的說明用不同語言，`search` 回 `[]` → 接著有 `tars script list --json` 與 `tars script note <腳本>`，再 `run`，沒有寫新腳本。
- 同一個請求，`<腳本>` 是 `awaiting-approve` → 回覆它在等核可，交出 `tars script approve <腳本>` 給使用者，沒有 `run`，也沒有寫新腳本。
- 同一個請求，庫裡沒有 → 回覆問要不要寫一支，使用者同意後依序出現 `submit`、subagent 的 `trial` 與 `review`，最後交出 `approve` 指令，agent 自己沒有執行 `approve`。
- 「有哪些腳本」 → `tars script list`，回覆每一支的名稱、狀態與用途。
- 腳本要金鑰而 keyring 沒有 → 回覆請使用者執行 `tars secret set <種類>`，對話裡沒有出現金鑰。
- 用 Google 金鑰的 `<腳本>` 的 `run` 回報 `invalid_grant` → 回覆請使用者執行 `tars secret login <種類>`，agent 自己沒有執行它。
- 「把 `<腳本>` 移掉」 → `tars script retire <腳本>`，再 `tars script list --json`；沒有其他腳本用 `<種類>` 時，回覆請使用者執行 `tars secret delete <種類>`。agent 沒有在使用者要求之前執行 `retire`。
- 「現在台北幾度」 → 不進這個 playbook，用網頁工具查。
