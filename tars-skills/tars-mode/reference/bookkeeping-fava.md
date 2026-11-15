# 記帳：核准與排除問題

`playbooks/bookkeeping.md` 要說明核准、查已用的標籤，或使用者說 Fava 網頁上看不到交易時讀這個檔。

## 核准的做法

agent 不能核准。fava 的 approve 端點只由 tars daemon 呼叫，而且只在使用者在花費頁按下核准時呼叫。agent 只告訴使用者怎麼核准。

主要做法是在 tars 網頁的花費頁核准：

1. 開網頁的「紀錄」，選「花費」分頁，再選交易的日期。
2. 按那筆交易的「核准」。同一天有兩筆以上待核准時，也可以按「核准這天的待核准 N 筆」。
3. 核對確認區的筆數與合計，按「確認核准 N 筆」。

網頁不能取消核准，也不能修改或刪除交易。這三件事都在 Fava 做。

另一種做法是在 Fava 編輯器改。使用者從自己的 fava 網頁開 fava（網址由環境變數 `BEANCOUNT_FAVA_WEB_URL` 提供，下文寫成 `<BEANCOUNT_FAVA_WEB_URL>`；瀏覽器直接開 `BEANCOUNT_FAVA_URL` 會得到 401），在「編輯器」選 `txns/<年份>.beancount`，搜尋 `ik-<key 的開頭>`，找到交易後：

- 把 `!` 改成 `*`。
- `^ik-...` 保持原樣。它用來防止同一筆交易重複寫入。

## 對帳註記

- AgentApi 接受 `payee`、`tags`、`meta`。註記在寫入時一起送出，使用者核准時只改 `!`。欄位格式以 `beancount-ledger` 為準。
- 已經使用的標籤：`#reimburse`（還代墊），送出時寫成 `"tags": ["reimburse"]`。標籤只能用英數字與 `- _ / .`，中文放在 `meta`，例如 `{"note": "還代墊"}`。

## Fava 網頁上看不到新交易

1. 用 `query` 確認帳本裡有這筆交易。查不到時，照 `beancount-ledger` 讀回應的規則處理。
2. 查得到時，是瀏覽器快取了舊資料。Cloudflare 已經設定不快取 `<BEANCOUNT_FAVA_WEB_URL>` 的網域（2026-09-30），但 Chrome 可能還留著舊的回應。請使用者在 Chrome 的「清除瀏覽資料」只勾「快取圖片和檔案」再清除。「網站設定 > 刪除資料」清不掉這種快取。
