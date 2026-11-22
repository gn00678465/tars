import type { Database } from "bun:sqlite";
import type { WireContext } from "@tars/protocol";
import type { Catalog } from "../agent/catalog.ts";
import type { Limits } from "../agent/config.ts";
import type { Conversation } from "../agent/store.ts";
import { estimateTokens, utf8Bytes } from "../agent/bytes.ts";
import type { CompactionBody } from "../agent/types.ts";

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
    .query(
      `SELECT created_at AS at, body FROM items WHERE conv_id = ? AND kind = 'compaction'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(conv.id) as { at: number; body: string } | null;
  const after = conv.lastTotalInputTokens === 0 ? afterCompaction(compacted?.body) : undefined;
  return {
    contextUsed: after ?? conv.lastTotalInputTokens,
    ...(after === undefined ? {} : { estimated: true as const }),
    contextLimit: Math.max(1, window),
    ...(last === null || last.total === 0
      ? {}
      : { cacheHitPct: Math.round((last.r / last.total) * 100) }),
    ...(compacted === null ? {} : { lastCompactedAt: compacted.at }),
    warnRatio: limits.context_warn_ratio,
    compactRatio: limits.context_compact_ratio,
    stopRatio: limits.context_stop_ratio,
    autoCompact: limits.auto_compact,
  };
}

/**
 * A compaction zeroes the measured total (finishCompaction): until the next request measures it,
 * the context is about what the next one sends, the turns kept verbatim and the summary, on the
 * engine's own estimate. Undefined with no compaction: 0 is then what was measured.
 */
function afterCompaction(body: string | undefined): number | undefined {
  if (body === undefined) return undefined;
  const b = JSON.parse(body) as Partial<CompactionBody>;
  return (b.keptTokens ?? 0) + estimateTokens(utf8Bytes(b.summary ?? ""));
}
