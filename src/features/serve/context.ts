import type { Database } from "bun:sqlite";
import type { WireContext } from "@tars/protocol";
import type { Catalog } from "../agent/catalog.ts";
import type { Limits } from "../agent/config.ts";
import type { Conversation } from "../agent/store.ts";

/**
 * A conversation's context against its model's window, as the engine measures it: the last
 * request's input tokens, the window capped by max_input_tokens. A model the list no longer has
 * is measured against max_input_tokens alone.
 */
export function convContext(
  db: Database,
  conv: Conversation,
  catalog: Catalog,
  limits: Limits,
): WireContext {
  const entry = catalog.models.find((m) => m.provider === conv.provider && m.id === conv.model);
  const window = Math.min(entry?.contextWindow ?? limits.max_input_tokens, limits.max_input_tokens);
  const last = db
    .query(
      `SELECT u.cache_read_tokens AS r,
         u.uncached_input_tokens + u.cache_read_tokens + u.cache_write_tokens AS total
       FROM usage u JOIN turns t ON t.id = u.turn_id
       WHERE u.conv_id = ? AND t.kind = 'chat' AND u.state = 'final'
       ORDER BY u.id DESC LIMIT 1`,
    )
    .get(conv.id) as { r: number; total: number } | null;
  const compacted = db
    .query("SELECT MAX(created_at) AS at FROM items WHERE conv_id = ? AND kind = 'compaction'")
    .get(conv.id) as { at: number | null };
  return {
    contextUsed: conv.lastTotalInputTokens,
    contextLimit: Math.max(1, window),
    ...(last === null || last.total === 0
      ? {}
      : { cacheHitPct: Math.round((last.r / last.total) * 100) }),
    ...(compacted.at === null ? {} : { lastCompactedAt: compacted.at }),
    warnRatio: limits.context_warn_ratio,
    compactRatio: limits.context_compact_ratio,
    stopRatio: limits.context_stop_ratio,
    autoCompact: limits.auto_compact,
  };
}
