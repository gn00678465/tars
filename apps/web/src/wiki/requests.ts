import type { ClientKind } from "@tars/protocol";
import { useEffect, useRef } from "react";
import { type Asked, searching, type WikiEvent, type WikiState } from "./state.ts";

/** Typing stops this long before a search goes (邊打邊查, one request at a time). */
export const SEARCH_PAUSE_MS = 200;
/** A request with no answer by then is given up: a local end that failed to read logs it only. */
export const ANSWER_WITHIN_MS = 10_000;
const RESULTS = 20;

interface Sender {
  send(kind: ClientKind, p?: unknown): string | undefined;
}

/**
 * What the knowledge base asks the local end, and when. `live`: the local end said hello on this
 * connection and is online. Every wiki.* is read only; none goes through a model.
 */
export function useWikiRequests(
  socket: Sender,
  wiki: WikiState,
  dispatch: (e: WikiEvent) => void,
  live: boolean,
) {
  const ask = (what: Asked, kind: ClientKind, p: unknown = {}, query?: string) => {
    const id = socket.send(kind, p);
    if (id !== undefined)
      dispatch({ type: "asked", id, what, ...(query === undefined ? {} : { query }) });
  };

  // Each time the local end is reached: one that answers has a knowledge base to offer. No
  // answer comes after a drop, so what waited is let go.
  useEffect(() => {
    if (live) ask("status", "wiki.status");
    else dispatch({ type: "forget" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, socket]);

  // Opening the knowledge base reads the list, and the counts again.
  const shown = wiki.available && wiki.view === "wiki";
  useEffect(() => {
    if (!live || !shown) return;
    ask("status", "wiki.status");
    ask("list", "wiki.list");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, shown, socket]);

  const { selected } = wiki;
  useEffect(() => {
    if (live && shown && selected !== undefined) ask("page", "wiki.page", { path: selected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, shown, selected, socket]);

  // The newest query goes once typing pauses and the last search has its answer.
  const query = wiki.query.trim();
  const busy = searching(wiki);
  useEffect(() => {
    if (!live || wiki.view !== "wiki" || busy || query === "" || query === wiki.searched) return;
    const t = setTimeout(
      () => ask("search", "wiki.search", { query, limit: RESULTS }, query),
      SEARCH_PAUSE_MS,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, wiki.view, busy, query, wiki.searched, socket]);

  const ref = wiki.source?.ref;
  useEffect(() => {
    if (!live || ref === undefined) return;
    ask("source", "wiki.source", { ref, ...(selected === undefined ? {} : { page: selected }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ref, socket]);

  // One timer per request, from when it went: later requests do not put it off.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const forget = useRef(dispatch);
  forget.current = dispatch;
  const ids = Object.keys(wiki.pending).join(" ");
  useEffect(() => {
    const now = new Set(ids === "" ? [] : ids.split(" "));
    for (const [id, t] of timers.current)
      if (!now.has(id)) {
        clearTimeout(t);
        timers.current.delete(id);
      }
    for (const id of now)
      if (!timers.current.has(id))
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            forget.current({ type: "forget", id });
          }, ANSWER_WITHIN_MS),
        );
  }, [ids]);
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach(clearTimeout);
  }, []);
}
