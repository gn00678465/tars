import type { OsvEndpoint } from "../../../src/features/script/osv.ts";

interface Query {
  readonly package: { readonly name: string; readonly ecosystem: string };
  readonly version: string;
  readonly page_token?: string;
}

export interface FakeOsv {
  readonly endpoint: OsvEndpoint;
  /** Every querybatch body received, in order. */
  readonly requests: { readonly queries: readonly Query[] }[];
  stop(): void;
}

interface Behavior {
  readonly status?: number;
  /** Answer every request with this body instead. */
  readonly body?: unknown;
  /** Never answer. */
  readonly hang?: boolean;
  /** Advisory ids per page; a longer list gets a next_page_token. */
  readonly pageSize?: number;
}

/** OSV's querybatch on 127.0.0.1, answering from `advisories` (package name to ids). */
export function fakeOsv(
  advisories: Readonly<Record<string, readonly string[]>> = {},
  behavior: Behavior = {},
): FakeOsv {
  const requests: { queries: Query[] }[] = [];
  const pageSize = behavior.pageSize ?? Infinity;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/querybatch") return new Response("", { status: 404 });
      const body = (await req.json()) as { queries: Query[] };
      requests.push(body);
      if (behavior.hang) await new Promise(() => {});
      if (behavior.status !== undefined) return new Response("", { status: behavior.status });
      if (behavior.body !== undefined) return Response.json(behavior.body);
      return Response.json({
        results: body.queries.map((q) => {
          const ids = advisories[q.package.name] ?? [];
          const from = q.page_token === undefined ? 0 : Number(q.page_token.split(":")[1]);
          const page = ids.slice(from, from + pageSize);
          return {
            ...(page.length === 0
              ? {}
              : { vulns: page.map((id) => ({ id, modified: "2026-01-01T00:00:00Z" })) }),
            ...(from + pageSize < ids.length
              ? { next_page_token: `${q.package.name}:${from + pageSize}` }
              : {}),
          };
        }),
      });
    },
  });
  return {
    endpoint: { url: `http://127.0.0.1:${server.port}`, timeoutMs: 5000 },
    requests,
    stop: () => void server.stop(true),
  };
}
