// The scenes of ui_spec.md 7, one state each, as the fake local end (fake.ts) answers them and
// the steps run.ts takes before its screenshot. Made-up data only: no real account or host.
import type {
  WireApproval,
  WireCatalogEntry,
  WireContext,
  WireConv,
  WireItem,
  WireModel,
  WireStatus,
} from "@tars/protocol";
import { LIST, PAGE, SEARCH, STATUS as WIKI } from "../../src/wiki/fixtures.ts";

/** The page's clock in every scene: 2026-11-23 12:00 in Taipei. */
export const NOW = 1_795_406_400_000;
export const EPOCH = "epoch-visual";
const HOUR = 3_600_000;

/** A server message without its envelope: fake.ts adds v, id and re. */
export interface Push {
  readonly kind: string;
  readonly conv?: string;
  readonly p: unknown;
}

/** What run.ts does before the screenshot: a Playwright selector to click, or text to type. */
export type Step =
  | { readonly click: string }
  | { readonly fill: string; readonly text: string }
  | { readonly wait: number };

export interface Scene {
  readonly name: string;
  readonly relay: { readonly online: boolean; readonly localSince?: number };
  /** Sent after hello, unasked. */
  readonly pushes?: readonly Push[];
  readonly answers: Readonly<
    Record<string, readonly Push[] | ((m: { conv?: string; p: { path?: string } }) => Push[])>
  >;
  readonly steps?: readonly Step[];
  /** At phone width, in place of steps. */
  readonly phone?: readonly Step[];
}

const conv = (id: string, title: string, model: string, ago: number): WireConv => ({
  id,
  title,
  provider: model.startsWith("gpt") ? "openai" : model.includes("/") ? "openrouter" : "anthropic",
  model,
  updatedAt: NOW - ago,
  effort: "medium",
});

const CONVS: WireConv[] = [
  conv("c-backup", "整理 NAS 備份腳本", "claude-sonnet-5-5", 0.2 * HOUR),
  conv("c-ledger", "記一筆晚餐", "gpt-6", 3 * HOUR),
  conv("c-fts", "SQLite FTS5 的中文斷詞", "qwen/qwen-4", 30 * HOUR),
  conv("c-old", "上個月的帳單", "claude-old", 80 * HOUR),
];

const MODELS: WireModel[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    window: 200_000,
    isDefault: true,
    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
  },
  {
    provider: "openai",
    id: "gpt-6",
    label: "GPT-6",
    window: 400_000,
    isDefault: false,
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    provider: "openrouter",
    id: "qwen/qwen-4",
    label: "Qwen 4",
    window: 128_000,
    isDefault: false,
    effortLevels: [],
  },
];

const CATALOG: WireCatalogEntry[] = [
  ...MODELS.map((m): WireCatalogEntry => ({
    provider: m.provider,
    id: m.id,
    label: m.label,
    status: "active",
    price: { input: 3, output: 15, cacheRead: 0.3 },
    priceSource: "manual",
    pricedAt: "2026-11-01",
  })),
  { provider: "openai", id: "gpt-6-mini", label: "GPT-6 mini", status: "candidate" },
  { provider: "anthropic", id: "claude-old", label: "Claude Old", status: "retired" },
];

const provider = (name: string, spentUsd: number, quotaUsd: number, stopped = false) => ({
  name,
  spentUsd,
  quotaUsd,
  warnUsd: quotaUsd * 0.8,
  stopUsd: quotaUsd,
  stopped,
  period: name === "openrouter" ? ("cumulative" as const) : ("month" as const),
});

const STATUS: WireStatus = {
  now: NOW,
  providers: [
    provider("anthropic", 3.2, 50),
    provider("openai", 1.05, 30),
    provider("openrouter", 2.4, 10),
  ],
  pricesWarn: false,
  pendingApprovals: 0,
  turnRunning: false,
  notify: "ok",
  skills: [
    { name: "fava-ledger", description: "讀寫 Beancount 帳本", localOnly: false },
    { name: "tars-wiki", description: "查個人知識庫", localOnly: false },
    { name: "screen-capture", description: "擷取本機螢幕", localOnly: true },
  ],
  archive: true,
};

const CONTEXT: WireContext = {
  contextUsed: 52_000,
  contextLimit: 200_000,
  cacheHitPct: 82,
  warnRatio: 0.7,
  compactRatio: 0.8,
  stopRatio: 0.95,
  autoCompact: true,
};

const at = (seq: number, turn: string) => ({ seq, turn });
const BACKUP: WireItem[] = [
  { ...at(1, "t1"), kind: "user", text: "幫我看今晚的 NAS 備份會不會跑", truncated: false },
  {
    ...at(2, "t1"),
    kind: "assistant",
    text: "我先用 `--dry-run` 看一次備份腳本會做什麼。",
    truncated: false,
    state: "complete",
  },
  {
    ...at(3, "t1"),
    kind: "tool_call",
    callId: "call-1",
    name: "tars",
    input: JSON.stringify({ argv: ["script", "run", "nas-backup", "--dry-run"] }),
    truncated: false,
  },
  {
    ...at(4, "t1"),
    kind: "tool_result",
    callId: "call-1",
    status: "done",
    exit: 0,
    text: "sending incremental file list\nphotos/2026-11/\ndocs/ledger.beancount\n\nsent 1,204 bytes  received 88 bytes",
    truncated: false,
    durationMs: 2_400,
  },
  {
    ...at(5, "t1"),
    kind: "assistant",
    text: "預覽正常：今晚 03:00 會同步 **2 個目錄**，保留 30 天。要我正式跑一次嗎？",
    truncated: false,
    state: "complete",
  },
  {
    ...at(6, "t1"),
    kind: "usage",
    inputTokens: 12_400,
    outputTokens: 860,
    costUsd: 0.05,
    costSource: "manual",
    cacheReadTokens: 9_000,
    effort: "medium",
  },
];

const ERRORS: WireItem[] = [
  { ...at(1, "t1"), kind: "user", text: "幫我整理這個月的帳單", truncated: false },
  { ...at(2, "t1"), kind: "error", code: "provider_unavailable", data: { provider: "anthropic" } },
  { ...at(3, "t2"), kind: "user", text: "再試一次", truncated: false },
  {
    ...at(4, "t2"),
    kind: "error",
    code: "quota_exceeded",
    data: { provider: "anthropic", spent: 50, quota: 50 },
  },
  { ...at(5, "t3"), kind: "user", text: "換個做法", truncated: false },
  { ...at(6, "t3"), kind: "error", code: "context_too_long" },
];

const COMPACTED: WireItem[] = [
  { ...at(1, "t1"), kind: "user", text: "FTS5 能不能處理中文？", truncated: false },
  {
    ...at(2, "t1"),
    kind: "assistant",
    text: "內建的 unicode61 斷詞器不會切中文，要用 trigram 或自訂斷詞器。",
    truncated: false,
    state: "complete",
  },
  {
    ...at(3, "t2"),
    kind: "compaction",
    text: "1. 擁有者在找 SQLite FTS5 的中文搜尋做法。\n2. 已比較 unicode61 與 trigram。",
    truncated: false,
    at: NOW - 2 * HOUR,
    trigger: "manual",
    beforeTokens: 96_000,
    keptTokens: 8_000,
    count: 14,
    costUsd: 0.02,
    firstKeptSeq: 4,
  },
  { ...at(4, "t2"), kind: "user", text: "trigram 的索引會多大？", truncated: false },
  {
    ...at(5, "t2"),
    kind: "assistant",
    text: "大約是原文的 3 到 4 倍。",
    truncated: false,
    state: "complete",
  },
];

const approval = (conv: string, callId?: string): WireApproval => ({
  approvalId: `ap-${conv}`,
  conv,
  hash: "a".repeat(64),
  action: "run_script",
  script: "nas-backup",
  version: "3",
  summary: "把 NAS 同步到外接硬碟，刪除 30 天前的快照",
  effects: "write_external",
  domains: ["nas.example.com", "*"],
  secret: "nas-backup-key",
  argv: ["--target", "/mnt/backup", "--keep", "30"],
  expiresAt: NOW + 4 * 60_000,
  ...(callId === undefined ? {} : { callId }),
});

const items: Record<string, WireItem[]> = {
  "c-backup": BACKUP,
  "c-ledger": ERRORS,
  "c-fts": COMPACTED,
  "c-old": BACKUP.slice(0, 2),
};

type Answers = Scene["answers"];
const answers = (o: {
  convs?: WireConv[];
  status?: WireStatus;
  context?: WireContext;
  models?: WireModel[];
}): Answers => ({
  "conv.list": [{ kind: "conv.list.result", p: { convs: o.convs ?? CONVS } }],
  "status.get": [{ kind: "status", p: o.status ?? STATUS }],
  "models.get": [
    {
      kind: "models.result",
      p: {
        models: o.models ?? MODELS,
        updatedAt: "2026-11-22",
        catalog: CATALOG,
        catalogTotal: CATALOG.length,
      },
    },
  ],
  "conv.open": (m) => [
    {
      kind: "conv.snapshot",
      conv: m.conv,
      p: { epoch: EPOCH, items: items[m.conv ?? ""] ?? [], more: false },
    },
    { kind: "conv.context", conv: m.conv, p: o.context ?? CONTEXT },
  ],
  "turn.submit": [{ kind: "ack", p: {} }],
  "wiki.status": [{ kind: "wiki.status.result", p: WIKI }],
  "wiki.list": [{ kind: "wiki.list.result", p: LIST }],
  "wiki.page": [{ kind: "wiki.page.result", p: PAGE }],
  "wiki.search": [{ kind: "wiki.search.result", p: SEARCH }],
});

const online = { online: true, localSince: NOW - 5 * HOUR };
/** The conversation list's entry, on a phone behind the drawer. */
const openConv = (title: string): Step[] => [{ click: `.conv-list >> text=${title}` }];
const drawer: Step = { click: '[aria-label="展開對話列表"]' };

/** The status button: on a desktop the one with the spending, on a phone the labelled one. */
const sheet: Step = {
  click: 'header .sg-btn.desktop-only:visible, [aria-label="開啟系統狀態與花費面板"]:visible',
};
const backup = openConv("整理 NAS 備份腳本");
/** Opens a conversation: on a phone, the drawer first. */
const both = (title: string, ...then: Step[]) => ({
  steps: [...openConv(title), ...then],
  phone: [drawer, ...openConv(title), ...then],
});
const pending = (conv: string, callId?: string): Push => ({
  kind: "approval.request",
  conv,
  p: { approval: approval(conv, callId) },
});
const spent = {
  ...STATUS,
  providers: [
    provider("anthropic", 42.5, 50),
    provider("openai", 30, 30, true),
    provider("openrouter", 2.4, 10),
  ],
};

export const SCENES: Scene[] = [
  {
    name: "對話進行中，工具卡展開",
    relay: online,
    answers: answers({}),
    ...both("整理 NAS 備份腳本", { click: ".tool-step-summary" }),
  },
  {
    name: "對話列表（手機是抽屜）",
    relay: online,
    answers: answers({}),
    steps: backup,
    phone: [drawer],
  },
  {
    name: "核准卡：等待中，寫外部加任意主機",
    relay: online,
    pushes: [pending("c-backup", "call-1")],
    answers: answers({ status: { ...STATUS, pendingApprovals: 1 } }),
    ...both("整理 NAS 備份腳本"),
  },
  {
    name: "別的對話的待核准卡",
    relay: online,
    pushes: [pending("c-ledger")],
    answers: answers({ status: { ...STATUS, pendingApprovals: 1 } }),
    ...both("整理 NAS 備份腳本"),
  },
  {
    name: "連線：本機端離線（列表載入不了）",
    relay: { online: false },
    answers: answers({}),
  },
  {
    name: "花費：提醒與停用門檻，面板展開",
    relay: online,
    answers: answers({ status: spent }),
    steps: [...backup, sheet],
    phone: [sheet],
  },
  {
    name: "新對話與模型選單",
    relay: online,
    answers: answers({}),
    steps: [{ click: 'button:has-text("新對話")' }, { click: '.run-seg:has-text("模型")' }],
    phone: [{ click: '.run-seg:has-text("模型")' }],
  },
  {
    name: "模型清單：價目過期、候選與下架",
    relay: online,
    answers: answers({
      status: {
        ...STATUS,
        pricesWarn: true,
        prices: [{ provider: "openai", model: "gpt-6", ageDays: 45, state: "stale" }],
        candidates: 1,
        retired: 1,
      },
    }),
    steps: [...backup, sheet],
    phone: [sheet],
  },
  {
    name: "以另一個模型接續的提示",
    relay: online,
    answers: answers({ status: spent }),
    ...both("上個月的帳單"),
  },
  {
    name: "錯誤",
    relay: online,
    answers: answers({}),
    ...both("記一筆晚餐"),
  },
  {
    name: "空狀態",
    relay: online,
    answers: answers({ convs: [] }),
  },
  {
    name: "推理強度選單",
    relay: online,
    answers: answers({}),
    ...both("整理 NAS 備份腳本", { click: '.run-seg:has-text("推理")' }),
  },
  {
    name: "壓縮：分隔卡與上下文面板",
    relay: online,
    answers: answers({
      context: { ...CONTEXT, contextUsed: 150_000, lastCompactedAt: NOW - 2 * HOUR },
    }),
    steps: [...openConv("SQLite FTS5 的中文斷詞"), { click: '[aria-label="上下文用量與壓縮"]' }],
    phone: [drawer, ...openConv("SQLite FTS5 的中文斷詞")],
  },
  {
    name: "Slash 指令選單",
    relay: online,
    answers: answers({}),
    ...both("整理 NAS 備份腳本", { fill: 'textarea[aria-label="訊息"]', text: "/" }),
  },
  {
    name: "知識庫的一頁",
    relay: online,
    answers: answers({}),
    steps: [{ click: 'button:has-text("個人知識庫")' }, { click: "text=NAS 備份腳本" }],
    // A phone opens on the page already.
    phone: [{ click: 'button:has-text("個人知識庫")' }],
  },
];
