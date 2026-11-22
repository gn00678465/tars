import { describe, expect, test } from "bun:test";
import {
  MESSAGE_BYTES,
  parseClient,
  parseServer,
  utf8Bytes,
  WIKI_ALIAS,
  WIKI_ALIASES,
  WIKI_CHANGELOG,
  WIKI_CHANGELOG_TEXT,
  WIKI_CONV_TITLE,
  WIKI_ENTRIES,
  WIKI_ENTRY,
  WIKI_ENTRY_SOURCES,
  WIKI_PAGES,
  WIKI_QUERY,
  WIKI_QUOTE,
  WIKI_QUOTES,
  WIKI_RELATED,
  WIKI_RESULTS,
  WIKI_SNIPPET,
  WIKI_SUMMARY,
  WIKI_TITLE,
  WIKI_TURN_TEXT_BYTES,
  type Parsed,
} from "../src/index.ts";
import { ID, msg, REF, wikiEntry, wikiOkPage } from "./fixtures.ts";

const reason = (r: Parsed<unknown>) => (r.ok ? "ok" : r.reason);
const client = (kind: string, p: object) => reason(parseClient(JSON.stringify(msg(kind, p))));
const server = (kind: string, p: object) =>
  reason(parseServer(JSON.stringify(msg(kind, p, { re: ID }))));
/** n characters of four bytes each, the heaviest text a page holds. */
const cjk = (n: number) => "😀".repeat(n);
const PATH = `investment/${"a".repeat(64)}`;

describe("each result at its limits still fits one message", () => {
  const bytes = (kind: string, p: object) => utf8Bytes(JSON.stringify(msg(kind, p, { re: ID })));
  const entry = {
    id: "i999999999",
    text: cjk(WIKI_ENTRY),
    assistant: true,
    verified: true,
    sources: Array.from({ length: WIKI_ENTRY_SOURCES }, () => REF),
  };
  const fullPage = {
    ...wikiOkPage,
    path: PATH,
    title: cjk(WIKI_TITLE),
    aliases: Array.from({ length: WIKI_ALIASES }, () => cjk(WIKI_ALIAS)),
    summary: cjk(WIKI_SUMMARY),
    facts: Array.from({ length: WIKI_ENTRIES }, () => entry),
    open: Array.from({ length: WIKI_ENTRIES }, () => entry),
    related: Array.from({ length: WIKI_RELATED }, () => PATH),
    changeLog: Array.from({ length: WIKI_CHANGELOG }, () => ({
      date: "2026-11-19",
      text: cjk(WIKI_CHANGELOG_TEXT),
    })),
    truncated: true,
  };
  const listed = {
    pages: Array.from({ length: WIKI_PAGES }, () => ({
      path: PATH,
      title: cjk(WIKI_TITLE),
      updated: "2026-11-19",
      blocked: true,
    })),
    more: true,
  };
  const searched = {
    query: cjk(WIKI_QUERY),
    pages: {
      indexedAt: Number.MAX_SAFE_INTEGER,
      results: Array.from({ length: WIKI_RESULTS }, () => ({
        path: PATH,
        title: cjk(WIKI_TITLE),
        updated: "2026-11-19",
        section: "summary",
        item: "i999999999",
        snippet: cjk(WIKI_SNIPPET),
      })),
    },
    records: {
      indexedAt: Number.MAX_SAFE_INTEGER,
      results: Array.from({ length: WIKI_RESULTS }, () => ({
        conv: "x".repeat(64),
        convTitle: cjk(WIKI_CONV_TITLE),
        turnNo: Number.MAX_SAFE_INTEGER,
        at: Number.MAX_SAFE_INTEGER,
        speaker: "assistant",
        snippet: cjk(WIKI_SNIPPET),
      })),
    },
  };
  // The text sides are cut by bytes, so a side at its limit is WIKI_TURN_TEXT_BYTES bytes.
  const source = {
    ref: REF,
    found: true,
    conv: "x".repeat(64),
    convTitle: cjk(WIKI_CONV_TITLE),
    turnNo: 1,
    at: 1,
    owner: "a".repeat(WIKI_TURN_TEXT_BYTES),
    assistant: "a".repeat(WIKI_TURN_TEXT_BYTES),
    quotes: Array.from({ length: WIKI_QUOTES }, () => cjk(WIKI_QUOTE)),
  };

  test.each([
    ["wiki.page.result", fullPage],
    ["wiki.list.result", listed],
    ["wiki.search.result", searched],
    ["wiki.source.result", source],
  ] as const)("%s", (kind, p) => {
    expect(server(kind, p)).toBe("ok");
    expect(bytes(kind, p)).toBeLessThanOrEqual(MESSAGE_BYTES);
  });

  test("one over a count limit is refused", () => {
    expect(server("wiki.page.result", { ...fullPage, facts: [...fullPage.facts, entry] })).toBe(
      "bad_message",
    );
    expect(
      server("wiki.list.result", { ...listed, pages: [...listed.pages, listed.pages[0]] }),
    ).toBe("bad_message");
  });
});

describe("wiki requests", () => {
  test("a query: 1 to 100 characters, not blank; counted in characters, not UTF-16 units", () => {
    expect(client("wiki.search", { query: "王" })).toBe("ok");
    expect(client("wiki.search", { query: "😀".repeat(WIKI_QUERY) })).toBe("ok");
    expect(client("wiki.search", { query: "a".repeat(WIKI_QUERY + 1) })).toBe("bad_message");
    expect(client("wiki.search", { query: "😀".repeat(WIKI_QUERY + 1) })).toBe("bad_message");
    expect(client("wiki.search", { query: "   " })).toBe("bad_message");
    expect(client("wiki.search", { query: "" })).toBe("bad_message");
    expect(client("wiki.search", { query: "x", limit: 0 })).toBe("bad_message");
    expect(client("wiki.search", { query: "x", limit: WIKI_RESULTS + 1 })).toBe("bad_message");
    // The terminal's synonyms and date range are not offered here.
    expect(client("wiki.search", { query: "x", also: ["y"] })).toBe("bad_message");
  });

  test("a page path: a known category and a lowercase slug, nothing that walks out", () => {
    expect(client("wiki.page", { path: "people/wang-xiaoming" })).toBe("ok");
    for (const path of [
      "notes/x",
      "people/Wang",
      "people/../x",
      "people/-x",
      "people/x/y",
      "people/x.md",
      "/people/x",
      `people/${"a".repeat(65)}`,
    ])
      expect(client("wiki.page", { path })).toBe("bad_message");
  });

  test("a source ref: eight hex characters on each side", () => {
    expect(client("wiki.source", { ref: REF })).toBe("ok");
    for (const ref of ["0123abcd/89abcde", "0123ABCD/89abcdef", "0123abcd-89abcdef", "a/b"])
      expect(client("wiki.source", { ref })).toBe("bad_message");
  });
});

describe("wiki results", () => {
  test("a page that is missing or broken carries only its path and why", () => {
    expect(server("wiki.page.result", { state: "missing", path: "people/x" })).toBe("ok");
    expect(
      server("wiki.page.result", { state: "blocked", path: "people/x", error: "沒有 frontmatter" }),
    ).toBe("ok");
    expect(server("wiki.page.result", { state: "missing", path: "people/x", title: "x" })).toBe(
      "bad_message",
    );
  });

  test("an entry's number is i and digits", () => {
    const page = (id: string) => ({ ...wikiOkPage, facts: [{ ...wikiEntry, id }] });
    expect(server("wiki.page.result", page("i12"))).toBe("ok");
    expect(server("wiki.page.result", page("12"))).toBe("bad_message");
  });

  test("a source not found carries no text", () => {
    expect(server("wiki.source.result", { ref: REF, found: false })).toBe("ok");
    expect(server("wiki.source.result", { ref: REF, found: false, owner: "x" })).toBe(
      "bad_message",
    );
  });

  test("a record of a deleted conversation has no conversation", () => {
    const records = { results: [{ at: 1, speaker: "owner", snippet: "x" }] };
    expect(server("wiki.search.result", { query: "x", pages: { results: [] }, records })).toBe(
      "ok",
    );
  });
});
