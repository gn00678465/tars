import type { WikiList, WikiPage, WikiSearch, WikiStatus } from "@tars/protocol";

// Made-up knowledge-base answers for the tests and the preview page.

export const REF = "0a1b2c3d/4e5f6a7b";
export const REF2 = "0a1b2c3d/99887766";

export const STATUS: WikiStatus = {
  synced: true,
  counts: { people: 1, projects: 2, topics: 0, life: 0, learning: 1, investment: 0 },
  total: 4,
  examples: ["備份腳本", "FTS5", "王小明"],
  lastSyncAt: new Date(2026, 10, 22, 13, 15).getTime(),
  indexedAt: new Date(2026, 10, 22, 13, 12).getTime(),
};

export const LIST: WikiList = {
  pages: [
    { path: "projects/nas-backup", title: "NAS 備份腳本", updated: "2026-11-22", blocked: false },
    { path: "people/wang-xiaoming", title: "王小明", updated: "2026-11-21", blocked: false },
    { path: "learning/sqlite-fts5", title: "SQLite FTS5", updated: "2026-11-15", blocked: false },
    { path: "projects/broken", title: "broken", updated: "", blocked: true },
  ],
  more: false,
};

export const PAGE: WikiPage = {
  state: "ok",
  path: "projects/nas-backup",
  title: "NAS 備份腳本",
  aliases: ["備份腳本"],
  created: "2026-11-01",
  updated: "2026-11-22",
  summary: `每晚把 NAS 同步到外接硬碟 [[source:${REF}]]，保留 30 天。`,
  facts: [
    {
      id: "i1",
      text: "排程在每天 03:00 執行 rsync",
      assistant: false,
      verified: true,
      sources: [REF],
    },
    {
      id: "i2",
      text: "<img src=https://example.invalid/x.png> 手動改過的一條",
      assistant: true,
      verified: false,
      sources: [REF2],
    },
  ],
  open: [{ id: "i3", text: "要不要改成增量備份", assistant: false, verified: false, sources: [] }],
  related: ["learning/sqlite-fts5", "topics/gone"],
  changeLog: [
    { date: "2026-11-22", text: "新增 [i2]" },
    { date: "2026-11-01", text: "建立頁面" },
  ],
  truncated: false,
};

export const SEARCH: WikiSearch = {
  query: "備份",
  pages: {
    indexedAt: new Date(2026, 10, 22, 13, 12).getTime(),
    results: [
      {
        path: "projects/nas-backup",
        title: "NAS 備份腳本",
        updated: "2026-11-22",
        section: "facts",
        item: "i1",
        snippet: "排程在每天 03:00 執行 rsync 備份",
      },
    ],
  },
  records: {
    indexedAt: new Date(2026, 10, 22, 13, 12).getTime(),
    results: [
      {
        conv: "0a1b2c3d-0000-4000-8000-000000000001",
        convTitle: "NAS 備份怎麼排",
        turnNo: 2,
        at: new Date(2026, 10, 22, 13, 12).getTime(),
        speaker: "owner",
        snippet: "備份要每晚跑",
      },
      { at: new Date(2026, 10, 20, 9, 0).getTime(), speaker: "assistant", snippet: "舊的備份討論" },
    ],
  },
};
