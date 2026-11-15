# 劇本輸出的 JSON 備忘錄

三個 Serenity 劇本各寫一份 JSON：`theme-scan`、`claim-challenge`、`arena`。`tars market memo-check <檔案>` 逐項檢查它，通過印 `ok memo <類型>: <路徑> (<N> sources)` 並以 0 結束；沒通過以 3 結束，標準錯誤每行一個問題，開頭是出問題的 JSON 路徑（`$.candidates[0].priority`）。同一個檔案可以交給別的程式用，`tars market memo-render <檔案>` 轉成 Markdown 只是其中一種用法。

規則的理由在 `serenity-method.md`，取數在 `serenity-data.md`。這一頁是欄位清單與三個完整範例。範例的公司、來源與數字都是虛構的，只示範格式，不是研究結論。

## 每一種都有的欄位

| 欄位 | 內容 |
| --- | --- |
| `kind` | `theme-scan`、`claim-challenge` 或 `arena` |
| `title`、`question` | 標題；這份備忘錄要回答的問題 |
| `researched_on` | 研究日期 `yyyy-mm-dd`，不能晚於今天（台北） |
| `scope.markets` | `["TW"]`、`["US"]` 或兩個都有。每檔股票的 `market` 要在這裡 |
| `counterargument` | `argument`：最有力的反對。可選 `alternatives`：`{ "text", "market" }`，`market` 可以是 `TW`、`US`、`CN`、`HK`、`OTHER`；A 股與港股只能出現在這裡 |
| `next_checks` | `{ "check", "target", "would_change" }` 的清單 |
| `sources` | 來源清單，1 到 60 個，見下 |

不在清單裡的欄位會被拒絕。檢查把整份文件走過一遍：JSON 裡的數字只能出現在 `figures[].value`、價值鏈的 `layer` 與 `rank`、`pilot.layer`、`pilot.requests`、候選的 `layer` 與觸發條件的 `threshold.value`；名字含 score 或「總分」「評分」「綜合」的欄位不能有，`figures` 的 `metric` 不能是評分、目標價，`unit` 不能是「分」；句子裡帶單位的數字（`35%`、`NT$ 3000`、`2 倍`、`5 億`、`1200 張`、`91 分`）要改放進 `figures`，只有 `invalidation`、`would_change`、`condition` 這三個說「什麼會改變判斷」的欄位可以直接寫門檻數字。每個文字欄位是一行，含換行或控制字元的被拒絕。範圍掃描涵蓋所有欄位（標題與名稱也是），只有 `counterargument` 與 `sources` 例外。台股代號是 4 位數字（可加一個大寫字母），ETF 是 00 開頭再 3 或 4 碼；6 位數字且不是 00 開頭的是上海或深圳的代號，被拒絕。

## 來源

FinMind：`{ "id", "kind": "finmind", "dataset", "data_id", "as_of", "retrieved_on" }`。`dataset` 要是 `tars market` 認得的資料集。

其他：`{ "id", "kind", "title", "publisher", "url", "published_on", "retrieved_on" }`，`kind` 是 `filing`、`transcript`、`company_site`、`media`、`social`、`other`。`filing` 與 `transcript` 另要 `locator`，其他種類可寫，最多 200 字；來源沒有 `note` 欄位，要說明的事（例如 EDGAR 沒有確認、網域沒有第二個來源）寫在 `locator`。`kind` 怎麼選，公司自己做的文件見 `serenity-method.md` 的「公司自己做的文件算哪一種」。`url` 要是 https，指到那一頁，不含空白、引號、角括號、反引號與反斜線。

`id` 在一份備忘錄裡不重複。`retrieved_on` 不晚於 `researched_on`，`published_on` 與 FinMind 的 `as_of` 不晚於 `retrieved_on`；FinMind 的 `as_of` 也不能比 `retrieved_on` 舊過資料集的上限（日資料 14 天，月營收 75 天，財報 200 天）。來源沒有發佈日時，`published_on` 寫它被取得的日期並在 `locator` 說明。每個來源都要被至少一筆證據引用。

## 證據、數字、估值

證據：`{ "statement", "level", "sources", "figures"?, "does_not_establish"?, "gap"? }`。`level` 是 `strong`、`medium`、`weak`、`gap`。`sources` 是來源代號，`level` 不能高過其中最好的來源能支持的上限（`filing`、`transcript`、`finmind` 到 `strong`；`company_site`、`media` 到 `medium`；`social`、`other` 到 `weak`）。`level` 是 `gap` 時要有 `gap`：`{ "kind", "reason", "checked"? }`，`kind` 的四種見 `serenity-method.md`。每筆證據都要有 `sources` 欄位；缺口沒有任何來源（例如網頁打不開、FinMind 不提供）時寫 `[]`，不省略。

數字：`{ "metric", "value", "unit", "source", "period" 或 "as_of", "note"? }`。`source` 要是這筆證據的 `sources` 之一。`period` 是 `2026Q2`、`2026-09` 或 `FY2025`；`as_of` 是日期，不晚於研究日期，也不晚於 FinMind 來源的 `as_of`。兩個要有一個，也只能有一個。

估值：`{ "status", "note", "evidence" }`。`status` 是 `resolved` 時，`evidence` 要有一個帶 `as_of` 的數字（價格）和一個帶 `period` 的數字（獲利），兩個都要來自非缺口的證據，缺口證據帶的 figures 不算；否則寫 `unresolved`，`evidence` 可以是空的。取哪個價格與哪個獲利，見 `serenity-method.md`。

## theme-scan

| 欄位 | 內容 |
| --- | --- |
| `system_change` | `demand`、`constraint`（`power`、`latency`、`bandwidth`、`heat`、`yield`、`purity`、`reliability`、`cycle_time`、`packaging_density`、`grid`、`other`）、`note` |
| `value_chain.layers` | 八個，`layer` 1 到 8，`name` 依序是 `end_demand`、`system_integration`、`modules`、`devices`、`fab_packaging_test`、`equipment`、`materials`、`infrastructure`。`rank` 1 到 8 各用一次，1 是最稀缺。每層有 `scarcity`（文字）與 1 到 4 筆 `evidence`。沒有查的層，證據寫 `not_investigated` 缺口（`reason` 寫為什麼沒查，見 `serenity-method.md`），這一層的 `rank` 不能在前三 |
| `pilot` | 先拿一檔驗證資料與假設：`stock`（`market`、`id`、`name`）、`layer`（`rank` 要在前三）、`requests`（這次 `sync` 的請求數，沒有重新同步時是 0）、`datasets`、`outcome`（`confirmed`、`hypothesis_revised` 或 `inconclusive`）、`note`、1 到 6 筆 `evidence` |
| `candidates` | 0 到 5 檔，依 `High`、`Medium`、`Low` 排。每檔：`market`、`id`、`name`、`layer`、`role`、`stage`、`priority`、`reasoning`、`evidence`（1 到 8 筆）、`valuation`、`invalidation`，可選 `counterargument` |
| `shortlist_note` | 候選少於 3 檔時必填：為什麼證據只支持這麼少 |
| `downgraded` | 可選，最多兩項被降級的方向：`direction`、`reason`、`evidence` |
| `next_checks` | 至少 3 項 |

八層與 serenity-skill 的「Map the system before selecting companies」這樣對應：

| serenity-skill 說的 | 寫在哪裡 |
| --- | --- |
| 需求 | `system_change.demand` |
| 系統改變與受限的投入 | `system_change.constraint`（列舉）與 `note` |
| 相關的層：終端需求、系統整合、模組、晶片與元件、製程與封裝、設備、材料、基礎設施 | `value_chain.layers` 的 1 到 8 層，名稱見下表 |
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

`role` 與 `stage` 的值在 `serenity-method.md`。`High` 要求 `role` 是 `controls_scarce_layer` 或 `supplies_scarce_layer`，且至少一筆 `strong`。`production`、`orders`、`recognized_revenue` 也要至少一筆 `strong`；查不到階段寫 `unknown`。

`pilot.outcome` 三選一：`confirmed` 是資料與假設一致，而且 `filing` 或 `transcript` 的 `strong` 證據說明帶動數字的是這一層的產品，沒有這樣的證據，檢查會拒絕；`hypothesis_revised` 是資料和假設相反，`rank` 要重排；`inconclusive` 是資料取得了，但 FinMind 是整間公司的數字，分不出是不是這一層造成的，這時 `rank` 不動，`pilot.note` 寫還缺什麼，並在 `next_checks` 記一筆。所以只用 FinMind 的 pilot 一定是 `inconclusive` 或 `hypothesis_revised`。

```json
{
  "kind": "theme-scan",
  "title": "示範：先進封裝的稀缺環節",
  "researched_on": "2026-10-26",
  "scope": {"markets": ["TW", "US"]},
  "question": "資本支出轉向先進封裝後，哪一層最先成為限制，誰控制它？",
  "system_change": {"demand": "雲端業者把新增預算轉向需要先進封裝的加速器", "constraint": "packaging_density", "note": "限制不在晶片本身，在把晶片組成系統的那一段。"},
  "value_chain": {
    "layers": [
      {"layer": 1, "name": "end_demand", "rank": 3, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]},
      {"layer": 2, "name": "system_integration", "rank": 4, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]},
      {"layer": 3, "name": "modules", "rank": 6, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]},
      {"layer": 4, "name": "devices", "rank": 2, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]},
      {"layer": 5, "name": "fab_packaging_test", "rank": 1, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]},
      {"layer": 6, "name": "equipment", "rank": 5, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]},
      {"layer": 7, "name": "materials", "rank": 7, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]},
      {"layer": 8, "name": "infrastructure", "rank": 8, "scarcity": "供需差距用文字說明，不打分數。", "evidence": [{"statement": "報導提到交期拉長", "level": "medium", "sources": ["S3"]}]}
    ]
  },
  "pilot": {
    "stock": {"market": "TW", "id": "2330", "name": "示範甲"},
    "layer": 5,
    "requests": 3,
    "datasets": ["TaiwanStockPrice"],
    "outcome": "inconclusive",
    "note": "價格資料確實同步到最近的交易日，資料沒有推翻假設；但它是整間公司的數字，分不出是不是這一層的產品造成的，還缺能拆出這一層營收的一手說明。",
    "evidence": [
      {
        "statement": "收盤價同步到最近的交易日",
        "level": "strong",
        "sources": ["S1"],
        "figures": [{"metric": "收盤價", "value": 2442, "unit": "NT$", "source": "S1", "as_of": "2026-10-22"}]
      }
    ]
  },
  "candidates": [
    {
      "market": "TW",
      "id": "2330",
      "name": "示範甲",
      "layer": 5,
      "role": "controls_scarce_layer",
      "stage": "recognized_revenue",
      "priority": "High",
      "reasoning": "季報已把這一層的產品列為營收來源，且沒有同規格的替代供應商。",
      "evidence": [{"statement": "季報揭露該產品線已認列營收", "level": "strong", "sources": ["S2"], "does_not_establish": "不能證明這條產品線的利潤率高於其他產品線"}],
      "valuation": {"status": "unresolved", "note": "還沒有同日期的價格與同期的獲利可以對照。", "evidence": []},
      "invalidation": "下一季季報不再單獨列出這條產品線。"
    },
    {
      "market": "TW",
      "id": "3680",
      "name": "示範乙",
      "layer": 5,
      "role": "supplies_scarce_layer",
      "stage": "sampling",
      "priority": "Medium",
      "reasoning": "報導說它已向客戶送樣，但還沒有量產的公開證據。",
      "evidence": [{"statement": "報導提到送樣中", "level": "medium", "sources": ["S3"]}],
      "valuation": {"status": "unresolved", "note": "價格資料尚未對照財報期間。", "evidence": []},
      "invalidation": "客戶驗證結果沒有在兩季內公布。"
    },
    {
      "market": "US",
      "id": "NVDA",
      "name": "示範丙",
      "layer": 4,
      "role": "benefits_from_trend",
      "stage": "development",
      "priority": "Low",
      "reasoning": "受惠於整體需求，但沒有證據說它控制稀缺環節。",
      "evidence": [{"statement": "只有題材層級的報導", "level": "weak", "sources": ["S3"]}],
      "valuation": {"status": "unresolved", "note": "不在這一輪研究範圍內。", "evidence": []},
      "invalidation": "找到它控制稀缺環節的一手資料時，改為重新評估。"
    }
  ],
  "counterargument": {"argument": "若終端需求放緩，封裝產能的緊缺會先於財報反映，名單內的標的會同時被重新定價。", "alternatives": [{"text": "同一條供應鏈在港股也有上市公司，但本備忘錄不涵蓋。", "market": "HK"}]},
  "next_checks": [
    {"check": "找能拆出這一層產品營收的一手說明", "target": "最新一季財報的分部資訊與法說會逐字稿", "would_change": "若分部資訊顯示這一層的營收在成長，前導驗證才能改為 confirmed"},
    {"check": "查第 1 個還沒有證據的環節", "target": "最新一季的法說會逐字稿", "would_change": "若逐字稿沒有提到，名單順序要往後移"},
    {"check": "查第 2 個還沒有證據的環節", "target": "最新一季的法說會逐字稿", "would_change": "若逐字稿沒有提到，名單順序要往後移"}
  ],
  "sources": [
    {"id": "S1", "kind": "finmind", "dataset": "TaiwanStockPrice", "data_id": "2330", "as_of": "2026-10-22", "retrieved_on": "2026-10-26"},
    {
      "id": "S2",
      "kind": "filing",
      "title": "示範甲公司 2026Q2 季報",
      "publisher": "示範交易所",
      "url": "https://example.com/filings/demo-a-2026q2",
      "published_on": "2026-08-12",
      "retrieved_on": "2026-10-26",
      "locator": "第 12 頁，營運概況"
    },
    {
      "id": "S3",
      "kind": "media",
      "title": "示範報導：先進封裝產能吃緊",
      "publisher": "示範日報",
      "url": "https://example.com/news/packaging-capacity",
      "published_on": "2026-10-01",
      "retrieved_on": "2026-10-26"
    }
  ]
}
```

## claim-challenge

| 欄位 | 內容 |
| --- | --- |
| `subject` | `market`、`id`、`name`、`label`（被測的說法，例如「某技術的核心供應商」） |
| `claims` | 五個，`id` 是 `C1` 到 `C5`，`dimension` 各用一次：`product_layer`、`commercial_stage`、`customer_relation`、`attributable_revenue`、`alternatives`。每個有 `text`、`verdict`（`Pass`、`Contradiction`、`Unresolved`）、`reason`、1 到 6 筆 `evidence` |
| `early_stop` | `triggered`、`claim`、`reason`。沒提前終止時 `claim` 與 `reason` 寫 `null` |
| `assessment` | `stage`、`role`、`summary`、`evidence` |
| `chips` | `evidence` 與 `red_flags`（文字清單）。除了提前終止，一定要有 |
| `overvalued` | 市場高估的地方，文字清單，可以是空的 |
| `valuation` | 見上 |
| `downgrade_triggers`、`upgrade_triggers` | `condition`，可選 `threshold`：`metric`、`comparison`（`below` 或 `above`）、`value`、`unit`、`period_basis`。降級至少一項；上調可選 |
| `next_checks` | 至少 1 項 |

`Pass` 要有一筆 `strong` 且來源含 `filing` 或 `transcript`；`Contradiction` 要有一筆 `strong` 或 `medium`，貼文不能推翻。有一個子主張是有 `strong` 證據的 `Contradiction`，就一定提前終止（`triggered` 寫 `true`），沒查的子主張寫 `gap` 加 `not_investigated`，`chips` 可以省略。`assessment` 受子主張的裁決限制：`stage` 寫 `production`、`orders` 或 `recognized_revenue` 時，商業化階段（`commercial_stage`）的子主張必須是 `Pass`；`role` 寫 `controls_scarce_layer` 或 `supplies_scarce_layer` 時，產品位置（`product_layer`）的子主張必須是 `Pass`。對應的子主張是 `Unresolved` 或 `Contradiction` 時，`stage` 停在 `qualification` 或更前面，查不到就寫 `unknown`；`role` 改寫 `benefits_from_trend`、`weak_control` 或 `story_only`，`summary` 說明停在這裡的原因。

```json
{
  "kind": "claim-challenge",
  "title": "示範：示範乙是不是目標環節的關鍵供應商",
  "researched_on": "2026-10-26",
  "scope": {"markets": ["TW"]},
  "question": "公司自稱的關鍵供應商，能不能在資料裡重現？",
  "subject": {"market": "TW", "id": "3680", "name": "示範乙", "label": "目標環節的關鍵供應商"},
  "claims": [
    {
      "id": "C1",
      "dimension": "product_layer",
      "text": "第 1 個子主張：product_layer 與公司的說法一致。",
      "verdict": "Pass",
      "reason": "依下列證據判斷，沒有的部分標為缺口。",
      "evidence": [{"statement": "季報把這個產品列在目標環節", "level": "strong", "sources": ["S2"]}]
    },
    {
      "id": "C2",
      "dimension": "commercial_stage",
      "text": "第 2 個子主張：commercial_stage 與公司的說法一致。",
      "verdict": "Unresolved",
      "reason": "依下列證據判斷，沒有的部分標為缺口。",
      "evidence": [{"statement": "只有報導說已送樣，沒有客戶或訂單的一手資料", "level": "medium", "sources": ["S3"]}]
    },
    {
      "id": "C3",
      "dimension": "customer_relation",
      "text": "第 3 個子主張：customer_relation 與公司的說法一致。",
      "verdict": "Unresolved",
      "reason": "依下列證據判斷，沒有的部分標為缺口。",
      "evidence": [{"statement": "已查閱的來源沒有提到直接客戶", "level": "gap", "sources": ["S2"], "gap": {"kind": "not_found_in_sources_checked", "reason": "季報沒有逐客戶揭露。", "checked": ["S2"]}}]
    },
    {
      "id": "C4",
      "dimension": "attributable_revenue",
      "text": "第 4 個子主張：attributable_revenue 與公司的說法一致。",
      "verdict": "Contradiction",
      "reason": "依下列證據判斷，沒有的部分標為缺口。",
      "evidence": [{"statement": "報導指出該產品的營收占比低於公司的說法", "level": "medium", "sources": ["S3"]}]
    },
    {
      "id": "C5",
      "dimension": "alternatives",
      "text": "第 5 個子主張：alternatives 與公司的說法一致。",
      "verdict": "Unresolved",
      "reason": "依下列證據判斷，沒有的部分標為缺口。",
      "evidence": [{"statement": "沒有查到客戶的替代方案", "level": "weak", "sources": ["S3"]}]
    }
  ],
  "early_stop": {"triggered": false, "claim": null, "reason": null},
  "assessment": {
    "stage": "sampling",
    "role": "supplies_scarce_layer",
    "summary": "產品位置可驗證，商業化階段只到送樣，營收占比與公司的說法有出入。",
    "evidence": [{"statement": "季報與報導合起來只支持到送樣階段", "level": "strong", "sources": ["S2"]}]
  },
  "chips": {
    "evidence": [{"statement": "外資近期賣超", "level": "strong", "sources": ["S1"], "figures": [{"metric": "外資買賣超", "value": -1200, "unit": "張", "source": "S1", "as_of": "2026-10-22"}]}],
    "red_flags": ["法人沒有隨公司的說法加碼。"]
  },
  "overvalued": ["市場把送樣階段當成已量產來定價。"],
  "valuation": {"status": "unresolved", "note": "價格與同期獲利尚未對照。", "evidence": []},
  "downgrade_triggers": [{"condition": "下一季月營收年增率轉為負值", "threshold": {"metric": "月營收年增率", "comparison": "below", "value": 0, "unit": "%", "period_basis": "2026-09"}}],
  "counterargument": {"argument": "若終端需求放緩，封裝產能的緊缺會先於財報反映，名單內的標的會同時被重新定價。", "alternatives": [{"text": "同一條供應鏈在港股也有上市公司，但本備忘錄不涵蓋。", "market": "HK"}]},
  "next_checks": [{"check": "查第 1 個還沒有證據的環節", "target": "最新一季的法說會逐字稿", "would_change": "若逐字稿沒有提到，名單順序要往後移"}],
  "sources": [
    {"id": "S1", "kind": "finmind", "dataset": "TaiwanStockInstitutionalInvestorsBuySell", "data_id": "3680", "as_of": "2026-10-22", "retrieved_on": "2026-10-26"},
    {
      "id": "S2",
      "kind": "filing",
      "title": "示範甲公司 2026Q2 季報",
      "publisher": "示範交易所",
      "url": "https://example.com/filings/demo-a-2026q2",
      "published_on": "2026-08-12",
      "retrieved_on": "2026-10-26",
      "locator": "第 12 頁，營運概況"
    },
    {
      "id": "S3",
      "kind": "media",
      "title": "示範報導：先進封裝產能吃緊",
      "publisher": "示範日報",
      "url": "https://example.com/news/packaging-capacity",
      "published_on": "2026-10-01",
      "retrieved_on": "2026-10-26"
    }
  ]
}
```

## arena

| 欄位 | 內容 |
| --- | --- |
| `basis` | `quarter`（`2026Q2`）與 `month`（`2026-09`）：每一檔股票都用這一季財報與這一個營收月比。美股沒有月營收：`reveal` 裡沒有台股時 `month` 寫 `null`，封包也不能引用月份的數字；有台股時 `month` 一定要是月份。美股的財季對應見 `serenity-method.md` 的估值 |
| `rubric` | 五個，`dimension` 各用一次：`value_chain_position`、`stage_and_evidence`、`earnings_exposure`、`valuation_pressure`、`failure_conditions`，各有 `question` |
| `reveal` | 2 到 5 檔：`code`（`Candidate A` 到 `Candidate E`）、`market`、`id`、`name`，可選 `aliases`（最多 8 個，列拿它搜尋第一頁就指向這家公司的詞：英文名、簡稱、旗艦產品與品牌名、技術商標、創辦人與經營者姓名。檢查只認得這裡列的，列漏的不會被擋） |
| `blind.packets` | 每個代號一份：`code`、`summary`、`stage`、`role`、`evidence`、`valuation`。`blind` 與 `title`、`question`、`rubric` 的文字裡不能出現任何一檔的代號、名稱（含去掉 `-KY`、`Corporation` 的寫法）或 `aliases`，全形與半形視為相同；「Candidate A」本身是代號，不算洩漏 |
| `blind.ranking` | 五個面向各一份，五份各判斷 `rubric` 的一個面向，不重複：`dimension`、`order`（每個代號一次，好的在前，不並列）、`priorities`（每個代號的 `High`、`Medium`、`Low`，要和 `order` 一致）、`reasoning` |
| `blind.verdict` | `order` 與 `reasoning`：解盲前的總順序 |
| `synthesis` | 解盲後：`order`、`changed_after_reveal`、`change_reason`、`invalidation`（每個代號一條失效條件）。順序和盲測不同時 `changed_after_reveal` 要是 `true` 並寫 `change_reason`；沒變時 `change_reason` 寫 `null` |
| `next_checks` | 至少 1 項 |

封包裡的數字，包括 `valuation` 的證據，只能用 `basis` 那一季（`period`）和那個月；其他期間的數字被拒絕。`reveal` 裡 Candidate A、B… 的對應就是劇本打亂順序的結果，不另存隨機種子。`priorities` 只有 `High`、`Medium`、`Low` 三個標籤，4 檔以上時用 `order` 分先後，`priorities` 只要不和 `order` 相反。

```json
{
  "kind": "arena",
  "title": "示範：兩檔跨市場標的的盲測比較",
  "researched_on": "2026-10-26",
  "scope": {"markets": ["TW", "US"]},
  "question": "兩檔標的，在同一季報與同一個營收月份下，誰比較接近目標環節？",
  "basis": {"quarter": "2026Q2", "month": "2026-09"},
  "rubric": [
    {"dimension": "value_chain_position", "question": "在「value_chain_position」上，哪一檔比較強，為什麼？"},
    {"dimension": "stage_and_evidence", "question": "在「stage_and_evidence」上，哪一檔比較強，為什麼？"},
    {"dimension": "earnings_exposure", "question": "在「earnings_exposure」上，哪一檔比較強，為什麼？"},
    {"dimension": "valuation_pressure", "question": "在「valuation_pressure」上，哪一檔比較強，為什麼？"},
    {"dimension": "failure_conditions", "question": "在「failure_conditions」上，哪一檔比較強，為什麼？"}
  ],
  "reveal": [{"code": "Candidate A", "market": "TW", "id": "2330", "name": "示範甲"}, {"code": "Candidate B", "market": "US", "id": "NVDA", "name": "示範丙"}],
  "blind": {
    "packets": [
      {
        "code": "Candidate A",
        "summary": "控制目標環節的供應商，季報已認列營收。",
        "stage": "recognized_revenue",
        "role": "controls_scarce_layer",
        "evidence": [{"statement": "單季毛利率已揭露", "level": "strong", "sources": ["S2"], "figures": [{"metric": "毛利率", "value": 58.1, "unit": "%", "source": "S2", "period": "2026Q2"}]}],
        "valuation": {"status": "unresolved", "note": "價格與同期獲利尚未對照。", "evidence": []}
      },
      {
        "code": "Candidate B",
        "summary": "受惠於整體需求的供應商，報導提到訂單但沒有一手資料。",
        "stage": "sampling",
        "role": "benefits_from_trend",
        "evidence": [
          {
            "statement": "近期報導提到訂單",
            "level": "medium",
            "sources": ["S3"],
            "figures": [{"metric": "訂單能見度", "value": 3, "unit": "季", "source": "S3", "as_of": "2026-10-01"}]
          }
        ],
        "valuation": {"status": "unresolved", "note": "價格與同期獲利尚未對照。", "evidence": []}
      }
    ],
    "ranking": [
      {
        "dimension": "value_chain_position",
        "order": ["Candidate A", "Candidate B"],
        "priorities": [{"code": "Candidate A", "priority": "High"}, {"code": "Candidate B", "priority": "Medium"}],
        "reasoning": "A 的證據等級較高，B 的證據停在報導。"
      },
      {
        "dimension": "stage_and_evidence",
        "order": ["Candidate A", "Candidate B"],
        "priorities": [{"code": "Candidate A", "priority": "High"}, {"code": "Candidate B", "priority": "Medium"}],
        "reasoning": "A 的證據等級較高，B 的證據停在報導。"
      },
      {
        "dimension": "earnings_exposure",
        "order": ["Candidate A", "Candidate B"],
        "priorities": [{"code": "Candidate A", "priority": "High"}, {"code": "Candidate B", "priority": "Medium"}],
        "reasoning": "A 的證據等級較高，B 的證據停在報導。"
      },
      {
        "dimension": "valuation_pressure",
        "order": ["Candidate A", "Candidate B"],
        "priorities": [{"code": "Candidate A", "priority": "High"}, {"code": "Candidate B", "priority": "Medium"}],
        "reasoning": "A 的證據等級較高，B 的證據停在報導。"
      },
      {
        "dimension": "failure_conditions",
        "order": ["Candidate A", "Candidate B"],
        "priorities": [{"code": "Candidate A", "priority": "High"}, {"code": "Candidate B", "priority": "Medium"}],
        "reasoning": "A 的證據等級較高，B 的證據停在報導。"
      }
    ],
    "verdict": {"order": ["Candidate A", "Candidate B"], "reasoning": "五個面向都是 A 在前，差距主要來自證據等級。"}
  },
  "synthesis": {
    "order": ["Candidate A", "Candidate B"],
    "changed_after_reveal": false,
    "change_reason": null,
    "invalidation": [{"code": "Candidate A", "condition": "下一季季報不再單獨列出該產品線。"}, {"code": "Candidate B", "condition": "訂單沒有在下一次法說會被確認。"}]
  },
  "counterargument": {"argument": "若終端需求放緩，封裝產能的緊缺會先於財報反映，名單內的標的會同時被重新定價。", "alternatives": [{"text": "同一條供應鏈在港股也有上市公司，但本備忘錄不涵蓋。", "market": "HK"}]},
  "next_checks": [{"check": "查第 1 個還沒有證據的環節", "target": "最新一季的法說會逐字稿", "would_change": "若逐字稿沒有提到，名單順序要往後移"}],
  "sources": [
    {
      "id": "S2",
      "kind": "filing",
      "title": "示範甲公司 2026Q2 季報",
      "publisher": "示範交易所",
      "url": "https://example.com/filings/demo-a-2026q2",
      "published_on": "2026-08-12",
      "retrieved_on": "2026-10-26",
      "locator": "第 12 頁，營運概況"
    },
    {
      "id": "S3",
      "kind": "media",
      "title": "示範報導：先進封裝產能吃緊",
      "publisher": "示範日報",
      "url": "https://example.com/news/packaging-capacity",
      "published_on": "2026-10-01",
      "retrieved_on": "2026-10-26"
    }
  ]
}
```
