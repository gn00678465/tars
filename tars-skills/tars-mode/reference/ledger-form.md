# 記帳表單（ui_show）

在遠端網頁，擁有者要記帳但日期、金額、帳戶、摘要沒給齊時，用 `ui_show` 顯示一張表單讓擁有者填。終端的 `tars chat` 沒有表單，`ui_show` 會失敗，改用文字問。

## 順序

1. 用 `fava-ledger` 的 `query` 取帳戶清單。這一次查詢會出核准卡。同一個對話查過一次就沿用，不重查。
2. 依帳戶類型縮小選項，再放進表單：
   - 貸方帳戶（`source`，錢從哪來）：只列 `Assets` 與 `Liabilities` 開頭的帳戶。
   - 借方帳戶（`target`，錢去哪）：支出列 `Expenses` 開頭的帳戶，收入列 `Income` 開頭的帳戶。
   帳本的帳戶全部放進去會太長，選項也難找。
3. 照下面的範例呼叫 `ui_show`。結果說已顯示表單時，這一輪就結束，不要猜擁有者會填什麼。
4. 擁有者送出後，你會收到一則以〔表單送出〕開頭的訊息，列出日期、金額、借方帳戶、貸方帳戶、摘要、付款對象。之後照記帳的規則走：先帶 `--dry-run` 執行，把預覽給擁有者看，確認後才正式寫入。

## 可以改的地方

- 標題 `title` 的文字。
- 兩個 `ChoicePicker` 的 `options`：每個選項的 `label` 與 `value` 都寫帳戶全名。
- `dataModel` 的預填值：
  - `date` 是 `YYYY-MM-DD`，預設今天。
  - `amount`、`narration`、`payee` 是字串，不知道時給空字串。
  - `target`、`source` 是陣列：預選一個帳戶時寫 `["帳戶全名"]`，不預選時寫 `[]`。預選的帳戶要在選項裡。

其餘照抄：元件種類、`id`、綁定的路徑、`Button` 的 `action` 與 `checks`。

## 寫法的規則

- 資料綁定寫 `{"@path": "/date"}`，函式寫 `{"@call": "required", ...}`。
- 元件上的檢查寫 `checks`，前面不加 `@`。
- 擋住送出的檢查放在 `Button` 的 `checks`。放在欄位上只顯示紅框，擋不住送出。
- 元件只能用 `Column`、`Row`、`Text`、`Divider`、`TextField`、`DateTimeInput`、`ChoicePicker`、`Button`。不用 `Icon`，`Text` 不加 `weight`。
- 只能有一個 `Button`，它的 `action` 是 `event`，`name` 是 `ledger_submit`。不用 `functionCall`。
- `ui_show` 的輸入不超過 16,384 位元組。
- 本機端只接受選項裡的帳戶，借方與貸方不能相同，金額要大於 0。

## 範例

`ui_show` 的輸入：

```json
{
  "components": [
    {
      "id": "root",
      "component": "Column",
      "children": ["title", "date", "amount", "target", "source", "narration", "payee", "submit"]
    },
    { "id": "title", "component": "Text", "text": "記一筆帳" },
    {
      "id": "date",
      "component": "DateTimeInput",
      "label": "日期",
      "enableDate": true,
      "value": { "@path": "/date" }
    },
    {
      "id": "amount",
      "component": "TextField",
      "label": "金額",
      "variant": "number",
      "value": { "@path": "/amount" },
      "checks": [
        {
          "condition": { "@call": "required", "args": { "value": { "@path": "/amount" } } },
          "message": "請填金額"
        }
      ]
    },
    {
      "id": "target",
      "component": "ChoicePicker",
      "label": "借方帳戶（錢去哪）",
      "variant": "mutuallyExclusive",
      "filterable": true,
      "value": { "@path": "/target" },
      "options": [
        { "label": "Expenses:Food:Dinner", "value": "Expenses:Food:Dinner" },
        { "label": "Expenses:Transport", "value": "Expenses:Transport" }
      ]
    },
    {
      "id": "source",
      "component": "ChoicePicker",
      "label": "貸方帳戶（錢從哪來）",
      "variant": "mutuallyExclusive",
      "filterable": true,
      "value": { "@path": "/source" },
      "options": [
        { "label": "Assets:Cash:Wallet", "value": "Assets:Cash:Wallet" },
        { "label": "Liabilities:CreditCard", "value": "Liabilities:CreditCard" }
      ]
    },
    {
      "id": "narration",
      "component": "TextField",
      "label": "摘要",
      "value": { "@path": "/narration" }
    },
    {
      "id": "payee",
      "component": "TextField",
      "label": "付款對象",
      "value": { "@path": "/payee" }
    },
    {
      "id": "submit",
      "component": "Button",
      "variant": "primary",
      "child": "submit_label",
      "checks": [
        {
          "condition": {
            "@call": "and",
            "args": {
              "values": [
                { "@call": "required", "args": { "value": { "@path": "/date" } } },
                { "@call": "required", "args": { "value": { "@path": "/amount" } } },
                { "@call": "required", "args": { "value": { "@path": "/narration" } } }
              ]
            }
          },
          "message": "日期、金額、摘要要填"
        }
      ],
      "action": {
        "event": {
          "name": "ledger_submit",
          "context": {
            "date": { "@path": "/date" },
            "amount": { "@path": "/amount" },
            "target": { "@path": "/target" },
            "source": { "@path": "/source" },
            "narration": { "@path": "/narration" },
            "payee": { "@path": "/payee" }
          }
        }
      }
    },
    { "id": "submit_label", "component": "Text", "text": "送出" }
  ],
  "dataModel": {
    "date": "2026-11-23",
    "amount": "",
    "target": [],
    "source": ["Assets:Cash:Wallet"],
    "narration": "",
    "payee": ""
  }
}
```
