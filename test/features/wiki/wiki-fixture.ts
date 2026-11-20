import type { Database } from "bun:sqlite";
import type { TarsPaths } from "../../../src/core/paths.ts";
import { insertReserved, recordFailure } from "../../../src/features/agent/ledger.ts";
import { openWikiDb } from "../../../src/features/wiki/db.ts";
import { appendItems, endTurn } from "../../../src/features/agent/store.ts";
import type { NewItem } from "../../../src/features/agent/types.ts";
import { MODEL, NOW, seedTurn } from "../agent/db-fixture.ts";

let step = 0;
/** A sync job's request in wiki.db worth `usd` at `at`; settled unless `reserved`. */
export async function syncUsage(paths: TarsPaths, usd: number, at: Date, reserved = false) {
  const db = await openWikiDb(paths);
  db.run(
    "INSERT OR IGNORE INTO runs (id, state, model, started_at) VALUES ('r', 'running', 'm', 0)",
  );
  db.run(
    "INSERT OR IGNORE INTO turns (id, conv_id, kind, state, started_at) VALUES ('j', 'r', 'extract', 'running', 0)",
  );
  const usageId = insertReserved(db, {
    turnId: "j",
    convId: "r",
    step: ++step,
    attempt: 1,
    model: MODEL,
    cacheTtl: "5m",
    maxTokens: 0,
    inputUsd: usd,
    now: at,
  });
  if (!reserved) recordFailure(db, { usageId, receivedStart: false, textBytes: 0 });
  db.close();
}

export interface ChatTurnSpec {
  readonly owner?: string;
  readonly assistant?: readonly string[];
  readonly tools?: readonly {
    readonly name: string;
    readonly argv?: readonly string[];
    readonly status: string;
    readonly result: string;
  }[];
  readonly convId?: string;
  /** "running" leaves the turn open. */
  readonly state?: "completed" | "running" | "failed";
  readonly kind?: "chat" | "compaction";
  readonly now?: Date;
}

/** A chat turn in agent.db as tars chat leaves it: the owner's text, answers, tool calls. */
export function chatTurn(
  db: Database,
  spec: ChatTurnSpec = {},
): { convId: string; turnId: string } {
  const now = spec.now ?? NOW;
  const t = seedTurn(db, {
    ...(spec.convId === undefined ? {} : { convId: spec.convId }),
    ...(spec.kind === undefined ? {} : { kind: spec.kind }),
    now,
  });
  const items: NewItem[] = [{ kind: "user", step: 0, body: { text: spec.owner ?? "" } }];
  for (const [i, tool] of (spec.tools ?? []).entries()) {
    const callId = `call${i}`;
    items.push(
      {
        kind: "tool_call",
        step: 1,
        body: {
          callId,
          providerCallId: `p${i}`,
          name: tool.name,
          input: tool.argv === undefined ? {} : { argv: tool.argv },
        },
      },
      {
        kind: "tool_result",
        step: 1,
        body: { callId, status: tool.status, text: tool.result, truncated: false },
      } as NewItem,
    );
  }
  for (const text of spec.assistant ?? [])
    items.push({ kind: "assistant", step: 2, body: { text, state: "complete", native: null } });
  appendItems(db, t.convId, t.turnId, items, now.getTime());
  const state = spec.state ?? "completed";
  if (state !== "running") endTurn(db, { ...t, id: t.turnId, state, now: now.getTime() });
  return t;
}
