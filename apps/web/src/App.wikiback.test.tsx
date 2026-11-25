// @vitest-environment jsdom
import type { ServerMessage, WikiPage } from "@tars/protocol";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { render } from "./render.ts";
import { server, socketHarness } from "./testing.ts";
import { LIST, PAGE, SEARCH, STATUS } from "./wiki/fixtures.ts";
import { entryNow } from "./wiki/history.ts";

// The phone's back for the knowledge base (ui_spec 5.7; wiki.back brief A): each page opened from
// the list, a search result or a link pushes an entry, so the browser's back (iOS's edge swipe,
// Android's back key) goes back a page and not out of the app. Unmounted and mounted again with
// the same history and sessionStorage is a reload here, as in App.reload.test.tsx.

const KEY = "tars.page";
let phone = true;
let changed: (() => void)[] = [];
/** The window made a desktop's width, or a phone's: the media queries say so. */
const resize = (toPhone: boolean) =>
  act(async () => {
    phone = toPhone;
    for (const f of changed) f();
  });

beforeEach(() => {
  vi.useFakeTimers();
  phone = true;
  changed = [];
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return phone && /max-width/.test(q);
    },
    addEventListener: (_: string, f: () => void) => void changed.push(f),
    removeEventListener: (_: string, f: () => void) => {
      changed = changed.filter((g) => g !== f);
    },
  }));
  // Each test starts on an entry not ours, with nothing kept.
  history.replaceState(null, "");
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

type Ok = Extract<WikiPage, { state: "ok" }>;
const page = (path: string, title: string): WikiPage => ({ ...(PAGE as Ok), path, title });
const PAGES: Record<string, WikiPage> = {
  "projects/nas-backup": PAGE,
  "people/wang-xiaoming": page("people/wang-xiaoming", "王小明"),
  "learning/sqlite-fts5": page("learning/sqlite-fts5", "SQLite FTS5"),
};

/** Lets the browser's history traversal (a task) and the answers run. */
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)));

async function load() {
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  await act(async () => h.last().ready());
  const receive = (m: ServerMessage) => act(async () => h.last().receive(m));
  await receive(server("relay.status", { online: true, localSince: 1 }));
  await receive(server("conv.list.result", { convs: [] }));
  const sent = () => h.last().messages();
  const asked = (kind: string) => sent().findLast((m) => m.kind === kind);
  const answered = new Set<string>();
  /** Answers each wiki request not yet answered: status, list, pages, searches. */
  const answer = async () => {
    for (const m of sent()) {
      if (answered.has(m.id) || !m.kind.startsWith("wiki.")) continue;
      answered.add(m.id);
      const p = m.p as { path?: string };
      const reply =
        m.kind === "wiki.status"
          ? server("wiki.status.result", STATUS, { re: m.id })
          : m.kind === "wiki.list"
            ? server("wiki.list.result", LIST, { re: m.id })
            : m.kind === "wiki.page"
              ? server("wiki.page.result", PAGES[p.path ?? ""] ?? PAGE, { re: m.id })
              : m.kind === "wiki.search"
                ? server("wiki.search.result", SEARCH, { re: m.id })
                : undefined;
      if (reply !== undefined) await receive(reply);
    }
  };
  await answer();
  const q = <T extends Element>(sel: string) => document.querySelector<T>(sel);
  const shown = () => q(".wiki-workspace h1, .wiki-workspace h2")?.textContent;
  const drawerOpen = () => q(".sidebar.mobile-open") !== null;
  const back = () => q<HTMLButtonElement>('header button[aria-label="返回"]');
  const menu = () => act(async () => q<HTMLButtonElement>('[aria-label="展開對話列表"]')?.click());
  const tab = (name: string) =>
    act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((b) => b.textContent?.startsWith(name))
        ?.click(),
    );
  /** Opens the knowledge base from the drawer, and the page titled `title` from its list. */
  const fromList = async (title: string) => {
    if (!drawerOpen()) await menu();
    if (q(".wiki-workspace") === null) {
      await tab("知識庫");
      await answer();
    }
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[aria-label="對話列表"] button')]
        .find((b) => b.textContent?.startsWith(title))
        ?.click(),
    );
    await answer();
    await flush();
  };
  /** A related page's link, by its path. */
  const link = async (path: string) => {
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>(".wiki-cite-pill")]
        .find((b) => b.textContent === `[[${path}]]`)
        ?.click(),
    );
    await answer();
    await flush();
  };
  const goBack = async (n = 1) => {
    await act(async () => history.go(-n));
    await flush();
    await answer();
  };
  return {
    h,
    ...r,
    sent,
    asked,
    answer,
    q,
    shown,
    drawerOpen,
    back,
    menu,
    tab,
    fromList,
    link,
    goBack,
  };
}

test("a phone: a page from the list pushes an entry, and back returns to the list", async () => {
  const p = await load();
  await p.fromList("王小明");
  expect(p.drawerOpen()).toBe(false);
  expect(entryNow()).toEqual({
    tars: "wiki",
    path: "people/wang-xiaoming",
    base: "projects/nas-backup",
    from: "list",
    depth: 1,
  });
  expect(p.back()).not.toBeNull();
  await p.goBack();
  expect(entryNow()).toBeUndefined();
  expect(p.drawerOpen()).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "{}").wiki.selected).toBe("projects/nas-backup");
  p.unmount();
});

test("the back button goes back an entry as the browser's does", async () => {
  const p = await load();
  await p.fromList("王小明");
  await act(async () => p.back()?.click());
  await flush();
  await p.answer();
  expect(entryNow()).toBeUndefined();
  expect(p.drawerOpen()).toBe(true);
  p.unmount();
});

test("with no entry of ours (opened by the tab), the back button opens the list; the history does not move", async () => {
  const p = await load();
  await p.menu();
  await p.tab("知識庫");
  await p.answer();
  await act(
    async () =>
      void document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  await flush();
  expect(p.drawerOpen()).toBe(false);
  const before = history.length;
  await act(async () => p.back()?.click());
  await flush();
  expect(p.drawerOpen()).toBe(true);
  expect(history.length).toBe(before);
  p.unmount();
});

test("a link to another page pushes; back steps back page by page, the drawer left shut", async () => {
  const p = await load();
  await p.fromList("NAS 備份腳本");
  expect(entryNow()).toBeUndefined();
  await p.link("learning/sqlite-fts5");
  expect(entryNow()).toMatchObject({ path: "learning/sqlite-fts5", from: "link", depth: 1 });
  await p.goBack();
  expect(p.drawerOpen()).toBe(false);
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "{}").wiki.selected).toBe("projects/nas-backup");
  p.unmount();
});

test("a search result pushes (from search); back shows the page before, the results kept", async () => {
  const p = await load();
  await p.fromList("王小明");
  await p.goBack();
  await act(
    async () =>
      void document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="對話列表"] button')]
      .find((b) => b.textContent?.startsWith("王小明"))
      ?.click(),
  );
  await p.answer();
  await flush();
  const box = p.q<HTMLInputElement>(".wiki-workspace input");
  await act(async () => {
    // oxlint-disable-next-line typescript/unbound-method
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(box, "FTS5");
    box?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The search goes once typing stops.
  await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
  await p.answer();
  const hit = [...document.querySelectorAll<HTMLButtonElement>(".track-result-btn")][0];
  expect(hit).toBeDefined();
  await act(async () => hit?.click());
  await p.answer();
  // On top of 王小明's, opened from the list again.
  expect(entryNow()).toMatchObject({ path: "projects/nas-backup", from: "search", depth: 2 });
  await p.goBack();
  expect(entryNow()).toMatchObject({ path: "people/wang-xiaoming", depth: 1 });
  expect(p.drawerOpen()).toBe(false);
  expect(p.q(".dual-track-grid")).not.toBeNull();
  p.unmount();
});

test("a desktop pushes nothing and has no back button", async () => {
  phone = false;
  const p = await load();
  const before = history.length;
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.startsWith("知識庫"))
      ?.click(),
  );
  await p.answer();
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>(".conv-list button, aside button")]
      .find((b) => b.textContent?.startsWith("王小明"))
      ?.click(),
  );
  await p.answer();
  await flush();
  expect(history.length).toBe(before);
  expect(entryNow()).toBeUndefined();
  expect(p.back()).toBeNull();
  p.unmount();
});

test("back to the conversations: the entries pushed are gone back over; the browser's back then leaves as before", async () => {
  const p = await load();
  await p.fromList("王小明");
  await p.link("learning/sqlite-fts5");
  expect(entryNow()?.depth).toBe(2);
  await p.menu();
  await p.tab("對話");
  await flush();
  expect(entryNow()).toBeUndefined();
  expect(p.back()).toBeNull();
  p.unmount();
});

test("in and out fast: a page, the conversations, the knowledge base and a page again before the rewind is done (a)", async () => {
  const p = await load();
  await p.fromList("王小明");
  // No flush between: the rewind's popstate has not come when the next page is opened.
  await p.menu();
  await p.tab("對話");
  await p.tab("知識庫");
  await p.answer();
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="對話列表"] button')]
      .find((b) => b.textContent?.startsWith("SQLite FTS5"))
      ?.click(),
  );
  await p.answer();
  await flush();
  await flush();
  // One entry, the last page, on top of the first: none left over, the depth right.
  expect(entryNow()).toMatchObject({ path: "learning/sqlite-fts5", depth: 1 });
  // The rewind's popstate was not a step back: the page opened stays, the drawer shut.
  expect(p.shown()).toContain("SQLite FTS5");
  expect(p.drawerOpen()).toBe(false);
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "{}").wiki.selected).toBe(
    "learning/sqlite-fts5",
  );
  await p.goBack();
  expect(entryNow()).toBeUndefined();
  p.unmount();
});

test("a reload keeps the entries: back after it still steps back a page", async () => {
  const first = await load();
  await first.fromList("王小明");
  await first.link("learning/sqlite-fts5");
  first.unmount();
  const p = await load();
  await p.answer();
  expect(p.shown()).toContain("SQLite FTS5");
  expect(p.back()).not.toBeNull();
  await p.goBack();
  expect(entryNow()).toMatchObject({ path: "people/wang-xiaoming", depth: 1 });
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "{}").wiki.selected).toBe(
    "people/wang-xiaoming",
  );
  p.unmount();
});

test("a reload in the middle of going back: the browser's entry wins over what storage had (b)", async () => {
  const first = await load();
  await first.fromList("王小明");
  await first.link("learning/sqlite-fts5");
  first.unmount();
  // The browser went back an entry, and the page reloaded before storage caught up with it.
  history.back();
  await vi.advanceTimersByTimeAsync(10);
  expect(entryNow()?.path).toBe("people/wang-xiaoming");
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "{}").wiki.selected).toBe(
    "learning/sqlite-fts5",
  );
  const p = await load();
  await p.answer();
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "{}").wiki.selected).toBe(
    "people/wang-xiaoming",
  );
  expect(p.asked("wiki.page")?.p).toEqual({ path: "people/wang-xiaoming" });
  await p.goBack();
  expect(entryNow()).toBeUndefined();
  expect(p.drawerOpen()).toBe(true);
  p.unmount();
});

test("the same page picked again pushes nothing", async () => {
  const p = await load();
  await p.fromList("王小明");
  const before = history.length;
  await p.fromList("王小明");
  expect(history.length).toBe(before);
  expect(entryNow()?.depth).toBe(1);
  p.unmount();
});

test("widened to a desktop: the entries go, and so does the back button; narrowed again, a page pushes anew", async () => {
  const p = await load();
  await p.fromList("王小明");
  await p.link("learning/sqlite-fts5");
  expect(entryNow()?.depth).toBe(2);
  await resize(false);
  await flush();
  expect(entryNow()).toBeUndefined();
  expect(p.back()).toBeNull();
  await resize(true);
  await flush();
  expect(p.back()).not.toBeNull();
  await p.link("learning/sqlite-fts5");
  expect(entryNow()).toBeUndefined();
  await p.fromList("王小明");
  expect(entryNow()).toMatchObject({
    path: "people/wang-xiaoming",
    base: "learning/sqlite-fts5",
    depth: 1,
  });
  p.unmount();
});
