# 第三方授權聲明

repo 裡複製了以下第三方的檔案。各自的授權條款附在下面。

## cli-for-agents

- 位置：`.agents/skills/cli-for-agents/`、`.claude/skills/cli-for-agents/`
- 來源：https://github.com/cursor/plugins/tree/3dbd22ff12742fb28c9700b9760baa29ed41dc13/cli-for-agent
- 授權：MIT

```
MIT License

Copyright (c) 2026 Cursor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## typescript-magician

- 位置：`.agents/skills/typescript-magician/`、`.claude/skills/typescript-magician/`
- 來源：https://github.com/mcollina/skills/tree/c75d70dbfbe991d8cec42aeda0b64ff14fbb9ac7/skills/typescript-magician
- 授權：MIT

```
MIT License

Copyright (c) 2026 Matteo Collina

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## socratic-tutor

- 位置：`tars-skills/socratic-tutor/`
- 來源：https://github.com/janestreet/agent_skills/tree/7c6715c29548a3b39d4a9545c698ee4fd17a7213/socratic-tutor
- 授權：MIT

```
The MIT License

Copyright (c) 2026 Jane Street Group, LLC <opensource-contacts@janestreet.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## serenity-skill

- 位置：`tars-skills/serenity-skill/`
- 來源：https://github.com/muxuuu/serenity-skill/tree/193e409c6ec6acad8e52c29c0570470ed83e3eae
- 授權：MIT，全文在 `tars-skills/serenity-skill/LICENSE`。

## shadcn/ui

- 位置：`apps/web/src/vendor/shadcn-tailwind.css`
- 版本：`shadcn` 套件 4.23.0 的 `dist/tailwind.css`，原樣複製，sha256 `4c371f7a1ff5d219ae2f7ff28bd256b4346fd546fe46fbae22092e57db2f0fae`。`shadcn` 是 CLI，不裝進 repo。
- 元件位置：`apps/web/src/components/ui/`（`button`、`input`、`textarea`、`input-group`、`combobox`；M4-P2 加 `dialog`、`drawer`、`dropdown-menu`、`popover`、`progress`、`sheet`、`tooltip`；M4-P3b 加 `trace`、`collapsible`、`code-block`、`item`）、`apps/web/src/lib/utils.ts`
- 元件版本：在 repo 外跑 `shadcn` 4.23.0 的 `init -b base -p nova` 與 `add button input input-group combobox`（2026-11-23，樣式 `base-nova`），把產生的檔搬進來後用 `vp fmt` 重排。內容只改一處：`combobox.tsx` 從 `@base-ui/react` 的總入口匯入，改成 `@base-ui/react/combobox`（總入口在 jsdom 測試裡要轉換整個套件，第一次載入多 1.5 秒以上；建置成品不受影響）。`textarea` 是 `input-group` 匯入的。重排前的 sha256：`button.tsx` `313353436d0fcc8e`、`combobox.tsx` `ccc44c4aa4afca18`、`input-group.tsx` `492310e6d519441c`、`input.tsx` `dab990dfefa0ba78`、`textarea.tsx` `82601c91ffc6c727`。要對上游時，先把 CLI 產生的檔用 `vp fmt` 重排再比。
- M4-P2 加的元件：同一個 CLI 與設定，`add popover tooltip dialog sheet drawer dropdown-menu progress`（2026-11-24），沒有新增套件，匯入已是 `@base-ui/react/<子路徑>`。用 `vp fmt` 重排。內容改兩處：`popover.tsx` 的 `PopoverContent` 多收 `anchor` 傳給 Positioner（面板從別的按鈕升起，例如上下文環）；`sheet.tsx` 的 `SheetContent` 多收 `keepMounted` 傳給 Portal（手機的對話列表關起來仍留在頁面）。重排前的 sha256：`dialog.tsx` `7e96b921d921ee9f`、`drawer.tsx` `5d6118f4b18755bb`、`dropdown-menu.tsx` `ffd69006ed9c79e1`、`popover.tsx` `5fecff622f4eecc0`、`progress.tsx` `bae4a2c7eded93a8`、`sheet.tsx` `db422e2934b79774`、`tooltip.tsx` `f83d5f511812573f`。`button.tsx` 與 P1 的相同。
- M4-P3a 加的元件：同一個 CLI，`init -t vite -b base -p nova` 後 `add message message-scroller bubble marker`（2026-11-24），新增的套件只有 `@shadcn/react` 0.3.1（`message-scroller` 匯入它的 `@shadcn/react/message-scroller`）。用 `vp fmt` 重排。重排前的 sha256：`message.tsx` `64e9ae0f9d1e268b`、`message-scroller.tsx` `653012cfeefe555b`、`bubble.tsx` `cef49b9490c90d90`、`marker.tsx` `6b0a6a0f510ac210`。內容改三處：
  - `message-scroller.tsx` 的 `MessageScrollerViewport` 拿掉 `scroll-fade-b`（底部淡出遮罩）、`scrollbar-thin`、`scrollbar-gutter-stable`（捲軸占位，寬度會變）、`contain-content`（會裁掉 fixed 的子元素）與 `data-autoscrolling:` 的兩個捲軸顏色：都會改外觀。
  - 同檔的 `MessageScrollerItem` 拿掉 `[content-visibility:auto]` 與 `[contain-intrinsic-size:auto_10rem]`：畫面外的列先估 10rem 高，scrollHeight 先錯再修，串流中貼底會跳。
  - `bubble.tsx` 的 `bubbleVariants` 只留 `default` 與 `muted`，其他五個變體沒有用到，卻因為 `cva()` 呼叫留在首屏 JS（約 230 B gzip）。
  - 不用 Message Scroller 文件裡開啟時的行內 script：CSP 不允許。
- M4-P3c 的輸入框用 `input-group` 與 `textarea`：同一個 CLI 以 `add input-group textarea`（2026-11-24）重取，重排前的 sha256 與 P1 的相同（`input-group.tsx` `492310e6d519441c`、`textarea.tsx` `82601c91ffc6c727`），沿用 repo 裡的檔，沒有改。
- M4-P3b 加的元件：同一個 CLI，`init -t vite -b base -p nova` 後 `add trace collapsible code-block` 與 `add item`（2026-11-24），沒有新增套件。用 `vp fmt` 重排。重排前的 sha256：`trace.tsx` `f03ab1824e7312d0`、`collapsible.tsx` `3de60b605e64c835`、`code-block.tsx` `83d58cbb22cca362`、`item.tsx` `08cc237a727e1b0d`。`trace.tsx` 與 `collapsible.tsx` 原樣。內容改兩處：
  - `code-block.tsx` 只留 `CodeBlock` 與 `CodeBlockContent`：拿掉行號（連同 `style={{ counterReset }}`、`lineNumbers`、`startLine`、`CodeBlockLine`）、`CodeBlockHeader`、`CodeBlockTitle`、`CodeBlockActions`、`CodeBlockCopyButton`、`CodeBlockFooter` 與 `destructive` 變體。CLI 一起產生的 `use-highlighted-code.ts` 與 `highlighter.tsx`（shiki）沒有搬進來：工具輸出是純文字。
  - `item.tsx` 只留 `Item`、`ItemMedia`、`ItemContent`、`ItemTitle`、`ItemDescription`、`ItemActions`，變體只留 `outline` 與 `default` 尺寸，`ItemMedia` 拿掉 `image`，因此不需要 `separator.tsx`。理由同 bubble：沒用到的變體會因為 `cva()` 留在首屏 JS。
- 來源：https://github.com/shadcn-ui/ui
- 授權：MIT

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
