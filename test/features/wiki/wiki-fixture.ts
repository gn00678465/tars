import type { TarsPaths } from "../../../src/core/paths.ts";
import { insertReserved, recordFailure } from "../../../src/features/agent/ledger.ts";
import { openWikiDb } from "../../../src/features/wiki/db.ts";
import { MODEL } from "../agent/db-fixture.ts";

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
