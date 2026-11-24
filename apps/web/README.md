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

| #   | 在哪裡            | 步驟                                                                                                                                                                                |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cloudflare 控制台 | 建 Access 應用程式保護 `<APP_HOST>`（主機名稱這時還不必存在），並替它建一條**專用的原則**（見下面「Access 的原則與登入期限」）。記下 team 網域與 `aud`                              |
| 2   | Cloudflare 控制台 | 發本機端的用戶端憑證（有效期 1 年，加標籤 `tars-serve`），下載憑證與私鑰。私鑰只顯示一次                                                                                            |
| 3   | 終端              | `tars link setup --cert <憑證檔> --key <私鑰檔>`，要輸入 `yes` 確認，所以在自己的終端執行。成功後**刪掉下載的私鑰檔**。憑證與私鑰只在 keyring 裡，下載的檔案刪掉不影響 `tars serve` |
| 4   | 終端              | 設 Worker 的 secret、建置並部署（見下面「Worker」）。Worker 要先存在，下一步才能加自訂網域                                                                                          |
| 5   | Cloudflare 控制台 | 在 Worker 的「網域」加兩個自訂網域：`<APP_HOST>`、`<LINK_HOST>`。替 `<LINK_HOST>` 開 mTLS（主機清單**只放它**），加 WAF 規則擋沒有憑證的請求（見下面「用戶端憑證的 WAF 規則」）     |
| 6   | Cloudflare 控制台 | 在網域既有的封鎖規則裡，替這兩台主機加國別的例外（見下面「封鎖規則的例外」）                                                                                                        |
| 7   | 終端              | 填 `config.toml` 的 `[link]`（見下面「本機端的設定」），`tars link status` 顯示「[link]：齊全」                                                                                     |
| 8   | 終端              | `tars llm key set <provider>`（已設過的不用重做）、`tars models refresh`、填價目、啟用模型                                                                                          |
| 9   | 終端              | 入庫通知腳本，設 `[notify]`（範本在 `examples/scripts/bark-push/`）                                                                                                                 |
| 10  | 終端              | `tars serve`。另開一個終端跑 `tars serve status`，每一項都正常。登入網頁一次，確認日誌裡登入的期限和第 1 步設的值相符（見下面「Access 的原則與登入期限」）                          |

任何一項缺了，`tars serve` 啟動時印出缺哪一項並結束。keyring 裡沒有憑證時它不連線，每 60 秒重讀一次，`tars serve status` 顯示「keyring 讀不到」。

### 用戶端憑證的 WAF 規則

mTLS 只是讓邊緣向對方要憑證，**不擋沒有憑證的請求**。要加一條自訂規則，動作 Block：

```
(http.host eq "<LINK_HOST>" and not cf.tls_client_auth.cert_verified)
```

- mTLS 的主機清單只放 `<LINK_HOST>`。放進 `<APP_HOST>` 的話，瀏覽器登入時邊緣也會要求出示用戶端憑證，裝過憑證的裝置會跳出選憑證的對話框。
- 沒有憑證打 `<LINK_HOST>`，預期 403。

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

### 圖示

`public/` 的 PNG 已提交，建置不需要產生它們。換圖時在 `apps/web/` 重新產生。`<ASSETS>` 是素材目錄，需要 `rsvg-convert` 與 ImageMagick 的 `magick`。

來源一律用 24×24 的 SVG，不用 512 的 PNG 縮放：512 不是 24 的整數倍，從它縮會多一次誤差。

```sh
cp <ASSETS>/tars-icon-idle-transparent.svg public/favicon.svg
cp <ASSETS>/tars-icon-idle-512x512-pwa.png public/icons/icon-512.png
rsvg-convert -w 192 -h 192 <ASSETS>/tars-icon-idle-pwa.svg -o public/icons/icon-192.png
rsvg-convert -w 32 -h 32 <ASSETS>/tars-icon-idle-transparent.svg -o public/favicon-32.png
rsvg-convert -w 16 -h 16 <ASSETS>/tars-icon-idle-transparent.svg -o public/favicon-16.png
rsvg-convert -w 168 -h 168 <ASSETS>/tars-icon-idle-pwa.svg -o touch-168.png
magick -size 180x180 xc:'#0d9488' touch-168.png -gravity center -composite PNG24:public/apple-touch-icon.png
rm touch-168.png
cp <ASSETS>/tars-sprite-wheel.svg <ASSETS>/tars-sprite-idle.svg src/assets/
```

- 180 是 ×7 的圖疊在滿版青綠（`#0d9488`）上，不透明（PNG 色彩類型 2）。iOS 把透明處顯示成白色，自己裁圓角，所以這張不留透明的邊與圓角。`public.test.ts` 檢查它。
- `icons/` 的 192 與 512 仍有透明圓角。iOS 用 `apple-touch-icon`，不用它們；Android 與桌面安裝會用。
- 32 與 16 不是 24 的整數倍，像素寬窄會不一，換圖後要用眼睛看過。

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
- 在 Worker 加 `<APP_HOST>` 的自訂網域時出現「已有外部管理的 DNS 記錄」：這個主機名稱在 DNS 已有一筆記錄（例如指向已不存在的 Tunnel 的 CNAME）。確認不再使用後刪掉那筆，再加自訂網域。
- Worker 的「網域」分頁剛加完時可能還是空的。以 DNS 頁顯示「Worker → `tars-web`」為準。
- 網頁的對話清單很長時，開著對話會把清單收起來，摘要列寫「目前：<標題>」。點摘要可以展開。

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

## 樣式

網頁正在換成 Tailwind 4 加 shadcn/ui 的 Base UI 版（`base-nova`），分階段進行。P0 接上工具鏈與樣式，P1 加表單的元件，P2 把手寫的浮層換成 shadcn 的。並存期間：

- `src/index.css` 先載入 Tailwind 與 shadcn 的樣式，全部在 CSS layer 裡。`src/styles.css`（簽核原型的樣式）與 `src/app.css` 後載入，不在 layer 裡，所以既有畫面不變。不要把 `styles.css` 包進 layer，畫面會走樣。
- Tailwind 不掃既有的標記（`source(none)`），否則 `hidden` 這類普通的類別名稱會變成 utility。加元件的階段在 `index.css` 為它們的目錄加 `@source`。
- 顏色沿用原型：`index.css` 的 `@theme inline` 把 shadcn 的變數名對到 `styles.css` 的變數。
- 焦點外框：`styles.css` 的 `:focus-visible` 外框在 `@layer base` 裡（M4-P2）。放在 layer 外時，它蓋過 shadcn 元件自己的 `outline-none`，元件會有兩圈外框；放進 layer 後元件的 utility 勝出，只剩它自己的那圈。原型裡自己設外框的規則本來就比它具體，畫面不變。
- 浮層（M4-P2）：`src/components/Panel.tsx` 把原型的面板（標題列、內容、底列）放進 shadcn 的浮層。手機（767 px 以下）是底部的 Drawer；較寬時有錨點就是 Popover（例如上下文環、模型按鈕），沒有就是置中的 Dialog。模型與推理強度在桌面是 DropdownMenu 的單選群組，手機是 Drawer。對話列表在 1023 px 以下是 Sheet，關起來仍留在頁面左緣外、帶 `inert`，Tab 與螢幕閱讀器都碰不到。原型的外觀由原型的類別給；`app.css` 末段只抵銷浮層自帶的 utility，並照原型的方式定尺寸。
- `shadcn` 套件不裝進 repo（它會帶進 `osv-scanner` 擋的漏洞）。`src/vendor/shadcn-tailwind.css` 是它的樣式檔原樣複製，版本記在 `THIRD_PARTY_NOTICES.md`；`vendor/` 不重排格式，才能和上游逐位元組比對。

### 畫面比對

換樣式的階段要證明畫面沒變時，跑 `tools/visual/`。它對 `ui_spec.md` 第 7 節的 15 個場景，在桌面 1280 px 與手機 390 px 兩種寬度下截圖，和基準（預設 `main`）逐像素比對：

```
cd apps/web
node tools/visual/run.ts               # 基準是 main
node tools/visual/run.ts --base <ref>  # 換基準
node tools/visual/run.ts --only 7      # 只跑場景 7
node tools/visual/run.ts --control     # 基準和自己比，看雜訊有多少
```

場景 17–19 打開浮層（M4-P2）。它們用 `data` 借前面場景的資料，只多幾個步驟，所以沒有這幾個場景的基準也畫得出來。

- 要 Node 24 以上與 Chromium（預設 `/usr/bin/chromium`，可用 `CHROMIUM` 換）。需要瀏覽器，所以不在 `bun run check` 裡。
- 場景頁只在這個工具的建置裡：`tools/visual/fake.ts` 是假的本機端，插在 `main.tsx` 之前，App 本身照常載入。資料與步驟在 `tools/visual/scenes.ts`，都是虛構的。
- 頁面用 `headers.ts` 的 CSP 提供。基準沒有的 CSP 違規與頁面錯誤算失敗，基準也有的另列（例如 zod 4 用 `Function("")` 試探能不能 eval，`main` 就有）。
- 場景的步驟做不到，不論是基準還是這棵樹，一律算失敗：那張截圖畫的不是該場景，比對沒有意義。報表列出場景、哪一邊與哪個步驟。
- 不是逐位元組比對：一個像素的 R、G、B 差值加起來超過 6 才算不同。同一頁畫兩次，文字與半透明層的混色會差一兩階，看不出來；這個容忍度吸收它。設計稿的工具驗過：同一頁比自己 0.00%，只加一條字距規則 15%–23%。
- 雜訊：`--control` 兩次實測的最大差異是 0.04% 與 0.01%，來自狀態列的延遲毫秒數。
- 結果在 `.visual/report.md`，開頭寫兩邊的 commit。截圖在 `.visual/shots/base/` 與 `.visual/shots/head/`。任一張差異超過 0.5% 就失敗，要人看兩張截圖。`--only` 給了不存在的場景時報錯，退出碼 2。

### CSP、浮層與記帳表單的 Combobox

**每個階段合併前都要跑，退出碼必須是 0。** 階段的驗收清單要列這一項。焦點圈、Tab 不跑出浮層、斷點切換與核准卡的可讀性，只有這裡查得到：jsdom 不因 Tab 移動焦點，也不排版。

它不在 `bun run check` 裡：要 Chromium，還要建置兩次，跑一次要幾分鐘。`bun run check` 要能在沒有瀏覽器的環境跑完，所以不放進去。

```
cd apps/web
node tools/visual/csp.ts
```

- 用 `headers.ts` 的 CSP 提供場景頁，在桌面與手機兩種寬度打開「記帳表單（A2UI）」場景。在兩個帳戶欄位分別打中文與英文、選取，填完金額與摘要後送出。
- 有任何 CSP 違規或頁面錯誤，或 `ui.submit` 帶的不是英文帳戶名，就失敗（退出碼 1）。
- 只排除 zod 4 的 eval 試探（`main` 就有）：`script-src` 擋 `eval`、發生在首屏入口檔、行與欄正好落在 zod 的試探程式碼上，而且每次載入最多一筆。zod 升級後那段程式碼變了，工具會報錯要你更新 `tools/visual/page.ts` 的 `PROBE_CODE`。
- 截圖在 `.visual/csp/`。和畫面比對一樣需要 Chromium，不在 `bun run check` 裡。
- 「記帳表單」是場景 16。拿 P1 之前的基準跑 `run.ts` 時，基準沒有這個場景，場景 16 會算失敗；比的是前 15 個場景。
- 接著在兩種寬度逐一打開每個浮層（M4-P2）：用 Enter 與空白鍵各開一次，查焦點進到裡面、Tab 不跑出去（選單例外：照 WAI-ARIA 的選單模式，Tab 會離開並關閉）、Esc 與按外面會關、焦點回到按鈕；手機上還查是底部 Drawer、外面那一點按到的是遮罩而不是頁面、欄位是 16 px。在桌面打開會變 Drawer 的浮層後把視窗縮到 390 px 再放回：每次都只有一個浮層開著、焦點在裡面，關掉後沒有多出 aria-hidden 或 inert。狀態面板開著時推一張待核准卡：公告與拿到焦點的拒絕鈕都不在 aria-hidden 或 inert 底下，也都在 Chromium 的無障礙樹裡（`tools/visual/fake.ts` 的 `visualPush` 送這張卡）。最後在桌面收起對話列表，查選單按鈕的提示在鍵盤聚焦時出現、按 Esc 消失。jsdom 不會因 Tab 移動焦點，也不排版，這些只能在這裡查。失敗時截圖存在 `.visual/csp/`。

### 下拉重新整理

改了對話串的捲動、`src/usePullToRefresh.ts` 或浮層之後跑：

```
cd apps/web
node tools/visual/pull.ts
```

- 用 CDP 的 `Input.dispatchTouchEvent` 真的拖曳（Playwright 的 `page.touchscreen` 只能點）。
- 手機寬度、觸控裝置：
  - 對話串末尾插入純文字段落撐長，手指往下、往上拖，對話串照常捲動，不重新載入。
  - 回到頂端拉 40 px 放開，不重新載入。
  - 跟手：手指拉 60 px 時，標題列與對話串下移 30 px，輸入列不動。手指拉 400 px 時，下移到上限 120 px。
  - 未過門檻放開：80 ms 時還在回彈途中，之後回到 0。
  - 拉 140 px（下移 70 px）時顯示「放開重新整理」。放開後先往 56 px 收；工具在放開後 90 ms 讀 transition 的終點來確認這一點，接著重新載入。
  - 「下拉重新整理」「放開重新整理」「重新整理中…」三種狀態下，指示盒與文字的位置和高度都相同，文字只佔一行。
  - 截圖：`pull-half.png`（拉到一半）、`pull-ready.png`（過門檻）、`pull-released.png`（放開後）。
  - 知識庫的頁面拉 140 px 放開，也重新載入。
  - 重新載入後還在同一個對話（`src/kept.ts` 存在 sessionStorage 的 `tars.page`）；知識庫的頁面重新載入後，等 `wiki.status` 回來，回到知識庫的同一頁。
  - `tools/visual/overlays.ts` 的每種浮層開著時拉 140 px，都不重新載入。手機寬度和桌面寬度各測一次；桌面寬度也用觸控，模擬 iPad。同時確認 Base UI 在 `#root` 加了 `data-base-ui-inert`，下拉的判斷就是讀這個標記。
  - 下拉中來了核准卡：`role=alert` 的公告和指示列的 `role=status` 都在無障礙樹裡。
- 桌面寬度：滑鼠拖曳與滾輪不出現指示列，也不重新載入。
- CSP 違規與頁面錯誤的判斷和 `csp.ts` 相同。截圖在 `.visual/pull/`。需要 Chromium，不在 `bun run check` 裡。
- iPhone Safari 的橡皮筋效果和 `preventDefault` 怎麼互動，Chromium 測不到，要在手機上試。

### 對話串的捲動

改了對話串的捲動（`src/components/ui/message-scroller.tsx`、`App.tsx` 的 `MessageScroller*`）、對話串的列或 `tools/visual/fake.ts` 之後跑：

```
cd apps/web
node tools/visual/scroll.ts               # 長對話的計時和 main 比
node tools/visual/scroll.ts --base <ref>  # 換基準
node tools/visual/scroll.ts --no-timing   # 不計時
```

- 用 `scenes.ts` 裡兩個標了 `measure` 的場景（`run.ts` 與 `zoom.ts` 跳過它們）：
  - 「串流」：24 組舊對話（快照最多 50 項）加一個提問。第一組只有回覆，沒有它的提問，像本機端按項目數切頁那樣切在群組中間；提問在更早的那一頁。打開後，`fake.ts` 每 50–100 ms 送一段 `delta`，共 400 段。
  - 「200 組」：只用來計時。
  - 「壓縮過」兩個：只用來量 (c)。
- 桌面寬度用滑鼠滾輪，手機寬度用 CDP 的 `Input.dispatchTouchEvent` 分段拖曳。每種寬度都查：
  - (a) 在底部時跟著串流：3 秒內在 `requestAnimationFrame` 上取樣，每一格記下 `performance.now()`、離底距離與 scrollHeight。判定見下面的「跟隨的判定」。
  - (b) 串流中往上捲 200 px（拖曳時串流仍在長，手機上手指剛動時還在底部 24 px 內，那一段會被跟隨吃掉，所以只要求放開時離底至少 50 px）：2 秒內位置不動；「捲到最新訊息」出現在對話串內、不壓到輸入列。按下後 1 秒內回到底部（時間從頁面內 click 事件的 `performance.now()` 算起），之後 1.5 秒照「跟隨的判定」。
  - (b) 不經滾輪、觸控、按鍵往上捲（腳本 `scrollTop -= 300`，等同拖捲軸、頁內搜尋、iOS 點狀態列）：之後 1.2 秒每一格量離底距離。回覆在下面繼續長，離底只會變大；只要有一格比前一格小 1 px 以上，就算被拉回。「捲到最新訊息」要出現，按下後的判定同上。
  - 串流中來了工具列，按 Enter 展開，再按「展開其餘」：兩段各 1.2 秒，照「跟隨的判定」。之後往上拖 200 px，2 秒內位置不動。
  - 鈕的狀態用輪詢等到 `data-active` 變成預期值，最多 3 秒。按鈕前先確認它 active、不是 inert，中心點按到的是它自己；不是的話，直接報出當時的狀態，不等 Playwright 的 click 逾時。
  - 往上捲時來了核准卡（`visualPush`）：有公告，焦點在拒絕鈕。拒絕鈕在對話串的可見範圍內，那一點按到的是拒絕鈕本身，沒被「捲到最新訊息」蓋住。
  - (c) 用腳本捲到頂，按「載入更早的訊息」：補上的那頁帶著第一組的提問。原本看的那一列（第一組）top 前後差要小於 2 px。另外兩個場景是壓縮過的對話，第一列是「模型已看不到以下的原文」提示行，第一頁分別切在群組邊界與群組中間，同樣量開著與關掉 anchoring。量兩次：一次開著瀏覽器的 scroll anchoring，一次設 `overflow-anchor: none`，只靠 Message Scroller。Safari 沒有 scroll anchoring，第二次是對 Safari 的推論，不是實測。
- 跟隨的判定（M4-P3b 起）：連續離底超過 24 px 的一段，從第一格到回到 24 px 內的那一格，用格的時間戳算，不能超過 150 ms；最後 150 ms 內要有一格在 24 px 內；捲動位置不能自己往上跳。失敗時，印出最長一段前後各 3 格的時間、格距、離底距離與高度，整段存到 `.visual/scroll/traces.json`。
  - 舊的判定：(a) 連續最多 2 格，工具列展開時最多 3 格；按「捲到最新訊息」等 800 ms 後只讀一次離底距離。
  - 為什麼改：量到的離底都來自同一個原因。串流每段 `delta` 讓內容長高約 33 px，Message Scroller 在 ResizeObserver 之後的下一格才捲，所以內容長高的那一格離底約 33 px，是函式庫結構上固定晚一格。兩段 `delta` 靠得近，或展開與 `delta` 落在相鄰的格，就會連續 3–4 格（50–67 ms）。機器忙時，格距從 16.7 ms 拉到 33 ms 以上，同樣的晚一格就變成更多格。按鈕那項只讀一次，剛好讀到長高的那一格就是 33 px。舊判定數的是格數與單次讀數，所以每輪靠運氣。
  - 為什麼 150 ms 不是放寬：這是看得出的滑動，大約 9 格。真的停止跟隨時，離底會一直長，結束時也不在底部，新判定照樣失敗。反向檢查見 M4-P3b 的回報。
- 200 組計時：從按下對話到 200 組畫出來，以及到頁面能再接受輸入（那一格之後的下一個 task）。和基準的樹比，基準用這個分支的 `fake.ts` 與 `scenes.ts` 建置。各量 5 次取中位數；手機寬度把 CPU 降到 1/4。
- CSP 違規與頁面錯誤的判斷和 `csp.ts` 相同。截圖（`*-follow.png`、`*-up.png`、`*-card.png`、`*-tool-open.png`）在 `.visual/scroll/`。需要 Chromium，不在 `bun run check` 裡。
- iPhone Safari 上的慣性捲動、網址列收合時 scrollHeight 的變化與橡皮筋效果，Chromium 都測不到。

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

## iPhone 的自動放大

iOS Safari 在小於 16px 的輸入欄位取得焦點時會放大頁面，放大後頁面比螢幕寬，送出鈕會被擠出畫面。`src/app.css` 末尾的規則讓觸控裝置上所有輸入欄位都是 16px。`node tools/visual/zoom.ts` 用手機寬度、觸控裝置開每個場景，列出小於 16px 的欄位與比螢幕寬的頁面；新增輸入欄位或新階段合併前要跑，退出碼要是 0。
