// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { button, buttons, render } from "../../render.ts";
import { LIST, PAGE, REF, REF2, SEARCH, STATUS } from "../../wiki/fixtures.ts";
import { type WikiEvent, type WikiState, wikiInitial } from "../../wiki/state.ts";
import { SourceOverlay } from "./SourceOverlay.tsx";
import { WikiSideList, WikiTabs } from "./WikiSidebar.tsx";
import { WikiWorkspace } from "./WikiWorkspace.tsx";

const NOW = new Date(2026, 10, 22, 14, 0).getTime();
const open: WikiState = {
  ...wikiInitial,
  available: true,
  view: "wiki",
  status: STATUS,
  list: LIST,
  selected: PAGE.path,
  page: PAGE,
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function workspace(wiki: WikiState, offline = false) {
  const events: WikiEvent[] = [];
  const jumps: string[] = [];
  return render(
    <WikiWorkspace
      wiki={wiki}
      offline={offline}
      now={NOW}
      dispatch={(e) => events.push(e)}
      onJump={(c) => jumps.push(c)}
    />,
  ).then((r) => ({ ...r, events, jumps }));
}

test("the tabs show the page count; the knowledge-base tab opens it", async () => {
  const events: WikiEvent[] = [];
  const { root } = await render(
    <WikiTabs wiki={{ ...open, view: "chat" }} dispatch={(e) => events.push(e)} />,
  );
  const tabs = [...root.querySelectorAll("[role=tab]")];
  expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([
    ["對話", "true"],
    ["知識庫 4", "false"],
  ]);
  await act(async () => (tabs[1] as HTMLButtonElement).click());
  expect(events).toEqual([{ type: "view", view: "wiki" }]);
});

test("the sidebar lists the pages of a category with the six counts, and says when more exist", async () => {
  const events: WikiEvent[] = [];
  const picked = vi.fn();
  const r = await render(
    <WikiSideList
      wiki={{ ...open, category: "projects", list: { ...LIST, more: true } }}
      now={NOW}
      dispatch={(e) => events.push(e)}
      onPicked={picked}
    />,
  );
  expect([...r.root.querySelectorAll(".wiki-cat-pill")].map((p) => p.textContent)).toEqual([
    "全部 4",
    "人物 1",
    "專案 2",
    "主題 0",
    "個人生活 0",
    "學習 1",
    "投資 0",
  ]);
  const rows = [...r.root.querySelectorAll(".conv-item")];
  expect(rows.map((x) => x.textContent)).toEqual([
    "NAS 備份腳本專案 · projects今天",
    "broken讀不到專案 · projects",
  ]);
  expect(rows[0]?.classList.contains("active")).toBe(true);
  expect(r.root.textContent).toContain("還有頁面沒列出");
  await act(async () => (rows[1] as HTMLButtonElement).click());
  expect(events).toEqual([{ type: "select", path: "projects/broken" }]);
  expect(picked).toHaveBeenCalledOnce();
});

test("offline shows nothing old, only that the knowledge base lives on the computer", async () => {
  const { root } = await workspace(open, true);
  expect(root.querySelector("h2")?.textContent).toBe("本機端離線，無法載入知識庫");
  expect(root.querySelector(".wiki-workspace")).toBeNull();
});

test("before the first sync it says to run tars wiki sync on the computer", async () => {
  const { root } = await workspace({
    ...wikiInitial,
    available: true,
    view: "wiki",
    status: { ...STATUS, synced: false, total: 0, examples: [] },
  });
  expect(root.textContent).toContain("知識庫還是空的");
  expect(root.querySelector("code")?.textContent).toBe("tars wiki sync");
});

test("a page: banner, entries with their sources, related pages, the two-column change log", async () => {
  const { root, events } = await workspace(open);
  expect(root.querySelector(".wiki-page-title")?.textContent).toBe("NAS 備份腳本");
  expect([...root.querySelectorAll(".wiki-title-badges > *")].map((x) => x.textContent)).toEqual([
    "專案 · projects",
    "網頁端唯讀",
    "projects/nas-backup.md",
  ]);
  expect(root.querySelector(".wiki-sync-stamp")?.textContent).toBe("上次 sync：今天 13:15");
  // The summary's source mark is a pill between its words.
  const summary = root.querySelector(".wiki-summary") as HTMLElement;
  expect(summary.textContent).toBe(`每晚把 NAS 同步到外接硬碟 [[source:${REF}]]，保留 30 天。`);
  expect(summary.querySelectorAll("button.wiki-cite-pill")).toHaveLength(1);

  const rows = [...root.querySelectorAll(".wiki-item-row")];
  expect(rows.map((x) => x.querySelector(".wiki-item-id")?.textContent)).toEqual([
    "[i1]",
    "[i2]",
    "[i3]",
  ]);
  // Only the entry sync checked says 已驗證引用; the hand-edited one does not.
  expect(rows[0]?.querySelector(".sg-tag.ok")?.textContent).toBe("已驗證引用");
  expect(rows[1]?.querySelector(".sg-tag.ok")).toBeNull();
  expect(rows[1]?.textContent).toContain("（助理的說法）");

  await act(async () => button(root, `[[source:${REF2}]]`).click());
  expect(events).toEqual([{ type: "source", ref: REF2 }]);

  const related = buttons(root).filter(
    (b) => b.textContent?.startsWith("[[") && !b.textContent.includes("source:"),
  );
  expect(related.map((b) => [b.textContent, b.disabled])).toEqual([
    ["[[learning/sqlite-fts5]]", false],
    ["[[topics/gone]]", true],
  ]);
  await act(async () => related[0]?.click());
  expect(events.at(-1)).toEqual({ type: "select", path: "learning/sqlite-fts5" });

  expect(
    [...root.querySelectorAll(".wiki-changelog-row")].map((x) =>
      [...x.children].map((c) => c.textContent),
    ),
  ).toEqual([
    ["2026-11-22", "新增 [i2]"],
    ["2026-11-01", "建立頁面"],
  ]);
  expect(root.querySelector(".wiki-ro-footer .cli-copy-cmd")?.textContent).toBe("tars wiki status");
  expect(root.querySelector(".wiki-ro-footer")?.textContent).toContain("tars wiki sync");
});

test("what a page says stays text: no element, image or link comes from it", async () => {
  const { root } = await workspace(open);
  expect(root.textContent).toContain("<img src=https://example.invalid/x.png> 手動改過的一條");
  expect(root.querySelector("img, a, iframe, script")).toBeNull();
  expect(root.querySelector("[style]")).toBeNull();
});

test("a page that cannot be read says which file, and why", async () => {
  const blocked = await workspace({
    ...open,
    selected: "projects/broken",
    page: { state: "blocked", path: "projects/broken", error: "缺少 摘要 段落" },
  });
  expect(blocked.root.querySelector(".wiki-page-card")?.textContent).toContain("這一頁讀不到");
  expect(blocked.root.textContent).toContain("wiki/projects/broken.md");
  expect(blocked.root.textContent).toContain("缺少 摘要 段落");
});

test("example chips come from the status; picking one searches it", async () => {
  const { root, events } = await workspace(open);
  expect([...root.querySelectorAll(".wiki-query-chip")].map((c) => c.textContent)).toEqual(
    STATUS.examples,
  );
  expect(root.querySelector(".wiki-query-chips")?.firstChild?.textContent).toBe("快速示範：");
  await act(async () => button(root, "FTS5").click());
  expect(events).toEqual([{ type: "query", query: "FTS5" }]);
  const none = await workspace({ ...open, status: { ...STATUS, examples: [] } });
  expect(none.root.querySelector(".wiki-query-chips")).toBeNull();
});

test("no query, no tracks; with one, both tracks and the phone's two tabs", async () => {
  const idle = await workspace(open);
  expect(idle.root.querySelector(".dual-track-grid")).toBeNull();
  expect(idle.root.querySelector(".wiki-search-engine-note .mono")?.textContent).toContain(
    "輸入關鍵字直查",
  );
  idle.unmount();

  const { root, events, jumps } = await workspace({ ...open, query: "備份", search: SEARCH });
  expect([...root.querySelectorAll(".mobile-track-tab")].map((t) => t.textContent)).toEqual([
    "Wiki 頁（1）",
    "原始對話（2）",
  ]);
  const panels = [...root.querySelectorAll(".track-panel")];
  expect(panels.map((p) => p.classList.contains("mobile-track-hidden"))).toEqual([false, true]);
  expect(panels.map((p) => p.querySelector(".track-title")?.textContent)).toEqual([
    "軌道 A：Wiki 結構化頁面（1）",
    "軌道 B：原始對話紀錄（2）",
  ]);
  expect(root.querySelector(".wiki-search-engine-note .mono")?.textContent).toBe(
    "直查索引（不經模型、不花費）· FTS5 + CJK 雙字元比對「備份」",
  );
  // A record whose conversation is gone is not a way into it.
  const raw = panels[1] as HTMLElement;
  expect(raw.querySelectorAll("button.track-result-btn")).toHaveLength(1);
  expect(raw.querySelector(".wiki-record-gone")?.textContent).toContain("原始對話已刪除");
  expect(raw.querySelector("button.track-result-btn .mono")?.textContent).toMatch(/· 第 2 回合$/);
  await act(async () => (raw.querySelector("button.track-result-btn") as HTMLElement).click());
  expect(jumps).toEqual(["0a1b2c3d-0000-4000-8000-000000000001"]);
  await act(async () => button(root, "原始對話（2）").click());
  expect(events).toEqual([{ type: "track", track: "raw" }]);
});

test("the source overlay: the turn, its quotes, and the way to it", async () => {
  const closed = vi.fn();
  const jumps: string[] = [];
  // The overlay is a popup under document.body, not in the element it was rendered into.
  await render(
    <SourceOverlay
      phone={false}
      source={{
        ref: REF,
        result: {
          ref: REF,
          found: true,
          conv: "0a1b2c3d-0000-4000-8000-000000000001",
          convTitle: "NAS 備份怎麼排",
          turnNo: 2,
          at: STATUS.lastSyncAt as number,
          owner: "備份要每晚跑",
          assistant: "好，排在 03:00",
          quotes: ["備份要每晚跑"],
        },
      }}
      now={NOW}
      onClose={closed}
      onJump={(c) => jumps.push(c)}
    />,
  );
  const root = document.body;
  expect(root.querySelector("#sheet-title")?.textContent).toBe("原始對話出處對證");
  expect(root.textContent).toContain(`[[source:${REF}]]`);
  expect(root.querySelector(".task-notice.active")?.textContent).toBe(
    "原始對話節錄「備份要每晚跑」",
  );
  await act(async () => button(root, "前往原對話").click());
  expect(jumps).toEqual(["0a1b2c3d-0000-4000-8000-000000000001"]);
  await act(async () => button(root, "關閉").click());
  expect(closed).toHaveBeenCalled();
});

test("a mark with no turn behind it says so and offers no way to a conversation", async () => {
  await render(
    <SourceOverlay
      phone={false}
      source={{ ref: REF, result: { ref: REF, found: false } }}
      now={NOW}
      onClose={() => {}}
      onJump={() => {}}
    />,
  );
  const root = document.body;
  expect(root.textContent).toContain("找不到這個回合");
  expect(buttons(root).some((b) => b.textContent === "前往原對話")).toBe(false);
});
