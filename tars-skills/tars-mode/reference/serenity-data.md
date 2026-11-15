# 用 `tars market` 取數

三個 Serenity 劇本的資料步驟都照這一頁。FinMind 有的資料用 `tars market`，其餘（財報原文、法說會、公司公告、產業報導）照 serenity-skill 的 `references/market-source-playbook.md` 到網路上找，怎樣算開啟原文見 `serenity-method.md`。FinMind 匿名拿不到的，寫成缺口（見 `serenity-method.md`）。

## 順序

1. `tars market status`：看 `access` 是 `anonymous` 還是 `token`，和 `sync` 過哪些 (資料集, 代號)。匿名夠用，不必叫使用者登入。
2. `tars market sync --id <代號,代號> [--set <組>]`：只同步缺的。要用的 (資料集, 代號) 在 `status` 的 `sync` 清單裡，而且 `synced_at` 是研究日期當天，就視為新的，直接 `show`；沒有，或不是當天同步的，才 `sync`，那就叫過舊。`synced_at` 是 UTC，加 8 小時才是台北日期。同步過但 `rows_returned` 是 0 的也算新的，當天重跑結果不會變。輸出的 `results[].status` 逐項看，不是 `ok` 的照下表處理。
3. `tars market show <檢視> --id <代號>`：印 JSON。引用任何數字之前先看 `as_of`。

整個市場的資料集（`TaiwanStockInfo`、`USStockInfo`）在 `status` 的 `sync` 清單裡，代號是 `*`。這一列照步驟 2 的同一條規則判斷：`synced_at` 是研究日期當天就新的，不是就過舊，重跑 `tars market sync --set info`（美股 `--set us-info`）。請求數是 1，不論有幾檔股票。

一次 `sync` 最多 100 個請求，超過在送出前就被拒絕；分批。每個資料集一個請求。整個市場的組（`info`、`us-info`）不論幾檔都是 1 個；其餘的組每檔股票各送一次，所以請求數是「整個市場的組各 1」加上「股票數 × 每檔組的請求數」：

| `--set` | 資料集 | 請求 |
| --- | --- | --- |
| `info` | `TaiwanStockInfo` | 整個市場 1 |
| `us-info` | `USStockInfo` | 整個市場 1 |
| `fundamentals` | `TaiwanStockMonthRevenue`、`TaiwanStockFinancialStatements` | 每檔 2 |
| `price` | `TaiwanStockPrice`、`TaiwanStockDividendResult` | 每檔 2 |
| `chips` | `TaiwanStockInstitutionalInvestorsBuySell`、`TaiwanStockMarginPurchaseShortSale` | 每檔 2 |
| `us-price` | `USStockPrice` | 每檔 1 |

不帶 `--set` 時，台股用 `info`、`fundamentals`、`chips`、`price`，美股用 `us-price`。`sync` 輸出的 `requests` 是實際送出的數量，`pilot.requests` 照它寫。

## 每個劇本要的資料

| 劇本 | 指令 | 請求數 |
| --- | --- | --- |
| `theme-bottleneck-scan` 的 pilot | `tars market sync --id <代號> --set info,fundamentals,price` | 5：`info` 1，`fundamentals` 2，`price` 2 |
| 同上的候選（台股） | `tars market sync --id <代號,...> --set fundamentals,price` | 每檔 4（`info` 在 pilot 已同步） |
| `company-claim-challenge` | `tars market sync --id <代號>`（預設的四組） | 7；`info` 已同步過時改用 `--set fundamentals,chips,price` 是 6 |
| `cross-market-arena` | `tars market sync --id <代號,...> --set info,fundamentals,price`；美股 `--set us-price,us-info` | 台股 `info` 1 加每檔 4，美股每檔 1 加 `us-info` 1 |

美股只有收盤價與成交量。美股的財報、營收與籌碼不在 FinMind 的匿名資料裡，到財報原文找，查不到寫成缺口；`show monthly_revenue`、`quarterly_financials`、`inst_net`、`margin` 對美股代號以結束碼 2 結束，不要對它執行。

`info` 與 `us-info` 是整個市場的資料集，一個請求給所有股票，不帶 `--id`。它們可以和有 `--id` 的組一起跑（`--id NVDA --set us-price,us-info`），單獨跑時寫 `tars market sync --set us-info`；`--id` 配上只有它們的 `--set` 會被拒絕。

## 看每個檢視

| `tars market show` | 可以用來證明什麼 | 留意 |
| --- | --- | --- |
| `monthly_revenue` | 月營收、月增、年增 | `period` 才是營收月。沒有前期時月增、年增是 `null` |
| `quarterly_financials` | 單季營收、毛利率、營益率、EPS | 每個值都是該季自己的：EPS 當單季的值引用，不年化、不乘四；估值要近四季合計時，才把連續四個已公布季的單季 EPS 相加（取法見 `serenity-method.md`）。毛利率與營益率只引用單季，不相加。最新一季公布前，不會有那一季 |
| `inst_net` | 外資、投信、自營商買賣超，5 日與 20 日合計（張） | `days_in_window20` 小於 20 時，視窗不完整 |
| `margin` | 融資餘額、變動、券資比、融資使用率 | FinMind 沒給券資比，這裡是用餘額算的 |
| `price_raw` | 收盤價與成交量 | **未還原**。跨過 `dividend_events` 的除息日算漲跌幅是錯的；不要自己還原 |
| `dividend_events` | 除權息日與前後參考價 | |
| `stock_info` | 名稱、市場別（`twse`、`tpex`、`emerging`）、產業別 | 備忘錄裡台股的 `name` 取自這裡，要先 `sync` `info` 組；一檔股票可有兩個產業別，用 `/` 連起來 |
| `us_price`、`us_info` | 美股收盤價與成交量；名稱、國別、市值 | `date` 是美東交易日，不和台股日期當成同一天 |

`--limit` 預設是各檢視自己的數量（月營收 24、單季 8、法人 20、股價 60）。看趨勢夠用就不要拉大。

## 寫進備忘錄

一個 `show` 輸出對應一個 `finmind` 來源：

```json
{ "id": "S1", "kind": "finmind", "dataset": "TaiwanStockPrice", "data_id": "2330", "as_of": "2026-10-22", "retrieved_on": "2026-10-26" }
```

- `dataset` 取自輸出 `as_of` 物件的鍵，`as_of` 是那個鍵底下的 `last_date`，`retrieved_on` 是執行 `show` 的台北日期（`TZ=Asia/Taipei date +%F`）。
- 引用其中的數字時，放進 `figures`：營收與財報用 `period`（`2026-09`、`2026Q2`），股價、法人與融資用 `as_of`（那一列的 `date`，不能晚於來源的 `as_of`）。
- 營收單位是元，法人是張，股價是元，成交量是股。`unit` 照實寫。
- FinMind 的最新交易日會落後一到幾天（週末與假日後更多），所以報價的 `as_of` 是資料裡的最新一列，不是今天。

## 結果與結束碼

| 結果 | 做法 |
| --- | --- |
| `sync` 結束碼 0 | 往下 |
| `status: forbidden` 或結束碼 5 | 這個資料集匿名拿不到。寫成缺口（`not_accessible`），其餘照做。使用者想補時，才請他執行 `tars market login` |
| `status: unknown_id` | 代號不在 `TaiwanStockInfo`。回頭問使用者代號有沒有打錯，不要編資料 |
| `status: empty` | 這個區間沒有資料。寫成缺口（`not_found_in_sources_checked`） |
| `status: unmapped` | 有 token 讀到了一個沒有表的資料集，沒有存。告訴使用者它的欄位名稱，不要引用 |
| `show` 結束碼 5 | 還沒 `sync` 這個資料集；照訊息裡的指令同步 |
| `tars market` 結束碼 4 | 連不上或逾時，已完成的部分保留。稍後重跑一次；再失敗，把缺的資料寫成缺口。`tars ingest` 的結束碼 4 是另一回事，見 `serenity-method.md` 的「什麼算開啟原文」 |
| 結束碼 6 | token 無效。告訴使用者執行 `tars market login`；或加 `--anonymous` 只用匿名資料 |
| 結束碼 7 | 另一個 `tars market` 正在寫 `market.db`，等一下再試 |
| 結束碼 2 | 參數錯誤，照訊息改 |

重跑 `sync` 取代同樣的列，結果相同，但每次都花同樣的請求數。當天同步過的（步驟 2 的判準）直接 `show`，不要再同步。沒有重新同步時，pilot 的 `requests` 寫 0，`note` 寫資料是哪一天同步的。
