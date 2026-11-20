import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { resolvePaths, type TarsPaths } from "../../../src/core/paths.ts";
import type { ResolvedModel } from "../../../src/features/agent/catalog.ts";
import type { ProviderConfig } from "../../../src/features/agent/config.ts";
import { openDb } from "../../../src/features/agent/db.ts";
import { beginTurn, createConversation, newId } from "../../../src/features/agent/store.ts";
import type { TurnKind } from "../../../src/features/agent/types.ts";
import { tempHome } from "../../helpers.ts";

export const NOW = new Date("2026-11-19T12:00:00Z");

/** Paths under a fresh temp HOME; nothing points at the real HOME or XDG dirs. */
export function isolatedPaths(): TarsPaths {
  const home = tempHome();
  return resolvePaths({
    HOME: home,
    TARS_DATA_DIR: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
  });
}

export async function agentDb(): Promise<{ paths: TarsPaths; db: Database }> {
  const paths = isolatedPaths();
  return { paths, db: await openDb(paths) };
}

export const MODEL: ResolvedModel = {
  provider: "anthropic",
  id: "model-a",
  label: "Model A",
  contextWindow: 200000,
  maxOutput: 64000,
  effortLevels: ["low", "medium", "high"],
  thinkingTypes: ["adaptive", "disabled"],
  price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  pricedAt: "2026-11-19",
};

export const PROVIDER: ProviderConfig = {
  enabled: true,
  quota_usd: 100,
  period: "utc-month",
  stop_ratio: 0.95,
  warn_ratio: 0.8,
  daily_cap_usd: 10,
  prior_spend_usd: 0,
};

/** A conversation (created unless given) with one running turn. */
export function seedTurn(
  db: Database,
  opts: { convId?: string; kind?: TurnKind; now?: Date; text?: string } = {},
): { convId: string; turnId: string } {
  const now = (opts.now ?? NOW).getTime();
  const convId = opts.convId ?? newId();
  if (opts.convId === undefined)
    createConversation(db, {
      id: convId,
      text: opts.text ?? "hello",
      provider: "anthropic",
      model: MODEL.id,
      effort: "medium",
      now,
    });
  const turnId = newId();
  beginTurn(db, { id: turnId, convId, kind: opts.kind ?? "chat", effort: "medium", now });
  return { convId, turnId };
}
