# 寫一支腳本

`playbooks/script.md` 步驟 7 用。`tars script submit` 會檢查的規則，違反時它會說哪一條；這裡寫它檢查不到、要靠寫的人做對的事，以及最常被它擋下的寫法。

## 骨架

```python
# /// script
# requires-python = ">=3.12"
# dependencies = []             # 要套件時寫成 ["httpx==<版本>"]
#
# [tool.tars]
# name = "<名稱>"
# summary = "<一句話：這支腳本做什麼>"
# secret = "<金鑰種類>"        # 不用金鑰就刪掉這行
# domains = ["<網域>"]          # 只寫要連的網域；不連網路就寫 []
# effects = "external-write"    # read-only | external-write | local-write
# args = "--title <文字> --body <文字>"
# outputs = "成功時 stdout 印一行 JSON：{...}"
# exit = { 0 = "成功", 1 = "失敗", 2 = "參數錯", 3 = "沒有金鑰或金鑰被拒" }
# ///
import argparse, json, os, sys


def main() -> int:
    p = argparse.ArgumentParser()
    # 參數
    a = p.parse_args()
    secret = os.environ.get("TARS_SECRET")
    if secret is None:
        print("沒有金鑰", file=sys.stderr)
        return 3
    # 做事；結果印成一行 JSON 到 stdout
    return 0


sys.exit(main())
```

## 規則

- **名稱。** 小寫英數與 `-`，不以 `-` 開頭，描述動作，例如 `bark-push`、`download`。
- **Python 版本。** `requires-python` 寫成 `">=3.<minor>"`，要上限時加 `",<3.<minor>"`。腳本跑在 `/usr/bin/python3` 上，tars 只知道它的 major.minor，所以取決於 micro 的條件（`>=3.12.1`、`==3.12`）和讀不懂的寫法（`===`、預發布版），gate 1 都會拒絕。
- **套件。** 能用標準函式庫（`urllib.request`、`json`、`argparse`）就不加套件。要加時：
  - 版本寫死成 `==`。tars 只鎖發布滿 7 天的版本，而且只裝 wheel；太新的版本、只有原始碼包的套件都鎖不到。
  - 選 OSV 沒有公告的版本。
- **網路。** 沙盒只能經過 tars 給的 proxy 連外，proxy 位址在 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`。HTTP 用會讀這些變數的 `urllib.request` 或 `httpx`，不讀的客戶端連不上。`domains` 只寫要連的主機：
  - 寫小寫的主機名稱，可以加 port，例如 `"api.example.com:8443"`；子網域寫 `"*.example.com"`。不支援 IPv6。
  - 主機是私人資訊（自架的服務）時寫 `"secret:url"`，金鑰存成 `{"url": …, "key": …}`，tars 從 `url` 取出主機與 port 放行。
  - 連本機服務時寫 IP 加 port，例如 `"127.0.0.1:5000"`。寫 `localhost` 時 gate 1 會拒絕。
  - 只有不用金鑰的腳本能寫 `"*"`，而且它要是唯一的一項。`"*"` 只放行主機名稱，IP 位址、loopback 與私有網段都連不到。
- **金鑰。** 從環境變數 `TARS_SECRET` 讀，值是使用者用 `tars secret set` 存的原文，JSON 要自己解析。沒有就以宣告的結束碼結束。送審試跑（`trial`）時一定沒有金鑰，也連不到 `"secret:url"` 的主機；`external-write` 的腳本完全沒有網路。腳本要能乾淨地結束。不要印出金鑰，也不要印出含金鑰的 URL。
- **私人資訊。** 網址、帳號、ID 不寫死在腳本裡，從參數或金鑰取得。
- **輸出。** 結果寫 stdout，錯誤與進度寫 stderr。給 agent 讀的結果用一行 JSON。
- **檔案。** 只寫到環境變數 `TARS_OUT` 指的目錄，呼叫時加了 `--out` 才有。沒有 `TARS_OUT` 時，只能用 `tempfile` 寫暫存檔，執行結束就消失。其他地方都寫不進去。
- **結束碼。** 只用 0 到 123，`exit` 一定要有 0，每個用到的都寫進去。124 與 128 以上留給 tars。
- **效果。** 會在外部建立、修改或刪除東西的是 `external-write`；只寫本機檔案的是 `local-write`；其他是 `read-only`。

## 寫完先確認

- 缺必要參數時，以 2 結束並印出用法（`argparse` 預設就是這樣）。
- 沒有 `TARS_SECRET` 時，以宣告的結束碼結束，沒有 traceback。
- 服務回錯誤時，stderr 有一行說明，不印出整個回應內容。
