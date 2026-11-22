export const ID = "01a1fd71-be41-71e7-809a-4bb1e568ad68";
export const CONN = "3f2b8c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b";
export const HASH = "a".repeat(64);

export const msg = (kind: string, p: object, extra: object = {}) => ({
  v: 1,
  id: ID,
  kind,
  ...extra,
  p,
});

const approval = {
  approvalId: ID,
  conv: ID,
  hash: HASH,
  action: "run_script",
  script: "gcal-add",
  version: "3",
  summary: "加一筆行程",
  effects: "external-write",
  domains: ["www.googleapis.com"],
  secret: "gcal",
  argv: ["--title", "牙醫"],
  expiresAt: 1_800_000_000_000,
};

export const status = {
  now: 1_800_000_000_000,
  providers: [
    { name: "anthropic", spentUsd: 1, quotaUsd: 100, warnUsd: 80, stopUsd: 95, stopped: false },
  ],
  pricesWarn: false,
  pendingApprovals: 1,
  turnRunning: false,
  notify: "ok",
};

export const ITEMS = {
  user: { seq: 1, turn: ID, kind: "user", text: "hi", truncated: false },
  carried: { seq: 1, turn: ID, kind: "carried", from: ID },
  assistant: {
    seq: 2,
    turn: ID,
    kind: "assistant",
    text: "hello",
    truncated: false,
    state: "complete",
  },
  tool_call: {
    seq: 3,
    turn: ID,
    kind: "tool_call",
    callId: ID,
    name: "tars",
    input: "{}",
    truncated: false,
  },
  tool_result: {
    seq: 4,
    turn: ID,
    kind: "tool_result",
    callId: ID,
    status: "ok",
    exit: 0,
    text: "done",
    truncated: false,
  },
  usage: {
    seq: 5,
    turn: ID,
    kind: "usage",
    inputTokens: 10,
    outputTokens: 2,
    costUsd: 0.001,
    costSource: "table",
  },
  error: { seq: 6, turn: ID, kind: "error", code: "provider_error" },
  compaction: { seq: 7, turn: ID, kind: "compaction", text: "summary", truncated: false },
} as const;

/** One valid message of each kind, with conv where it is required. */
export const CLIENT: Record<string, object> = {
  hello: msg("hello", {}),
  "conv.list": msg("conv.list", {}),
  "conv.open": msg("conv.open", { before: 10 }, { conv: ID }),
  "turn.submit": msg("turn.submit", { requestId: ID, text: "hi" }),
  "turn.abort": msg("turn.abort", {}, { conv: ID }),
  "approval.decide": msg("approval.decide", { approvalId: ID, decision: "approved", hash: HASH }),
  "status.get": msg("status.get", {}),
  "models.get": msg("models.get", {}),
};

export const SERVER: Record<string, object> = {
  hello: msg("hello", { epoch: "ab".repeat(16), tars: "0.0.1" }, { re: ID }),
  ack: msg("ack", { turn: ID }, { re: ID }),
  nack: msg("nack", { reason: "version", need: "client" }, { re: ID }),
  "conv.list.result": msg("conv.list.result", {
    convs: [
      {
        id: ID,
        title: "t",
        provider: "anthropic",
        model: "m",
        updatedAt: 1,
        parentId: ID,
        effort: "high",
      },
    ],
  }),
  "conv.snapshot": msg(
    "conv.snapshot",
    {
      epoch: "ab".repeat(16),
      items: Object.values(ITEMS),
      more: false,
      running: { turn: ID, text: "par", truncated: false },
    },
    { conv: ID },
  ),
  turn: msg("turn", { turn: ID, requestId: ID, state: "started" }, { conv: ID }),
  item: msg("item", { item: ITEMS.user }, { conv: ID }),
  delta: msg("delta", { turn: ID, text: "x" }, { conv: ID }),
  notice: msg("notice", { code: "budget_warn", data: { provider: "anthropic", usd: 1 } }),
  "approval.request": msg("approval.request", { approval }),
  "approval.resolved": msg("approval.resolved", {
    approvalId: ID,
    state: "approved",
    via: "remote",
  }),
  status: msg("status", status),
  "models.result": msg(
    "models.result",
    {
      models: [
        {
          provider: "anthropic",
          id: "m",
          label: "M",
          window: 200_000,
          isDefault: true,
          effortLevels: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
        { provider: "gemini", id: "g", label: "G", isDefault: false, unusable: "no_key" },
      ],
    },
    { re: ID },
  ),
  "relay.status": msg("relay.status", { online: true, lastSeenAt: 1, localSince: 2 }),
};

/** A required key of each kind's p, when it has one. */
export const REQUIRED_P: Record<string, string> = {
  "turn.submit": "text",
  "approval.decide": "hash",
  hello: "epoch",
  nack: "reason",
  "conv.list.result": "convs",
  "conv.snapshot": "items",
  turn: "state",
  item: "item",
  delta: "text",
  notice: "code",
  "approval.request": "approval",
  "approval.resolved": "via",
  status: "now",
  "models.result": "models",
  "relay.status": "online",
};

export const TO_LOCAL: Record<string, object> = {
  open: { t: "open", conn: CONN, jwt: "a.b.c", country: "TW", ua: "Mozilla/5.0" },
  close: { t: "close", conn: CONN },
  msg: { t: "msg", conn: CONN, m: CLIENT.hello },
  probe: { t: "probe" },
};

export const TO_RELAY: Record<string, object> = {
  msg: { t: "msg", to: CONN, m: SERVER.ack },
  drop: { t: "drop", conn: CONN, code: 4003 },
  "probe.ok": { t: "probe.ok" },
};
