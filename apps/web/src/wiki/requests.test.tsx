// @vitest-environment jsdom
import type { ClientKind, ServerMessage } from "@tars/protocol";
import { act, useEffect, useReducer } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { render } from "../render.ts";
import { server } from "../testing.ts";
import { LIST, PAGE, SEARCH, STATUS } from "./fixtures.ts";
import { ANSWER_WITHIN_MS, SEARCH_PAUSE_MS, useWikiRequests } from "./requests.ts";
import { type WikiEvent, type WikiState, wikiInitial, wikiMessage, wikiReduce } from "./state.ts";

type Event = WikiEvent | { type: "message"; m: ServerMessage };

function reduce(s: WikiState, e: Event): WikiState {
  return e.type === "message" ? (wikiMessage(s, e.m) ?? s) : wikiReduce(s, e);
}

let sent: { id: string; kind: ClientKind; p: unknown }[];
let n: number;
const socket = {
  send: (kind: ClientKind, p?: unknown) => {
    const id = `c-${++n}`;
    sent.push({ id, kind, p });
    return id;
  },
};
let dispatch: (e: Event) => void;
let state: WikiState;

function Probe(props: { live: boolean }) {
  const [s, d] = useReducer(reduce, wikiInitial);
  useWikiRequests(socket, s, d, props.live);
  useEffect(() => {
    dispatch = d;
    state = s;
  });
  return null;
}

const answer = (kind: ServerMessage["kind"], p: unknown) =>
  act(async () => {
    const asked = sent.findLast((x) => `${x.kind}.result` === kind);
    dispatch({ type: "message", m: server(kind, p, { re: asked?.id }) });
  });
const send = (e: Event) => act(async () => dispatch(e));
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const kinds = () => sent.map((x) => x.kind);

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  n = 0;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

test("reaching the local end asks wiki.status once; nothing else until the tab opens", async () => {
  await render(<Probe live={true} />);
  expect(kinds()).toEqual(["wiki.status"]);
  await answer("wiki.status.result", STATUS);
  expect(kinds()).toEqual(["wiki.status"]);
});

test("offline asks nothing", async () => {
  await render(<Probe live={false} />);
  expect(kinds()).toEqual([]);
});

test("opening the knowledge base reads the counts, the list, then the first page", async () => {
  await render(<Probe live={true} />);
  await answer("wiki.status.result", STATUS);
  await send({ type: "view", view: "wiki" });
  expect(kinds()).toEqual(["wiki.status", "wiki.status", "wiki.list"]);
  await answer("wiki.list.result", LIST);
  expect(sent.at(-1)).toMatchObject({ kind: "wiki.page", p: { path: "projects/nas-backup" } });
  await answer("wiki.page.result", PAGE);
  expect(state.page).toEqual(PAGE);
});

test("typing searches once it pauses, one search at a time, and the newest words last", async () => {
  await render(<Probe live={true} />);
  await answer("wiki.status.result", STATUS);
  await send({ type: "view", view: "wiki" });
  sent = [];
  await send({ type: "query", query: "備" });
  await wait(SEARCH_PAUSE_MS - 1);
  await send({ type: "query", query: "備份" });
  await wait(SEARCH_PAUSE_MS - 1);
  expect(kinds()).toEqual([]);
  await wait(1);
  expect(sent).toMatchObject([{ kind: "wiki.search", p: { query: "備份", limit: 20 } }]);
  await send({ type: "query", query: "備份腳本" });
  await wait(SEARCH_PAUSE_MS * 5);
  expect(sent).toHaveLength(1);
  await answer("wiki.search.result", SEARCH);
  await wait(SEARCH_PAUSE_MS);
  expect(sent.at(-1)).toMatchObject({ kind: "wiki.search", p: { query: "備份腳本" } });
  expect(sent).toHaveLength(2);
});

test("a request with no answer is let go after a while, so the next search can go", async () => {
  await render(<Probe live={true} />);
  await answer("wiki.status.result", STATUS);
  await send({ type: "view", view: "wiki" });
  await answer("wiki.list.result", LIST);
  await answer("wiki.page.result", PAGE);
  await send({ type: "query", query: "備份" });
  await wait(SEARCH_PAUSE_MS);
  await send({ type: "query", query: "FTS5" });
  await wait(ANSWER_WITHIN_MS - 1);
  expect(kinds().filter((k) => k === "wiki.search")).toHaveLength(1);
  // Another request in the meantime does not put the first one's timer off.
  await send({ type: "source", ref: "0a1b2c3d/4e5f6a7b" });
  await wait(1);
  expect(state.pending).not.toHaveProperty(sent.find((x) => x.kind === "wiki.search")?.id ?? "");
  await wait(SEARCH_PAUSE_MS);
  expect(sent.filter((x) => x.kind === "wiki.search").at(-1)).toMatchObject({
    p: { query: "FTS5" },
  });
});

test("the source overlay asks for its mark with the page it was opened from", async () => {
  await render(<Probe live={true} />);
  await answer("wiki.status.result", STATUS);
  await send({ type: "select", path: "projects/nas-backup" });
  await send({ type: "source", ref: "0a1b2c3d/4e5f6a7b" });
  expect(sent.at(-1)).toMatchObject({
    kind: "wiki.source",
    p: { ref: "0a1b2c3d/4e5f6a7b", page: "projects/nas-backup" },
  });
});

test("a drop lets every waiting request go", async () => {
  const r = await render(<Probe live={true} />);
  expect(Object.keys(state.pending)).toHaveLength(1);
  await r.rerender(<Probe live={false} />);
  expect(state.pending).toEqual({});
});
