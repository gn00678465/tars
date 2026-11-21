# tars 的遠端入口

擁有者在手機的瀏覽器上和本機的 tars 對話，並核准腳本。這個目錄是網頁與轉送層；本機端在 `src/features/serve/`，兩邊共用的訊息定義在 `packages/protocol/`。

```
手機的瀏覽器 ── Access ──> <APP_HOST>/ws ──┐
                                             ├─ Worker ─ Durable Object（轉送）
tars serve ── 用戶端憑證（mTLS）──> <LINK_HOST>/link ──┘
```

- 瀏覽器經 Cloudflare Access 登入，連 `<APP_HOST>`。Worker 驗 Access JWT 與 `Origin`。
- `tars serve` 用用戶端憑證連 `<LINK_HOST>`。Worker 驗憑證的指紋。
- Durable Object 只轉送。本機端自己再驗一次每個瀏覽器的 JWT，不信任轉送層。

這份文件的值都是佔位符。repo 是公開的，實際的網域、email、`aud`、指紋不寫進任何檔案。

| 佔位符            | 意思                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `<OWNER_DOMAIN>`  | 擁有者在 Cloudflare 上的網域                                     |
| `<APP_HOST>`      | 網頁的主機，例如 `app.<OWNER_DOMAIN>`                            |
| `<LINK_HOST>`     | 本機端連的主機，例如 `link.<OWNER_DOMAIN>`                       |
| `<TEAM>`          | Access 的 team 名稱（team 網域是 `<TEAM>.cloudflareaccess.com`） |
| `<ACCESS_AUD>`    | Access 應用程式的 `aud`                                          |
| `<OWNER_EMAIL>`   | 擁有者登入 Access 的 email                                       |
| `<FINGERPRINT>`   | 用戶端憑證的 SHA-256 指紋，`tars link status` 會印出             |
| `<TARS_DATA_DIR>` | tars 的資料目錄，預設 `~/.local/share/tars`                      |

## 首次設定

每一步都由擁有者自己做。agent 不登入 Cloudflare、不部署、不碰憑證與 keyring。

| #   | 在哪裡            | 步驟                                                                                                                                                       |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cloudflare 控制台 | 在 `<OWNER_DOMAIN>` 建兩個主機名稱：`<APP_HOST>`、`<LINK_HOST>`                                                                                            |
| 2   | Cloudflare 控制台 | 在網域既有的封鎖規則裡，替這兩台主機加國別的例外（見下面「封鎖規則的例外」）                                                                               |
| 3   | Cloudflare 控制台 | 建 Access 應用程式保護 `<APP_HOST>`，並替它建一條**專用的原則**（見下面「Access 的原則與登入期限」）。記下 team 網域與 `aud`                               |
| 4   | Cloudflare 控制台 | 發本機端的用戶端憑證，替 `<LINK_HOST>` 開 mTLS，加一條 WAF 規則擋下沒有憑證的請求                                                                          |
| 5   | 終端              | `tars link setup --cert <憑證檔> --key <私鑰檔>`，成功後**刪掉下載的私鑰檔**。私鑰已經在 keyring 裡，磁碟上那份只剩外洩的風險                              |
| 6   | 終端              | 填 `config.toml` 的 `[link]`（見下面「本機端的設定」），`tars link status` 顯示「[link]：齊全」                                                            |
| 7   | 終端              | 設 Worker 的 secret 並部署（見下面「Worker」）                                                                                                             |
| 8   | 終端              | `tars llm key set <provider>`（已設過的不用重做）、`tars models refresh`、填價目、啟用模型                                                                 |
| 9   | 終端              | 入庫通知腳本，設 `[notify]`（範本在 `examples/scripts/bark-push/`）                                                                                        |
| 10  | 終端              | `tars serve`。另開一個終端跑 `tars serve status`，每一項都正常。登入網頁一次，確認日誌裡登入的期限和第 3 步設的值相符（見下面「Access 的原則與登入期限」） |

任何一項缺了，`tars serve` 啟動時印出缺哪一項並結束。keyring 裡沒有憑證時它不連線，每 60 秒重讀一次，`tars serve status` 顯示「keyring 讀不到」。

### 封鎖規則的例外

網域上已經有一條自訂的封鎖規則，對網域內所有主機生效，擋三類請求：來源國不是台灣；Cloudflare 認定的機器人，或 `User-Agent` 含常見的程式庫名稱；`User-Agent` 不含 `/`。

不加例外的話，擁有者人在台灣以外時手機連不上 `<APP_HOST>`，電腦帶出國時 `tars serve` 也連不上 `<LINK_HOST>`。決定是兩台主機不受國別條件限制，機器人與 `User-Agent` 的條件照舊（D33）。`<APP_HOST>` 有 Access 的登入、`<LINK_HOST>` 有用戶端憑證，所以國別過濾對它們不是唯一的防線。代價是兩台主機對全世界可達，Access 的登入頁會收到台灣以外的嘗試。

這條規則是擁有者的既有設定。tars 的程式、`wrangler` 的設定與 agent 都不碰它，由擁有者在控制台自己改。

**做法：只改國別那一項。** 改之前先把整段原本的運算式複製存起來。

原本國別的那一項：

```
(ip.geoip.country ne "TW")
```

改成：

```
(ip.geoip.country ne "TW" and not http.host in {"<APP_HOST>" "<LINK_HOST>"})
```

其餘用 `or` 接著的各項（`cf.client.bot`、`http.user_agent` 的那幾項）一個字都不動。主機名稱寫實際的值。

沒有採用的做法：在前面加一條「略過」的規則。它略過的是整條規則，機器人與 `User-Agent` 的條件也會一起失效，還可能略過 `<LINK_HOST>` 的 mTLS 封鎖規則。

改完之後做四項檢查：

1. 在台灣：手機開 `<APP_HOST>`，看得到 Access 的登入；`tars serve` 連得上 `<LINK_HOST>`。
2. 台灣以外的來源（VPN，或控制台的規則追蹤工具）：`<APP_HOST>` 到得了 Access 的登入頁；網域裡其他主機仍然被擋。
3. 沒有 `User-Agent`、或 `User-Agent` 不含 `/` 的請求打這兩台主機，仍然 403。
4. 沒有用戶端憑證的請求打 `<LINK_HOST>`，仍然 403（mTLS 的那條規則沒有受影響）。

- 〔未確認〕上面的運算式照 Cloudflare 規則語言的文件寫，沒有在擁有者的網域上試過。以這四項檢查的結果為準。
- 這條規則造成的 403 來自 Cloudflare 的邊緣，Worker 的日誌看不到。
- `tars serve` 送的 `User-Agent` 是 `tars-serve/<版本>`，含 `/`，所以第 3 項的條件不會擋它。

### Access 的原則與登入期限

- 原則只放行 `<OWNER_EMAIL>`。
- **登入期限（session duration）設成數小時**，建議 4 到 8 小時。應用程式層最短可以設 15 分鐘。
- **替 `<APP_HOST>` 建一條專用的原則，不重用共用的原則。** 原則的期限會覆寫應用程式的期限：重用共用的原則時，這裡設的值不會生效。
- 為什麼要短：這個期限同時是「手機被拿走」與「本機端憑證外洩」兩種情況下，對方能冒充擁有者的最長時間。

設完後登入網頁一次，看本機端的日誌 `<TARS_DATA_DIR>/agent/log.jsonl` 裡 `event` 是 `conn`、`state` 是 `open` 的那一行：它的 `ms` 是這次登入還剩多少毫秒，應該接近設的期限。

### 本機端的設定

`config.toml` 的範本裡 `[link]` 與 `[notify]` 整段是註解。拿掉註解並填值：

```toml
[link]
url = "wss://<LINK_HOST>/link"
access_team_domain = "<TEAM>.cloudflareaccess.com"
access_aud = "<ACCESS_AUD>"
owner_email = "<OWNER_EMAIL>"

[notify]
script = "<通知腳本的名稱>"
args = ["--title", "{title}", "--body", "{body}"]
on_connect = true
```

- `[link]` 的四個值都要有。值裡還有 `<` 或 `>` 時，`tars serve` 當成沒填。
- `tars link setup` 只存憑證與私鑰，不改 `config.toml`。
- `[notify] args` 裡只認 `{title}` 與 `{body}`，各自整個換成固定的文字。通知的內容不含 argv 與對話內容。

### Worker

設定：

| 名稱                               | 種類   | 內容                                                                   |
| ---------------------------------- | ------ | ---------------------------------------------------------------------- |
| `APP_HOST`、`LINK_HOST`            | 變數   | 兩個主機名稱                                                           |
| `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` | 變數   | `<TEAM>.cloudflareaccess.com`、`<ACCESS_AUD>`                          |
| `OWNER_EMAIL`                      | secret | `<OWNER_EMAIL>`                                                        |
| `LINK_CERT_FINGERPRINTS`           | secret | 允許的憑證指紋，逗號分隔，最多兩個。值用 `tars link status` 印出的指紋 |

`wrangler.jsonc` 裡的變數只有佔位符，不要把實際的值提交進 repo。

建置與部署（在 `apps/web/`，擁有者自己的終端）：

```sh
npx wrangler secret put OWNER_EMAIL
npx wrangler secret put LINK_CERT_FINGERPRINTS
APP_HOST=<APP_HOST> npx vp build
npx wrangler deploy \
  --var APP_HOST:<APP_HOST> --var LINK_HOST:<LINK_HOST> \
  --var ACCESS_TEAM_DOMAIN:<TEAM>.cloudflareaccess.com --var ACCESS_AUD:<ACCESS_AUD>
```

- 建置時要有 `APP_HOST`。網頁的 CSP（`_headers`）在建置時由它產生，沒設就建置失敗。
- 〔未確認〕`wrangler deploy --var` 能不能蓋過建置產生的設定裡的佔位符，沒有試過。部署後在控制台看 Worker 的變數是不是實際的值。

## 憑證輪替

除了重啟 `tars serve` 的那幾秒，網頁一直能用。

1. 在 Cloudflare 發新的用戶端憑證 B。
2. 把 B 的指紋加進 Worker 的 `LINK_CERT_FINGERPRINTS`（逗號分隔，這時舊的 A 與 B 都接受），重新部署。
3. `tars link setup --cert <B 的憑證檔> --key <B 的私鑰檔>`，成功後刪掉 B 的私鑰檔。
4. 重啟 `tars serve`。
5. `tars link status`：指紋是 B 的。`tars serve status`：已連上。
6. 從 `LINK_CERT_FINGERPRINTS` 移除 A 的指紋，重新部署。在 Cloudflare 撤銷 A。

- 憑證到期前 30 天，`tars link status` 開始警告。
- 私鑰外洩時不用等輪替，直接在 Cloudflare 撤銷，再照上面發新的。

## 被另一台取代時

`tars serve status` 顯示「本機端連線被另一台取代」，或手機收到「TARS 的本機端連線被另一台取代」的推播：有另一台機器拿同一張憑證先連上了 `<LINK_HOST>`。

- 網頁這時顯示本機端在線，但對面不是你的電腦。不要在網頁上輸入任何東西。
- 到 Cloudflare 撤銷那張憑證，再照「憑證輪替」發新的。
- `tars serve` 不會結束，每 5 分鐘重試一次。對方的連線被撤銷擋下之後，下一次重試就會連上。
- 網頁的狀態列也會一直顯示「本機端在 <時間> 重新連上」。那個時間不是你自己重啟的時候，就是被換過。

## 疑難排解

- `tars link setup` 執行到一半被中斷，或同時執行兩次時，keyring 裡的憑證與私鑰可能不成對：`tars serve` 連不上 `<LINK_HOST>`，`tars serve status` 顯示連線失敗。重新執行一次 `tars link setup` 即可恢復。

## 常駐

只支援已登入的桌面 session：keyring 要已解鎖，要有 D-Bus。`systemd --user` 的 unit 範本，放在 `~/.config/systemd/user/tars-serve.service`：

```ini
[Unit]
Description=tars serve
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=%h/.local/bin/tars serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=graphical-session.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now tars-serve.service
```

`tars serve` 和 `tars chat` 用同一把鎖，不能同時執行。要在終端用 `tars chat` 時先停掉這個服務。

## 手動驗收

這些項目自動測試涵蓋不到，由擁有者在自己的 Cloudflare 與手機上做。結果寫回 `research/cloudflare-tunnel-mtls.md`。行為和設計不同時，記下請求與回應的形狀（不含 JWT、cookie、email、憑證內容）。

**S3 的驗收六條：**

1. 用手機、真的 Access 與通知腳本，從頭到尾完成一次要核准的腳本執行。
2. 重啟 `tars serve`：網頁自己重連並拿到快照。
3. 兩台裝置都開網頁：一台核准，另一台顯示「在別處決定」。
4. 拒絕的路徑各做一次：
   - `curl` 不帶用戶端憑證連 `<LINK_HOST>`，預期 403。
   - 改了 `Origin` 標頭的升級請求打 `<APP_HOST>/ws`，預期 403。
   - 用另一個 email 登入 Access，預期連不上。
5. 照這份文件的首次設定做一遍，能通。
6. 照「憑證輪替」做一遍，網頁除了重啟的那幾秒都能用。

**另外要量與記下的：**

- Worker 用 team 的公鑰驗 JWT：正常登入連得上；把 Worker 的 `ACCESS_AUD` 設錯，升級請求被拒。
- 登入過期時連線怎麼樣：用專用的原則把登入期限設成 15 分鐘，開著網頁等到期。
  - 連線還在：本機端在到期時請轉送層關掉它，網頁顯示「登入已過期，請重新整理」。
  - 連線被 Cloudflare 切斷：網頁送一個同源的請求來判斷，顯示同樣的文字。記下 Access 對那個請求回的是轉址、401 還是 403。
- 專用的 Access 原則：日誌裡登入的期限和設的值相符。
- 關掉網路介面再打開：`tars serve` 多久重新連上。通過線 30 秒。
- 閒置一段時間之後送訊息，連線仍可用（Durable Object 休眠後連線還在）。
- 手機的 Safari 與 Chrome 各連一次，瀏覽器的主控台沒有 CSP 的違規訊息。
- 第二台機器用同一張憑證連 `<LINK_HOST>`：
  - 你的本機端在線時，它被關掉。
  - 你的本機端離線時，它連得上；之後你的本機端啟動會收到推播，網頁出現「重新連上」的警示。
  - 撤銷憑證後，你的本機端在下一次重試時連上。
- 把筆電闔上，多久之後網頁顯示本機端離線。
- Durable Object 喚醒後第一則訊息的延遲；開著網頁一小時，連線被切斷幾次；一天收到幾則新連線的推播。
