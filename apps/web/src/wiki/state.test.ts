import { expect, test } from "vite-plus/test";
import { initial, reduce } from "../state.ts";
import { server } from "../testing.ts";
import { LIST, PAGE, REF, REF2, SEARCH, STATUS } from "./fixtures.ts";
import { type WikiEvent, type WikiState, wikiInitial, wikiMessage, wikiReduce } from "./state.ts";

const run = (events: WikiEvent[], s: WikiState = wikiInitial) => events.reduce(wikiReduce, s);
const asked = (id: string, what: Extract<WikiEvent, { type: "asked" }>["what"]): WikiEvent => ({
  type: "asked",
  id,
  what,
});

test("the knowledge base is offered only once the local end answered wiki.status", () => {
  const s = run([asked("a", "status")]);
  expect(s.available).toBe(false);
  const answered = wikiMessage(s, server("wiki.status.result", STATUS, { re: "a" }));
  expect(answered?.available).toBe(true);
  expect(answered?.status).toEqual(STATUS);
  expect(answered?.pending).toEqual({});
});

test("an older local end answers bad_message: nothing is offered, and no error is shown", () => {
  const s = run([asked("a", "status"), { type: "view", view: "wiki" }]);
  const nacked = wikiMessage(s, server("nack", { reason: "bad_message" }, { re: "a" }));
  expect(nacked).toMatchObject({ available: false, view: "chat", pending: {} });
});

test("a nack for another request only lets that request go", () => {
  const s = wikiMessage(
    { ...run([asked("a", "status"), asked("b", "page")]), available: true, status: STATUS },
    server("nack", { reason: "auth_expired" }, { re: "b" }),
  );
  expect(s).toMatchObject({ available: true, pending: { a: "status" } });
});

test("messages it did not ask for are not the knowledge base's", () => {
  expect(wikiMessage(wikiInitial, server("wiki.status.result", STATUS, { re: "x" }))).toBe(
    undefined,
  );
  expect(wikiMessage(wikiInitial, server("conv.list.result", { convs: [] }))).toBe(undefined);
});

test("the list opens its first page when none is open, and leaves an open one alone", () => {
  const s = wikiMessage(run([asked("l", "list")]), server("wiki.list.result", LIST, { re: "l" }));
  expect(s?.selected).toBe("projects/nas-backup");
  const kept = wikiMessage(
    run([{ type: "select", path: "people/wang-xiaoming" }, asked("l", "list")]),
    server("wiki.list.result", LIST, { re: "l" }),
  );
  expect(kept?.selected).toBe("people/wang-xiaoming");
});

test("a page answered after another was picked is not shown", () => {
  const s = run([
    { type: "select", path: "projects/nas-backup" },
    asked("p", "page"),
    { type: "select", path: "people/wang-xiaoming" },
  ]);
  const after = wikiMessage(s, server("wiki.page.result", PAGE, { re: "p" }));
  expect(after?.page).toBe(undefined);
  expect(after?.pending).toEqual({});
});

test("picking a page opens the knowledge base and drops the last page", () => {
  const s = run([{ type: "select", path: "projects/nas-backup" }]);
  const shown = { ...s, page: PAGE };
  expect(wikiReduce(shown, { type: "select", path: "people/wang-xiaoming" })).toMatchObject({
    view: "wiki",
    selected: "people/wang-xiaoming",
  });
  expect(wikiReduce(shown, { type: "select", path: "people/wang-xiaoming" }).page).toBe(undefined);
});

test("picking the page already open keeps it: no new request goes for the same path", () => {
  const shown = { ...run([{ type: "select", path: "projects/nas-backup" }]), page: PAGE };
  const again = wikiReduce(
    { ...shown, view: "chat" },
    { type: "select", path: "projects/nas-backup" },
  );
  expect(again.page).toBe(PAGE);
  expect(again.view).toBe("wiki");
});

test("a search remembers what it asked; the answer replaces the last one", () => {
  const s = run([
    { type: "query", query: "備份" },
    { type: "asked", id: "s", what: "search", query: "備份" },
  ]);
  expect(s.searched).toBe("備份");
  expect(wikiMessage(s, server("wiki.search.result", SEARCH, { re: "s" }))?.search).toEqual(SEARCH);
});

test("the source overlay shows only the answer for the mark it opened on", () => {
  const s = run([{ type: "source", ref: REF }, asked("x", "source")]);
  const stale = wikiMessage(
    s,
    server("wiki.source.result", { ref: REF2, found: false }, { re: "x" }),
  );
  expect(stale?.source).toEqual({ ref: REF });
  const right = wikiMessage(
    s,
    server("wiki.source.result", { ref: REF, found: false }, { re: "x" }),
  );
  expect(right?.source).toEqual({ ref: REF, result: { ref: REF, found: false } });
  expect(wikiReduce(s, { type: "source", ref: undefined }).source).toBe(undefined);
});

test("/wiki opens the knowledge base searching for its words; forget lets requests go", () => {
  const s = run([
    { type: "track", track: "raw" },
    { type: "slash", query: "FTS5" },
  ]);
  expect(s).toMatchObject({ view: "wiki", query: "FTS5", track: "wiki" });
  const two = run([asked("a", "status"), asked("b", "list")]);
  expect(wikiReduce(two, { type: "forget", id: "a" }).pending).toEqual({ b: "list" });
  expect(wikiReduce(two, { type: "forget" }).pending).toEqual({});
});

test("in the page's state: opening a conversation leaves the knowledge base for it", () => {
  const s = reduce(
    { ...initial, wiki: { ...wikiInitial, available: true, view: "wiki" } },
    {
      type: "open_conv",
      conv: "c",
    },
  );
  expect(s.wiki.view).toBe("chat");
  expect(s.wiki.available).toBe(true);
});

test("in the page's state: another epoch keeps the knowledge base, asked once per connection", () => {
  const wiki = { ...wikiInitial, available: true, status: STATUS };
  const s = reduce(
    { ...initial, connection: "open", epoch: "e1", wiki },
    { type: "message", m: server("hello", { epoch: "e2", tars: "0.0.1" }), at: 0 },
  );
  expect(s.epoch).toBe("e2");
  expect(s.wiki).toEqual(wiki);
});

test("in the page's state: a login that expired answering the knowledge base says so", () => {
  const s = reduce(
    { ...initial, connection: "open", wiki: run([asked("p", "page")]) },
    {
      type: "message",
      m: server("nack", { reason: "auth_expired" }, { re: "p" }),
      at: 0,
    },
  );
  expect(s.connection).toBe("auth_expired");
  expect(s.wiki.pending).toEqual({});
});
