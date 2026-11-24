import { id, WIKI_CATEGORIES, WIKI_PATH, type WikiCategory } from "@tars/protocol";
import { categoryOf, type WikiState } from "./wiki/state.ts";

/**
 * Where this tab was, kept across a reload (the pull to refresh): the open conversation, and the
 * knowledge base when it was showing. sessionStorage: each tab its own, gone with the tab. One
 * key, versioned: what does not read as this version is nothing kept. A private window or blocked
 * storage throws: then nothing is kept, and the page starts as it did before, at home on the
 * conversations.
 *
 * Not kept: the search (sent again when typed), the source overlay, the page's text (asked of the
 * local end again).
 */
const KEY = "tars.page";

type Place = Pick<WikiState, "view" | "category" | "selected" | "track">;
export interface Kept {
  readonly conv?: string;
  readonly wiki?: Place;
}

const isCategory = (c: unknown): c is WikiCategory =>
  (WIKI_CATEGORIES as readonly unknown[]).includes(c);

export function readKept(): Kept {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let v: { v?: unknown; conv?: unknown; wiki?: Record<string, unknown> };
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return {};
  }
  if (typeof v !== "object" || v === null || v.v !== 1) return {};
  const conv = id.safeParse(v.conv).success ? (v.conv as string) : undefined;
  const w = typeof v.wiki === "object" && v.wiki !== null ? v.wiki : undefined;
  const selected =
    typeof w?.selected === "string" && WIKI_PATH.test(w.selected) ? w.selected : undefined;
  // The page being read says its category: a category that disagrees gives way.
  const category =
    selected !== undefined
      ? w?.category === "all"
        ? "all"
        : categoryOf(selected)
      : isCategory(w?.category)
        ? w.category
        : "all";
  return {
    ...(conv === undefined ? {} : { conv }),
    ...(w?.view === "wiki"
      ? {
          wiki: {
            view: "wiki",
            category,
            ...(selected === undefined ? {} : { selected }),
            track: w.track === "raw" ? "raw" : "wiki",
          },
        }
      : {}),
  };
}

/**
 * Keeps where the tab is. The knowledge base only while it shows: back on the conversations, or a
 * local end without one, a reload opens the conversations. A page the local end says is missing
 * is shown so, and not opened again on the next reload.
 */
export function keep(conv: string | undefined, wiki: WikiState) {
  const missing = wiki.page?.state === "missing" && wiki.page.path === wiki.selected;
  const place =
    wiki.view === "wiki"
      ? {
          view: "wiki",
          category: wiki.category,
          ...(wiki.selected === undefined || missing ? {} : { selected: wiki.selected }),
          track: wiki.track,
        }
      : undefined;
  try {
    if (conv === undefined && place === undefined) sessionStorage.removeItem(KEY);
    else
      sessionStorage.setItem(
        KEY,
        JSON.stringify({
          v: 1,
          ...(conv === undefined ? {} : { conv }),
          ...(place === undefined ? {} : { wiki: place }),
        }),
      );
  } catch {
    // Not kept: a reload starts at home.
  }
}
