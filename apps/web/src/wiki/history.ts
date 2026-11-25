import { WIKI_PATH } from "@tars/protocol";
import { useEffect, useMemo, useRef } from "react";

/** Where a page was opened from: what going back from it returns to. */
export type From = "list" | "search" | "link";

/**
 * One entry this page pushed: a page of the knowledge base, read on a phone. Small and
 * serialisable (history.state survives a reload), no page text. `base` is the page shown before
 * the first entry, where going back past all of them lands.
 */
export interface Entry {
  readonly tars: "wiki";
  readonly path: string;
  readonly base?: string;
  readonly from: From;
  /** 1 for the first entry pushed, and so on: how many to go back to leave them all. */
  readonly depth: number;
}

const FROM: readonly unknown[] = ["list", "search", "link"];

export const isEntry = (s: unknown): s is Entry => {
  if (typeof s !== "object" || s === null) return false;
  const e = s as Record<string, unknown>;
  return (
    e["tars"] === "wiki" &&
    typeof e["path"] === "string" &&
    WIKI_PATH.test(e["path"]) &&
    (e["base"] === undefined || (typeof e["base"] === "string" && WIKI_PATH.test(e["base"]))) &&
    FROM.includes(e["from"]) &&
    typeof e["depth"] === "number" &&
    Number.isInteger(e["depth"]) &&
    e["depth"] > 0
  );
};

/** The entry the browser is on, when it is one of ours. */
export const entryNow = (): Entry | undefined => {
  try {
    return isEntry(history.state) ? history.state : undefined;
  } catch {
    return undefined;
  }
};

/** How long a rewind may take before it is taken as done: no popstate came. */
const REWIND_MS = 1_000;

/**
 * The browser's back for the knowledge base on a phone (ui_spec 5.7: a page fills the screen,
 * with a back button). Each page opened from the list, a search result or a link pushes an entry,
 * so iOS's edge swipe and Android's back key go back a page, not out of the app; popstate does
 * what the back button does. Not on a desktop, where the list stays beside the page.
 *
 * Left (the conversations, a desktop's width, the knowledge base gone): the entries pushed are
 * gone back over, so the browser's back is what it was without them, leaving the app. Their
 * popstate is not a step back, and a page opened meanwhile is pushed once they are gone.
 */
export function useWikiHistory(o: {
  /** A phone, on the knowledge base. */
  active: boolean;
  selected: string | undefined;
  /** Shows a page, without pushing. */
  select: (path: string) => void;
  /** Back to the list: the drawer. */
  toList: () => void;
  /** Back to the search results. */
  toResults: () => void;
}) {
  const opts = useRef(o);
  opts.current = o;
  /** The entry the browser is on, as this page last saw it. */
  const at = useRef<Entry | undefined>(undefined);
  /** Going back over our entries: until it is done, popstate is not a step back. */
  const rewinding = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** A page opened while rewinding, pushed when that is done. */
  const later = useRef<{ path: string; from: From; before: string | undefined } | undefined>(
    undefined,
  );

  const api = useMemo(() => {
    /** `before`: the page shown when it was opened, which may have changed by the time it goes. */
    const put = (path: string, from: From, before: string | undefined) => {
      const top = at.current;
      const base = top === undefined ? before : top.base;
      const e: Entry = {
        tars: "wiki",
        path,
        ...(base === undefined ? {} : { base }),
        from,
        depth: (top?.depth ?? 0) + 1,
      };
      history.pushState(e, "");
      at.current = e;
    };
    const push = (path: string, from: From) => {
      const { active, selected } = opts.current;
      if (!active || path === selected) return;
      if (rewinding.current !== undefined) later.current = { path, from, before: selected };
      else put(path, from, selected);
    };
    const rewound = () => {
      clearTimeout(rewinding.current);
      rewinding.current = undefined;
      at.current = entryNow();
      const next = later.current;
      later.current = undefined;
      if (next !== undefined && opts.current.active) put(next.path, next.from, next.before);
    };
    return {
      push,
      rewound,
      /** The back button: one entry back, or, with none of ours, the list. */
      back: () => {
        if (rewinding.current === undefined && at.current !== undefined) history.back();
        else opts.current.toList();
      },
    };
  }, []);

  // On first render, and whenever it is left: our entries go. A reload finds them in history,
  // and keeps them while the phone is still on the knowledge base.
  useEffect(() => {
    if (at.current === undefined) at.current = entryNow();
    if (o.active || rewinding.current !== undefined) return;
    const depth = at.current?.depth ?? 0;
    if (depth === 0) return;
    rewinding.current = setTimeout(api.rewound, REWIND_MS);
    history.go(-depth);
  }, [o.active]);

  useEffect(() => {
    const pop = (ev: PopStateEvent) => {
      const dest = isEntry(ev.state) ? ev.state : undefined;
      if (rewinding.current !== undefined) {
        if (dest === undefined) api.rewound();
        return;
      }
      const left = at.current;
      at.current = dest;
      if (!opts.current.active) return;
      // Forward: the page that entry opened.
      if (dest !== undefined && dest.depth > (left?.depth ?? 0)) {
        opts.current.select(dest.path);
        return;
      }
      if (left === undefined) return;
      const path = dest?.path ?? left.base;
      if (path !== undefined) opts.current.select(path);
      if (left.from === "list") opts.current.toList();
      else if (left.from === "search") opts.current.toResults();
    };
    addEventListener("popstate", pop);
    return () => {
      removeEventListener("popstate", pop);
      clearTimeout(rewinding.current);
    };
  }, []);

  return api;
}
