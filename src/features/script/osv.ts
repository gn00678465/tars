import type { Pin } from "./lock.ts";

export interface OsvEndpoint {
  /** https://api.osv.dev in production. */
  readonly url: string;
  /** One deadline across every batch and page, so the wait stays finite however OSV pages. */
  readonly timeoutMs: number;
}

export interface Advisory {
  readonly pin: Pin;
  /** GHSA-, PYSEC-, MAL- ids; details live at https://osv.dev/vulnerability/<id>. */
  readonly ids: readonly string[];
}

export type OsvVerdict =
  | { readonly kind: "checked"; readonly advisories: readonly Advisory[] }
  | { readonly kind: "unavailable"; readonly detail: string };

const BATCH = 1000;
const MAX_ROUNDS = 100;

interface Query {
  readonly pin: Pin;
  readonly token?: string;
}

interface BatchResult {
  readonly ids: readonly string[];
  readonly next?: string;
}

/**
 * Asks OSV's querybatch about every pin, following each query's next_page_token. Fails closed:
 * a network error, a non-2xx, the deadline, or a body of the wrong shape is `unavailable`.
 */
export async function findAdvisories(
  pins: readonly Pin[],
  endpoint: OsvEndpoint,
): Promise<OsvVerdict> {
  const signal = AbortSignal.timeout(endpoint.timeoutMs);
  const found = new Map<Pin, string[]>(pins.map((pin) => [pin, []]));
  let pending: Query[] = pins.map((pin) => ({ pin }));
  for (let round = 0; pending.length > 0; round++) {
    if (round === MAX_ROUNDS)
      return { kind: "unavailable", detail: `OSV still paging after ${MAX_ROUNDS} rounds` };
    const next: Query[] = [];
    for (let i = 0; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH);
      const results = await queryBatch(chunk, endpoint.url, signal);
      if (typeof results === "string") return { kind: "unavailable", detail: results };
      chunk.forEach((query, j) => {
        const result = results[j] as BatchResult;
        found.get(query.pin)?.push(...result.ids);
        if (result.next !== undefined) next.push({ pin: query.pin, token: result.next });
      });
    }
    pending = next;
  }
  return {
    kind: "checked",
    advisories: [...found].flatMap(([pin, ids]) => (ids.length > 0 ? [{ pin, ids }] : [])),
  };
}

/** The results in query order, or why there are none. */
async function queryBatch(
  queries: readonly Query[],
  url: string,
  signal: AbortSignal,
): Promise<readonly BatchResult[] | string> {
  const body = {
    queries: queries.map((q) => ({
      package: { name: q.pin.name, ecosystem: "PyPI" },
      version: q.pin.version,
      ...(q.token === undefined ? {} : { page_token: q.token }),
    })),
  };
  let json: unknown;
  try {
    const res = await fetch(`${url}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return `OSV answered ${res.status}`;
    json = await res.json();
  } catch (err) {
    return `OSV unreachable: ${(err as Error).message}`;
  }
  const results = parseResults(json, queries.length);
  return results ?? "OSV answered with an unexpected body";
}

function parseResults(json: unknown, expected: number): BatchResult[] | undefined {
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== expected) return undefined;
  const parsed: BatchResult[] = [];
  for (const r of results) {
    if (typeof r !== "object" || r === null) return undefined;
    const { vulns = [], next_page_token: next } = r as {
      vulns?: unknown;
      next_page_token?: unknown;
    };
    if (!Array.isArray(vulns) || (next !== undefined && typeof next !== "string")) return undefined;
    const ids = vulns.map((v) => (v as { id?: unknown } | null)?.id);
    if (!ids.every((id): id is string => typeof id === "string")) return undefined;
    parsed.push({ ids, ...(next === undefined || next === "" ? {} : { next }) });
  }
  return parsed;
}
