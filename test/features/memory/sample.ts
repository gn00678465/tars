import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SAMPLE = `# 記憶

<!-- 規則：只有帶 id 註解的條目由 tars memory 修改，其餘逐字保留。 -->

## 偏好

<!-- id: pref-tabs | observed: 2026-01-02 | status: superseded -->
- 縮排用 tab。

<!-- id: pref-tabs | observed: 2026-01-05 | status: active -->
- 縮排用兩個空白。

<!-- id: pref-short | observed: 2026-01-03 | status: active | source: user -->
- 回覆先講結論。

手寫的備註，沒有 id。

## 決定

<!-- id: dec-editor | observed: 2026-01-04 | status: active -->
- 編輯器用 Helix。
- 設定檔放 dotfiles。

## 去哪裡找

<!-- id: ref-notes | observed: 2026-01-06 | status: active -->
- 筆記在 notes 目錄。
`;

/** A fresh MEMORY.md in its own temp dir. */
export function sampleMemoryFile(content = SAMPLE): string {
  const path = join(mkdtempSync(join(tmpdir(), "tars-memory-")), "MEMORY.md");
  writeFileSync(path, content);
  return path;
}
