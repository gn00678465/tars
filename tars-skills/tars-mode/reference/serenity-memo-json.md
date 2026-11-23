# 劇本輸出的文字報告

三個 Serenity 劇本各在對話裡輸出一份文字報告：`theme-scan`、`claim-challenge`、`arena`。報告不寫檔，沒有 `memo-check` 也沒有 `memo-render`。這一頁是報告的欄位與順序，欄位名沿用原本的備忘錄格式，方便之後改回檔案或表格。規則的理由在 `serenity-method.md`，取數在 `serenity-data.md`。

退化：原本由程式檢查的規則，現在只寫在這裡，靠你遵守。交出前照最後一節「交出前自查」逐項對一次。

## 報告的寫法

- Markdown。每個欄位一個小標題或一行「欄位：內容」，照下面表格的順序，不跳過必填的欄位，沒有內容的選填欄位省略。
- 一筆證據一行：`- [<等級>] <陳述>（<來源 id>）`，有數字時接在後面，有 `does_not_establish` 時寫「不能證明：…」，缺口寫「缺口 <種類>：<原因>；查過 <來源 id>」。
- 數字照 `serenity-method.md` 的寫法：「<指標> <值> <單位>（<期間或日期>，<來源 id>）」。
- 報告最後是 `sources`，再一行寫原文目錄 `out/<研究名稱>/`。
- 不給買賣價位、部位大小、報酬預測，也不寫目標價。

## 每一種都有的欄位

| 欄位 | 內容 |
| --- | --- |
| `kind` | `theme-scan`、`claim-challenge` 或 `arena` |
| `title`、`question` | 標題；這份報告要回答的問題 |
| `researched_on` | 研究日期 `yyyy-mm-dd`，不能晚於今天（台北） |
| `scope.markets` | `TW`、`US` 或兩個都有。每檔股票的 `market` 要在這裡 |
| `counterargument` | `argument`：最有力的反對。可選 `alternatives`：每項一段文字加市場（`TW`、`US`、`CN`、`HK`、`OTHER`）；A 股與港股只能出現在這裡 |
| `next_checks` | 每項寫 `check`（查什麼）、`target`（去哪裡查）、`would_change`（結果會讓判斷怎麼變） |
| `sources` | 來源清單，1 到 60 個，見下 |

`kind`、`title`、`question`、`researched_on`、`scope.markets` 寫在報告開頭；各類型自己的欄位接在後面；`counterargument`、`next_checks`、`sources` 放最後。

## 來源

- FinMind：`id`、`kind: finmind`、`dataset`、`data_id`、`as_of`、`retrieved_on`。
- 其他：`id`、`kind`、`title`、`publisher`、`url`、`published_on`、`retrieved_on`。`kind` 是 `filing`、`transcript`、`company_site`、`media`、`social`、`other`。`filing` 與 `transcript` 另要 `locator`（第幾頁、哪一節），其他種類可寫。要說明的事（例如 EDGAR 沒有確認、網域沒有第二個來源）寫在 `locator`。`kind` 怎麼選，公司自己做的文件見 `serenity-method.md` 的「公司自己做的文件算哪一種」。`url` 是 https，指到那一頁。

`id` 在一份報告裡不重複，和原文目錄 `out/<研究名稱>/<來源 id>/` 的名稱相同。`retrieved_on` 不晚於 `researched_on`，`published_on` 與 FinMind 的 `as_of` 不晚於 `retrieved_on`；FinMind 的 `as_of` 也不能比 `retrieved_on` 舊過資料集的上限（日資料 14 天，月營收 75 天，財報 200 天）。來源沒有發佈日時，`published_on` 寫它被取得的日期並在 `locator` 說明。每個來源都要被至少一筆證據引用。

## 證據、數字、估值

證據：`statement`、`level`、`sources`，可選數字、`does_not_establish`、`gap`。`level` 是 `strong`、`medium`、`weak`、`gap`，不能高過其中最好的來源能支持的上限（`filing`、`transcript`、`finmind` 到 `strong`；`company_site`、`media` 到 `medium`；`social`、`other` 到 `weak`）。`level` 是 `gap` 時要寫缺口的 `kind`、`reason`，可選 `checked`；四種缺口見 `serenity-method.md`。缺口沒有任何來源（網頁打不開、腳本庫沒有）時，來源寫「無」。

數字：`metric`、`value`、`unit`、`source`，再加 `period` 或 `as_of`，兩個選一個。`source` 要是這筆證據的來源之一。`period` 是 `2026Q2`、`2026-09` 或 `FY2025`；`as_of` 是日期，不晚於研究日期，也不晚於 FinMind 來源的 `as_of`。

估值：`status`、`note`、證據。`status` 是 `resolved` 時，要有一個帶 `as_of` 的數字（價格）和一個帶 `period` 的數字（獲利），兩個都來自非缺口的證據；否則寫 `unresolved`，並說缺什麼。取哪個價格與哪個獲利，見 `serenity-method.md`。

## theme-scan

| 欄位 | 內容 |
| --- | --- |
| `system_change` | `demand`、`constraint`（`power`、`latency`、`bandwidth`、`heat`、`yield`、`purity`、`reliability`、`cycle_time`、`packaging_density`、`grid`、`other`）、`note` |
| `value_chain.layers` | 八個，`layer` 1 到 8，`name` 見下表。`rank` 1 到 8 各用一次，1 是最稀缺。每層有 `scarcity`（文字）與 1 到 4 筆證據。沒有查的層，證據寫 `not_investigated` 缺口（`reason` 寫為什麼沒查），這一層的 `rank` 不能在前三 |
| `pilot` | 先拿一檔驗證資料與假設：`stock`（`market`、`id`、`name`）、`layer`（`rank` 要在前三）、`requests`（這次為它執行取市場資料腳本的次數，沒有執行時是 0）、`datasets`、`outcome`（`confirmed`、`hypothesis_revised` 或 `inconclusive`）、`note`、1 到 6 筆證據 |
| `candidates` | 0 到 5 檔，依 `High`、`Medium`、`Low` 排。每檔：`market`、`id`、`name`、`layer`、`role`、`stage`、`priority`、`reasoning`、證據（1 到 8 筆）、`valuation`、`invalidation`，可選 `counterargument` |
| `shortlist_note` | 候選少於 3 檔時必填：為什麼證據只支持這麼少 |
| `downgraded` | 可選，最多兩項被降級的方向：`direction`、`reason`、證據 |
| `next_checks` | 至少 3 項 |

八層與 serenity-skill 的「Map the system before selecting companies」這樣對應：

| serenity-skill 說的 | 寫在哪裡 |
| --- | --- |
| 需求 | `system_change.demand` |
| 系統改變與受限的投入 | `system_change.constraint` 與 `note` |
| 相關的層：終端需求、系統整合、模組、晶片與元件、製程與封裝、設備、材料、基礎設施 | `value_chain.layers` 的 1 到 8 層 |
| 具體的限制（認證前置時間、良率、擴產難度、供應商集中度、產能預訂），以及它是暫時、擴大或正在緩解 | 那一層的 `scarcity` 與證據 |
| 明顯的領導者、上游供應商、另一條技術路線 | `candidates`；查了但證據不足寫 `downgraded`；沒查寫 `next_checks` |

| `layer` | `name` | 範圍 |
| --- | --- | --- |
| 1 | `end_demand` | 終端客戶與資本支出 |
| 2 | `system_integration` | 系統整合與整機 |
| 3 | `modules` | 模組與次系統 |
| 4 | `devices` | 核心晶片與關鍵零組件 |
| 5 | `fab_packaging_test` | 晶圓製造、先進封裝與測試 |
| 6 | `equipment` | 生產設備與量測檢測 |
| 7 | `materials` | 關鍵材料與耗材 |
| 8 | `infrastructure` | 實體基礎設施 |

`role` 與 `stage` 的值在 `serenity-method.md`。`High` 要求 `role` 是 `controls_scarce_layer` 或 `supplies_scarce_layer`，且至少一筆來源含 `filing` 或 `transcript` 的 `strong`。`production`、`orders`、`recognized_revenue` 也要這樣一筆；查不到階段寫 `unknown`。

`pilot.outcome` 三選一：`confirmed` 是資料與假設一致，而且 `filing` 或 `transcript` 的 `strong` 證據說明帶動數字的是這一層的產品；`hypothesis_revised` 是資料和假設相反，`rank` 要重排；`inconclusive` 是資料取得了，但它是整間公司的數字，分不出是不是這一層造成的，這時 `rank` 不動，`pilot.note` 寫還缺什麼，並在 `next_checks` 記一筆。只有整間公司數字的 pilot 一定是 `inconclusive` 或 `hypothesis_revised`。

## claim-challenge

| 欄位 | 內容 |
| --- | --- |
| `subject` | `market`、`id`、`name`、`label`（被測的說法，例如「某技術的核心供應商」） |
| `claims` | 五個，`id` 是 `C1` 到 `C5`，`dimension` 各用一次：`product_layer`、`commercial_stage`、`customer_relation`、`attributable_revenue`、`alternatives`。每個有 `text`、`verdict`（`Pass`、`Contradiction`、`Unresolved`）、`reason`、1 到 6 筆證據 |
| `early_stop` | `triggered`、`claim`、`reason`。沒提前終止時 `claim` 與 `reason` 寫「無」 |
| `assessment` | `stage`、`role`、`summary`、證據 |
| `chips` | 證據與 `red_flags`（文字清單）。除了提前終止，一定要有；沒有籌碼資料時，證據寫缺口 |
| `overvalued` | 市場高估的地方，文字清單，可以是空的 |
| `valuation` | 見上 |
| `downgrade_triggers`、`upgrade_triggers` | `condition`，可選 `threshold`：`metric`、`comparison`（`below` 或 `above`）、`value`、`unit`、`period_basis`。降級至少一項；上調可選 |
| `next_checks` | 至少 1 項 |

`Pass` 要有一筆 `strong` 且來源含 `filing` 或 `transcript`；`Contradiction` 要有一筆 `strong` 或 `medium`，貼文不能推翻。有一個子主張是有 `strong` 證據的 `Contradiction`，就一定提前終止，沒查的子主張寫 `not_investigated` 缺口，`chips` 可以省略。`assessment` 受子主張的裁決限制：`stage` 寫 `production`、`orders` 或 `recognized_revenue` 時，`commercial_stage` 的子主張必須是 `Pass`；`role` 寫 `controls_scarce_layer` 或 `supplies_scarce_layer` 時，`product_layer` 的子主張必須是 `Pass`。對應的子主張是 `Unresolved` 或 `Contradiction` 時，`stage` 停在 `qualification` 或更前面，查不到就寫 `unknown`；`role` 改寫 `benefits_from_trend`、`weak_control` 或 `story_only`，`summary` 說明停在這裡的原因。

## arena

| 欄位 | 內容 |
| --- | --- |
| `basis` | `quarter`（`2026Q2`）與 `month`（`2026-09`）：每一檔都用這一季財報與這一個營收月比。美股沒有月營收：`reveal` 裡沒有台股時 `month` 寫「無」，封包也不引用月份的數字；有台股時 `month` 一定要是月份。美股的財季對應見 `serenity-method.md` 的估值 |
| `rubric` | 五個，`dimension` 各用一次：`value_chain_position`、`stage_and_evidence`、`earnings_exposure`、`valuation_pressure`、`failure_conditions`，各有 `question` |
| `reveal` | 2 到 5 檔：`code`（`Candidate A` 到 `Candidate E`）、`market`、`id`、`name`，可選 `aliases`（最多 8 個，列拿它搜尋第一頁就指向這家公司的詞：英文名、簡稱、旗艦產品與品牌名、技術商標、創辦人與經營者姓名） |
| `blind.packets` | 每個代號一份：`code`、`summary`、`stage`、`role`、證據、`valuation`。`blind` 與 `title`、`question`、`rubric` 的文字裡不出現任何一檔的代號、名稱（含去掉 `-KY`、`Corporation` 的寫法）或 `aliases`，全形與半形視為相同；「Candidate A」本身是代號，不算洩漏 |
| `blind.ranking` | 五個面向各一份，各判斷 `rubric` 的一個面向，不重複：`dimension`、`order`（每個代號一次，好的在前，不並列）、`priorities`（每個代號的 `High`、`Medium`、`Low`，要和 `order` 一致）、`reasoning` |
| `blind.verdict` | `order` 與 `reasoning`：解盲前的總順序 |
| `synthesis` | 解盲後：`order`、`changed_after_reveal`、`change_reason`、`invalidation`（每個代號一條失效條件）。順序和盲測不同時 `changed_after_reveal` 是「是」並寫 `change_reason`；沒變時 `change_reason` 寫「無」 |
| `next_checks` | 至少 1 項 |

封包裡的數字，包括 `valuation` 的證據，只能用 `basis` 那一季和那個月。`reveal` 的 Candidate A、B… 依代號的字母順序指派，見 `playbooks/cross-market-arena.md`。`priorities` 只有三個標籤，4 檔以上時用 `order` 分先後，`priorities` 只要不和 `order` 相反。

## 交出前自查

逐項對一次，對不上的先改再交：

- 每個數字都有期間或日期與來源 id；`period` 是已經結束的期間，日期不晚於研究日期。
- 每筆證據的等級不高過它最好的來源能支持的上限。只有 `media`、`company_site`、`social` 或 FinMind 的證據時，不寫已在賣的階段（`production`、`orders`、`recognized_revenue`）、`High` 或 `Pass`。
- 每個缺口有種類與原因；`not_found_in_sources_checked` 列出查過的來源；`confirmed_nonexistent` 有 `filing`、`transcript` 或 `finmind` 的來源。
- 每個來源都被至少一筆證據引用，日期順序對（`published_on` ≤ `retrieved_on` ≤ `researched_on`）。
- 估值寫 `resolved` 時有價格與獲利兩個數字，都來自非缺口的證據。
- 範圍只有 `TW`、`US`；A 股與港股只在 `counterargument.alternatives`。6 位數字且不是 00 開頭的代號是上海或深圳的，不在範圍。
- 沒有 score、總分、評分、綜合這類欄位，沒有目標價。
- `theme-scan`：八層各一次，`rank` 1 到 8 各一次；`not_investigated` 的層不在前三；`pilot.layer` 在前三；只有整間公司數字的 pilot 不是 `confirmed`；`next_checks` 至少 3 項；候選少於 3 檔時有 `shortlist_note`。
- `claim-challenge`：五個子主張各一個 `dimension`；有 `strong` 的 `Contradiction` 就提前終止；`assessment` 的 `stage` 與 `role` 符合上面的限制；沒提前終止時有 `chips`；降級觸發至少一項。
- `arena`：`basis.month` 和市場一致；封包的數字只用 `basis` 的期間；`blind`、`title`、`question`、`rubric` 沒有代號、名稱或別名；五份 `ranking` 各一個面向，`order` 與 `priorities` 不矛盾；`synthesis.changed_after_reveal` 和兩個順序一致。
