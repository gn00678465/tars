import { WIKI_CATEGORIES } from "@tars/protocol";
import { CATEGORY_LABEL, categoryOf, type WikiEvent, type WikiState } from "../../wiki/state.ts";
import { dateText } from "../../wiki/time.ts";

/** The prototype's 「對話／知識庫 N」 above the list (15-01). */
export function WikiTabs(props: { wiki: WikiState; dispatch: (e: WikiEvent) => void }) {
  const on = props.wiki.view === "wiki";
  return (
    <div className="sidebar-mode-tabs" role="tablist" aria-label="側邊欄檢視模式">
      <button
        className={on ? "sidebar-mode-tab" : "sidebar-mode-tab active"}
        type="button"
        role="tab"
        aria-selected={!on}
        onClick={() => props.dispatch({ type: "view", view: "chat" })}
      >
        對話
      </button>
      <button
        className={on ? "sidebar-mode-tab active" : "sidebar-mode-tab"}
        type="button"
        role="tab"
        aria-selected={on}
        onClick={() => props.dispatch({ type: "view", view: "wiki" })}
      >
        知識庫 <span className="mono sidebar-tab-count">{props.wiki.status?.total ?? 0}</span>
      </button>
    </div>
  );
}

/**
 * The category pills with their page counts (15-02) and the pages in one (15-03), straight inside
 * the sidebar's `.conv-list` as the prototype puts them.
 */
export function WikiSideList(props: {
  wiki: WikiState;
  now: number;
  dispatch: (e: WikiEvent) => void;
  /** A page was picked: the drawer closes on a phone. */
  onPicked: () => void;
}) {
  const { wiki } = props;
  const counts = wiki.status?.counts;
  const pills = [
    { id: "all" as const, label: "全部", count: wiki.status?.total ?? 0 },
    ...WIKI_CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c], count: counts?.[c] ?? 0 })),
  ];
  const pages = (wiki.list?.pages ?? []).filter(
    (p) => wiki.category === "all" || categoryOf(p.path) === wiki.category,
  );
  return (
    <>
      <div className="wiki-cat-pills" role="tablist" aria-label="知識庫分類">
        {pills.map((c) => (
          <button
            key={c.id}
            className={wiki.category === c.id ? "wiki-cat-pill active" : "wiki-cat-pill"}
            type="button"
            role="tab"
            aria-selected={wiki.category === c.id}
            onClick={() => props.dispatch({ type: "category", category: c.id })}
          >
            {c.label} <span className="num">{c.count}</span>
          </button>
        ))}
      </div>
      {wiki.list === undefined ? (
        <div className="conv-skeleton" aria-label="載入知識庫頁面中">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      ) : (
        <>
          {pages.map((p) => {
            const here = wiki.view === "wiki" && p.path === wiki.selected;
            const cat = categoryOf(p.path);
            return (
              <div className="conv-list-row" role="listitem" key={p.path}>
                <button
                  className={here ? "conv-item active" : "conv-item"}
                  type="button"
                  title={p.title}
                  aria-current={here ? "true" : undefined}
                  onClick={() => {
                    props.dispatch({ type: "select", path: p.path });
                    props.onPicked();
                  }}
                >
                  <div className="conv-title-row">
                    <span className="conv-title">{p.title}</span>
                    {p.blocked ? <span className="sg-tag warn">讀不到</span> : null}
                  </div>
                  <div className="conv-meta">
                    <span>
                      {CATEGORY_LABEL[cat]} · {cat}
                    </span>
                    <span className="num">{dateText(p.updated, props.now)}</span>
                  </div>
                </button>
              </div>
            );
          })}
          {pages.length === 0 ? <div className="wiki-list-note">這個分類還沒有頁面</div> : null}
          {wiki.list.more ? <div className="wiki-list-note">還有頁面沒列出</div> : null}
        </>
      )}
    </>
  );
}
