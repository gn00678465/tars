import type { WikiEntry, WikiPage } from "@tars/protocol";
import { useRef } from "react";
import { CopyCommand } from "../CopyCommand.tsx";
import { CATEGORY_LABEL, categoryOf, type WikiEvent, type WikiState } from "../../wiki/state.ts";
import { momentText } from "../../wiki/time.ts";
import "./wiki.css";

// The knowledge base's main column, after the signed-off prototype's renderWikiWorkspace (scene
// 15). Every string from a page or a conversation is a text node: no HTML, no link, no image
// (T16: what sync took from a conversation is data).

const SOURCE_SPLIT = /\[\[source:([0-9a-f]{8}\/[0-9a-f]{8})\]\]/;

interface Props {
  wiki: WikiState;
  /** The local end cannot be reached: nothing old is shown (ui_spec 5.7). */
  offline: boolean;
  now: number;
  dispatch: (e: WikiEvent) => void;
  /** Go to a conversation (a raw record, the source overlay's 前往原對話). */
  onJump: (conv: string) => void;
}

export function WikiWorkspace(props: Props) {
  const { wiki, now, dispatch } = props;
  if (props.offline)
    return (
      <div className="empty-state">
        <h2>本機端離線，無法載入知識庫</h2>
        <p>個人知識庫只存於你的電腦。本機端重新連線後會自動恢復唯讀瀏覽與雙軌搜尋。</p>
      </div>
    );
  if (wiki.status?.synced === false)
    return (
      <div className="empty-state">
        <h2>知識庫還是空的</h2>
        <p>
          在本機執行 <code>tars wiki sync</code>，把對話整理成知識庫頁面。
        </p>
      </div>
    );
  const empty = wiki.status?.total === 0;
  return (
    <div className="wiki-workspace">
      {empty ? (
        <div className="empty-state">
          <h2>知識庫還沒有頁面</h2>
          <p>
            在本機執行 <code>tars wiki sync</code>
            後，整理好的頁面會出現在這裡；原始對話紀錄仍可在下面搜尋。
          </p>
        </div>
      ) : (
        <Banner wiki={wiki} now={now} dispatch={dispatch} />
      )}
      <SearchCard wiki={wiki} dispatch={dispatch} />
      {wiki.query.trim() === "" ? null : <Tracks {...props} />}
      {empty ? null : <PageCard wiki={wiki} dispatch={dispatch} />}
    </div>
  );
}

/** Text with its [[source:…]] marks as pills that open the source overlay. */
function WithSources(props: { text: string; dispatch: (e: WikiEvent) => void }) {
  const parts = props.text.split(SOURCE_SPLIT);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 0 ? (
          part === "" ? null : (
            <span key={i}>{part}</span>
          )
        ) : (
          <CitePill key={i} source={part} dispatch={props.dispatch} />
        ),
      )}
    </>
  );
}

function CitePill(props: { source: string; dispatch: (e: WikiEvent) => void }) {
  return (
    <button
      className="wiki-cite-pill"
      type="button"
      title="點擊預覽原始對話引用片段"
      onClick={() => props.dispatch({ type: "source", ref: props.source })}
    >
      <span>[[source:{props.source}]]</span>
    </button>
  );
}

/** 15-05: the category, 網頁端唯讀, the file, the last sync and the summary. */
function Banner(props: { wiki: WikiState; now: number; dispatch: (e: WikiEvent) => void }) {
  const { wiki } = props;
  const path = wiki.selected;
  if (path === undefined)
    return (
      <section className="sg-card wiki-banner" aria-label="知識庫頁面資訊">
        <div className="skeleton-line" />
      </section>
    );
  const page = wiki.page;
  const cat = categoryOf(path);
  const title =
    page?.state === "ok"
      ? page.title
      : (wiki.list?.pages.find((p) => p.path === path)?.title ?? path.slice(cat.length + 1));
  const last = wiki.status?.lastSyncAt;
  return (
    <section className="sg-card wiki-banner" aria-label="知識庫頁面資訊">
      <div className="wiki-banner-top">
        <div className="wiki-title-group">
          <div className="wiki-title-badges">
            <span className="sg-tag">
              {CATEGORY_LABEL[cat]} · {cat}
            </span>
            <span className="sg-tag ok">網頁端唯讀</span>
            <span className="mono">{path}.md</span>
          </div>
          <h2 className="wiki-page-title">{title}</h2>
        </div>
        <span className="mono wiki-sync-stamp">
          上次 sync：{last === undefined ? "還沒有" : momentText(last, props.now)}
        </span>
      </div>
      {page?.state === "ok" && page.summary !== "" ? (
        <div className="wiki-meta-line">
          <span className="wiki-summary">
            <WithSources text={page.summary} dispatch={props.dispatch} />
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** 15-06: the box, the example chips and what the engine is. */
function SearchCard(props: { wiki: WikiState; dispatch: (e: WikiEvent) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const { query } = props.wiki;
  const q = query.trim();
  const examples = props.wiki.status?.examples ?? [];
  return (
    <section className="sg-card wiki-search-card" aria-label="雙軌搜尋">
      <div className="wiki-search-row">
        <label htmlFor="wiki-search-input" className="sr-only">
          搜尋個人知識庫與原始對話
        </label>
        <input
          ref={input}
          id="wiki-search-input"
          className="wiki-search-input"
          type="search"
          maxLength={100}
          value={query}
          placeholder={
            examples.length === 0
              ? "輸入關鍵字搜尋 Wiki 與原始對話…"
              : `輸入關鍵字搜尋 Wiki 與原始對話（如：${examples.join("、")}）…`
          }
          onChange={(e) => props.dispatch({ type: "query", query: e.target.value })}
        />
        {q === "" ? null : (
          <button
            className="sg-btn"
            type="button"
            onClick={() => {
              props.dispatch({ type: "query", query: "" });
              input.current?.focus();
            }}
          >
            清除
          </button>
        )}
      </div>
      {examples.length === 0 ? null : (
        <div className="wiki-query-chips">
          <span>快速示範：</span>
          {examples.map((chip) => (
            <button
              key={chip}
              className={query === chip ? "wiki-query-chip active" : "wiki-query-chip"}
              type="button"
              onClick={() => props.dispatch({ type: "query", query: chip })}
            >
              {chip}
            </button>
          ))}
        </div>
      )}
      <div className="wiki-search-engine-note">
        <span>雙軌引擎：SQLite FTS5 + CJK bigram + RRF (k=60)</span>
        <span className="mono">
          {q === ""
            ? "輸入關鍵字直查 SQLite FTS5 + CJK 雙字元索引（同義詞擴寫僅於模型呼叫 tars wiki search 時執行）"
            : `直查索引（不經模型、不花費）· FTS5 + CJK 雙字元比對「${q}」`}
        </span>
      </div>
    </section>
  );
}

/** 15-07, 15-08, 15-09: the two tracks side by side; two tabs on a phone. */
function Tracks(props: Props) {
  const { wiki, now, dispatch } = props;
  const r = wiki.search;
  const pages = r?.pages.results ?? [];
  const records = r?.records.results ?? [];
  const waiting = r === undefined;
  const indexedAt = r?.records.indexedAt ?? wiki.status?.indexedAt;
  const tab = (track: "wiki" | "raw", label: string) => (
    <button
      className={wiki.track === track ? "mobile-track-tab active" : "mobile-track-tab"}
      type="button"
      role="tab"
      aria-selected={wiki.track === track}
      onClick={() => dispatch({ type: "track", track })}
    >
      {label}
    </button>
  );
  const panel = (track: "wiki" | "raw") =>
    wiki.track === track ? "sg-card track-panel" : "sg-card track-panel mobile-track-hidden";
  return (
    <>
      <div className="mobile-track-tabs" role="tablist" aria-label="雙軌搜尋結果分頁">
        {tab("wiki", `Wiki 頁（${pages.length}）`)}
        {tab("raw", `原始對話（${records.length}）`)}
      </div>
      <section className="dual-track-grid" aria-label="雙軌搜尋結果" aria-busy={waiting}>
        <div className={panel("wiki")}>
          <div className="track-head">
            <h3 className="track-title">軌道 A：Wiki 結構化頁面（{pages.length}）</h3>
            <span className="sg-tag ok">已驗證引用</span>
          </div>
          {waiting ? (
            <div className="track-result-snippet">搜尋中…</div>
          ) : pages.length === 0 ? (
            <div className="track-result-snippet">無符合的知識庫頁面。</div>
          ) : (
            pages.map((h) => (
              <button
                key={h.path}
                className={
                  h.path === wiki.selected ? "track-result-btn active" : "track-result-btn"
                }
                type="button"
                onClick={() => dispatch({ type: "select", path: h.path })}
              >
                <div className="track-result-top">
                  <span>{h.title}</span>
                  <span className="sg-tag">{CATEGORY_LABEL[categoryOf(h.path)]}</span>
                </div>
                <div className="track-result-snippet">{h.snippet}</div>
              </button>
            ))
          )}
        </div>
        <div className={panel("raw")}>
          <div className="track-head">
            <h3 className="track-title">軌道 B：原始對話紀錄（{records.length}）</h3>
            <span className="sg-tag">
              {indexedAt === undefined ? "還沒有索引" : `索引到 ${momentText(indexedAt, now)}`}
            </span>
          </div>
          {waiting ? (
            <div className="track-result-snippet">搜尋中…</div>
          ) : records.length === 0 ? (
            <div className="track-result-snippet">無符合的原始對話片段。</div>
          ) : (
            records.map((x, i) =>
              x.conv === undefined ? (
                <div key={i} className="track-result-btn wiki-record-gone">
                  <div className="track-result-top">
                    <span>原始對話已刪除</span>
                    <span className="mono">{momentText(x.at, now)}</span>
                  </div>
                  <div className="track-result-snippet">{x.snippet}</div>
                </div>
              ) : (
                <button
                  key={i}
                  className="track-result-btn"
                  type="button"
                  onClick={() => props.onJump(x.conv as string)}
                >
                  <div className="track-result-top">
                    <span>{(x.convTitle ?? "") === "" ? "（沒有標題）" : x.convTitle}</span>
                    <span className="mono">
                      {momentText(x.at, now)}
                      {x.turnNo === undefined ? "" : ` · 第 ${x.turnNo} 回合`}
                    </span>
                  </div>
                  <div className="track-result-snippet">{x.snippet}</div>
                </button>
              ),
            )
          )}
        </div>
      </section>
    </>
  );
}

/** 15-10, 15-12, 15-13: the entries with their sources, the Change Log, the read-only note. */
function PageCard(props: { wiki: WikiState; dispatch: (e: WikiEvent) => void }) {
  const { wiki, dispatch } = props;
  const page = wiki.page;
  return (
    <article className="sg-card wiki-page-card" aria-label="知識庫內容正文">
      {page === undefined ? (
        <div className="conv-skeleton" aria-label="載入頁面中">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      ) : page.state !== "ok" ? (
        <Unreadable page={page} />
      ) : (
        <>
          {page.truncated ? (
            <div className="task-notice warn">
              <div className="task-notice-body">
                <div className="task-notice-desc">
                  這一頁太長，網頁只顯示前面的部分；完整內容在本機的 wiki/{page.path}.md。
                </div>
              </div>
            </div>
          ) : null}
          <Entries title="事實" entries={page.facts} dispatch={dispatch} />
          <Entries title="未決" entries={page.open} dispatch={dispatch} />
          {page.related.length === 0 ? null : (
            <section className="wiki-section">
              <h3 className="wiki-section-title">相關</h3>
              <div className="wiki-cites">
                {page.related.map((path) => {
                  const known = wiki.list?.pages.some((p) => p.path === path) === true;
                  return (
                    <button
                      key={path}
                      className="wiki-cite-pill"
                      type="button"
                      disabled={!known}
                      title={known ? "在知識庫裡打開這一頁" : "這一頁不存在"}
                      onClick={() => dispatch({ type: "select", path })}
                    >
                      <span>[[{path}]]</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          <section className="wiki-section">
            <h3 className="wiki-section-title">異動紀錄（由程式自動寫入 Change Log）</h3>
            <div className="wiki-changelog-list">
              {page.changeLog.length === 0 ? (
                <div className="wiki-changelog-row">還沒有異動紀錄</div>
              ) : (
                page.changeLog.map((c, i) => (
                  <div className="wiki-changelog-row" key={i}>
                    {c.date === "" ? null : <span className="mono">{c.date}</span>}
                    <span>{c.text}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
      <div className="wiki-ro-footer">
        <span>
          網頁端對 <code>MEMORY.md</code> 與 <code>wiki/</code> 嚴格唯讀；寫入與補洞只在本機的{" "}
          <code>tars wiki sync</code> 執行，受每日／每月預算上限保護。看同步狀況：
        </span>
        <CopyCommand command="tars wiki status" />
      </div>
    </article>
  );
}

function Unreadable(props: { page: Exclude<WikiPage, { state: "ok" }> }) {
  return (
    <div className="task-notice warn">
      <div className="task-notice-body">
        <div className="task-notice-title">這一頁讀不到</div>
        <div className="task-notice-desc mono">wiki/{props.page.path}.md</div>
        <div className="task-notice-desc">
          {props.page.state === "blocked"
            ? `檔案不合頁面格式：${props.page.error}`
            : "檔案不存在，或是指向別處的連結（網頁端不跟隨）。"}
        </div>
      </div>
    </div>
  );
}

function Entries(props: {
  title: string;
  entries: readonly WikiEntry[];
  dispatch: (e: WikiEvent) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <section className="wiki-section">
      <h3 className="wiki-section-title">{props.title}</h3>
      {props.entries.map((e) => (
        <div className="wiki-item-row" key={e.id}>
          <span className="wiki-item-id">[{e.id}]</span>
          <div className="wiki-item-body">
            <div className="wiki-item-text">
              {e.text}
              {e.assistant ? <span className="wiki-assistant-mark">（助理的說法）</span> : null}
            </div>
            {e.sources.length === 0 ? null : (
              <div className="wiki-cites">
                {e.sources.map((s) => (
                  <CitePill key={s} source={s} dispatch={props.dispatch} />
                ))}
                {/* Only what sync checked against its quote; an entry edited by hand says nothing. */}
                {e.verified ? <span className="sg-tag ok">已驗證引用</span> : null}
              </div>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
