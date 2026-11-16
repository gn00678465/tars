import { afterEach, describe, expect, test } from "bun:test";
import { normalizeName, type Pin } from "../../../src/features/script/lock.ts";
import { findAdvisories } from "../../../src/features/script/osv.ts";
import { fakeOsv, type FakeOsv } from "./fake-osv.ts";

const pin = (name: string, version = "1.0"): Pin => ({ name: normalizeName(name), version });

let osv: FakeOsv | undefined;
afterEach(() => osv?.stop());

describe("findAdvisories", () => {
  test("reports the advisories of the pin they belong to", async () => {
    osv = fakeOsv({ beta: ["GHSA-0000-0000-0000", "MAL-2026-1"] });
    const verdict = await findAdvisories([pin("alpha"), pin("beta")], osv.endpoint);
    expect(verdict).toEqual({
      kind: "checked",
      advisories: [{ pin: pin("beta"), ids: ["GHSA-0000-0000-0000", "MAL-2026-1"] }],
    });
    expect(osv.requests[0]?.queries[1]).toEqual({
      package: { name: "beta", ecosystem: "PyPI" },
      version: "1.0",
    });
  });

  test("sends no request without pins", async () => {
    osv = fakeOsv();
    expect(await findAdvisories([], osv.endpoint)).toEqual({ kind: "checked", advisories: [] });
    expect(osv.requests).toHaveLength(0);
  });

  test("a 500 is unavailable", async () => {
    osv = fakeOsv({}, { status: 500 });
    expect(await findAdvisories([pin("alpha")], osv.endpoint)).toEqual({
      kind: "unavailable",
      detail: "OSV answered 500",
    });
  });

  test("a body of the wrong shape is unavailable", async () => {
    osv = fakeOsv({}, { body: { results: [] } });
    expect((await findAdvisories([pin("alpha")], osv.endpoint)).kind).toBe("unavailable");
  });

  test("a server that never answers is unavailable once the deadline passes", async () => {
    osv = fakeOsv({}, { hang: true });
    const started = performance.now();
    const verdict = await findAdvisories([pin("alpha")], { ...osv.endpoint, timeoutMs: 200 });
    expect(verdict.kind).toBe("unavailable");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("an unreachable server is unavailable", async () => {
    osv = fakeOsv();
    osv.stop();
    expect((await findAdvisories([pin("alpha")], osv.endpoint)).kind).toBe("unavailable");
  });

  test("splits more than 1000 pins into batches", async () => {
    osv = fakeOsv({ "p-1000": ["PYSEC-1"] });
    const pins = Array.from({ length: 1001 }, (_, i) => pin(`p-${i}`));
    const verdict = await findAdvisories(pins, osv.endpoint);
    expect(osv.requests.map((r) => r.queries.length)).toEqual([1000, 1]);
    expect(verdict).toEqual({
      kind: "checked",
      advisories: [{ pin: pin("p-1000"), ids: ["PYSEC-1"] }],
    });
  });

  test("follows next_page_token for only the query that has one", async () => {
    osv = fakeOsv({ alpha: ["GHSA-1"], beta: ["GHSA-2", "GHSA-3"] }, { pageSize: 1 });
    const verdict = await findAdvisories([pin("alpha"), pin("beta")], osv.endpoint);
    expect(osv.requests).toHaveLength(2);
    expect(osv.requests[1]?.queries).toEqual([
      { package: { name: "beta", ecosystem: "PyPI" }, version: "1.0", page_token: "beta:1" },
    ]);
    expect(verdict).toEqual({
      kind: "checked",
      advisories: [
        { pin: pin("alpha"), ids: ["GHSA-1"] },
        { pin: pin("beta"), ids: ["GHSA-2", "GHSA-3"] },
      ],
    });
  });

  test("a server that pages forever is unavailable", async () => {
    osv = fakeOsv({}, { body: { results: [{ next_page_token: "again" }] } });
    expect(await findAdvisories([pin("alpha")], osv.endpoint)).toEqual({
      kind: "unavailable",
      detail: "OSV still paging after 100 rounds",
    });
  });
});
