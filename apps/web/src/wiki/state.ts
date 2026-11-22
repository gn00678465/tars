import type {
  ServerMessage,
  WikiCategory,
  WikiList,
  WikiPage,
  WikiSearch,
  WikiSource,
  WikiStatus,
} from "@tars/protocol";

/**
 * The knowledge base on this page (ui_parity scene 15). It shows only after the local end answered
 * wiki.status: an older one answers bad_message, and then nothing of it is offered (G6).
 */
export interface WikiState {
  /** wiki.status.result came in this page load: the tab, the header button and /wiki show. */
  readonly available: boolean;
  readonly status?: WikiStatus;
  readonly list?: WikiList;
  /**
   * The sidebar's tab and the main column together, as the prototype switches them; the page
   * always opens on the conversations (ui_spec 5.7).
   */
  readonly view: "chat" | "wiki";
  readonly category: WikiCategory | "all";
  /** The page being read, and its answer once it came. */
  readonly selected?: string;
  readonly page?: WikiPage;
  /** What is typed in the search box; searched as it is typed. */
  readonly query: string;
  /** The last query sent, and its answer. */
  readonly searched?: string;
  readonly search?: WikiSearch;
  /** Which track the phone shows. */
  readonly track: "wiki" | "raw";
  /** The source overlay: the ref asked for, and its answer once it came. */
  readonly source?: { readonly ref: string; readonly result?: WikiSource };
  /** Requests waiting for their answer, by message id. */
  readonly pending: Readonly<Record<string, Asked>>;
}

export type Asked = "status" | "list" | "page" | "search" | "source";

export const wikiInitial: WikiState = {
  available: false,
  view: "chat",
  category: "all",
  query: "",
  track: "wiki",
  pending: {},
};

export type WikiEvent =
  | { readonly type: "asked"; readonly id: string; readonly what: Asked; readonly query?: string }
  /** No answer will come: the connection dropped, or a request waited too long. */
  | { readonly type: "forget"; readonly id?: string }
  | { readonly type: "view"; readonly view: "chat" | "wiki" }
  | { readonly type: "category"; readonly category: WikiCategory | "all" }
  | { readonly type: "select"; readonly path: string }
  | { readonly type: "query"; readonly query: string }
  | { readonly type: "track"; readonly track: "wiki" | "raw" }
  | { readonly type: "source"; readonly ref: string | undefined }
  /** /wiki [keyword]: the knowledge base, searching for it. */
  | { readonly type: "slash"; readonly query: string };

const without = (r: Readonly<Record<string, Asked>>, id: string) => {
  const { [id]: _, ...rest } = r;
  return rest;
};

const waiting = (s: WikiState, what: Asked) => Object.values(s.pending).includes(what);

/** A search waits for its answer before the next one goes (the local end queues 32 frames). */
export const searching = (s: WikiState) => waiting(s, "search");

export function wikiReduce(s: WikiState, e: WikiEvent): WikiState {
  switch (e.type) {
    case "asked":
      return {
        ...s,
        pending: { ...s.pending, [e.id]: e.what },
        ...(e.what === "search" && e.query !== undefined ? { searched: e.query } : {}),
      };
    case "forget":
      return { ...s, pending: e.id === undefined ? {} : without(s.pending, e.id) };
    case "view":
      return { ...s, view: e.view };
    case "category":
      return { ...s, category: e.category };
    case "select": {
      const { page: _, ...rest } = s;
      return { ...rest, selected: e.path, view: "wiki" };
    }
    case "query":
      return { ...s, query: e.query };
    case "track":
      return { ...s, track: e.track };
    case "source": {
      const { source: _, ...rest } = s;
      return e.ref === undefined ? rest : { ...rest, source: { ref: e.ref } };
    }
    case "slash":
      return { ...s, view: "wiki", query: e.query, track: "wiki" };
  }
}

/** A message for the knowledge base, or undefined when it is not one. */
export function wikiMessage(s: WikiState, m: ServerMessage): WikiState | undefined {
  const asked = m.re === undefined ? undefined : s.pending[m.re];
  if (asked === undefined) return undefined;
  const base = { ...s, pending: without(s.pending, m.re as string) };
  switch (m.kind) {
    case "wiki.status.result":
      return { ...base, available: true, status: m.p };
    case "wiki.list.result": {
      // The first page is opened when none is: the knowledge base never shows an empty page.
      const first = m.p.pages[0]?.path;
      return {
        ...base,
        list: m.p,
        ...(s.selected === undefined && first !== undefined ? { selected: first } : {}),
      };
    }
    case "wiki.page.result":
      return m.p.path === s.selected ? { ...base, page: m.p } : base;
    case "wiki.search.result":
      return { ...base, search: m.p };
    case "wiki.source.result":
      return s.source?.ref === m.p.ref ? { ...base, source: { ref: m.p.ref, result: m.p } } : base;
    case "nack":
      // An older local end does not know wiki.*: the knowledge base is not offered, no error.
      if (asked === "status") {
        const { status: _, ...rest } = base;
        return { ...rest, available: false, view: "chat" };
      }
      return base;
    default:
      return undefined;
  }
}

/** The six categories in their fixed order (ui_spec 5.7), as the prototype names them. */
export const CATEGORY_LABEL: Readonly<Record<WikiCategory, string>> = {
  people: "人物",
  projects: "專案",
  topics: "主題",
  life: "個人生活",
  learning: "學習",
  investment: "投資",
};

export const categoryOf = (path: string) => path.slice(0, path.indexOf("/")) as WikiCategory;
