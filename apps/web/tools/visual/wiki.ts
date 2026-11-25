// The knowledge base's sidebar by keyboard (ui_spec 5.7), at desktop width and at phone width in
// the drawer: Tab lands on the chosen category, the arrows change it, Home and End; one more Tab
// is the first page; a source pill opens its check and Esc gives the focus back to it. Also the
// two audit items: the phone's search box ≥44 px, an unknown related page's text ≥4.5:1.
// Then the phone's back (M4 wiki back): a page opened from the list pushes an entry, and the
// browser's back (page.goBack, as iOS's edge swipe and Android's back key) returns to the list
// in the app; a related page's link pushes, and back returns to the page before; the back button
// is there on a phone, ≥44 px, and not on a desktop, where nothing is pushed.
//   node tools/visual/wiki.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/wiki/.
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { drawer, sceneOf, WIDTHS } from "./overlays.ts";
import { buildTree, COLLECT, serve } from "./page.ts";
import { NOW } from "./scenes.ts";

const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "wiki");
await buildTree(web, dir, true);
const { url, server } = await serve(dir);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});
const failures: string[] = [];
const results: string[] = [];
const check = (ok: boolean, what: string) => (ok ? results : failures).push(what);

const focused = (page: Page) =>
  page.evaluate(() => {
    const e = document.activeElement as HTMLElement | null;
    return {
      role: e?.getAttribute("role") ?? e?.tagName.toLowerCase() ?? "",
      text: e?.textContent?.trim() ?? "",
      checked: e?.getAttribute("aria-checked") ?? "",
    };
  });
const rows = (page: Page) =>
  page.locator('[role=list][aria-label="知識庫頁面"]:visible [role=listitem]').count();

/** The contrast of `selector`'s text on what is under it, alpha composited up the tree. */
const contrast = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (ctx === null) return -1;
    const rgba = (c: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[];
      return [r as number, g as number, b as number, (a as number) / 255];
    };
    const layers: number[][] = [];
    for (let e: HTMLElement | null = el; e !== null; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if ((c[3] as number) > 0) layers.push(c);
      if (c[3] === 1) break;
    }
    let bg = [0, 0, 0];
    for (const [r, g, b, a] of layers.reverse())
      bg = [r, g, b].map(
        (v, i) => (v as number) * (a as number) + (bg[i] as number) * (1 - (a as number)),
      );
    const fgc = rgba(getComputedStyle(el).color);
    const fg = [0, 1, 2].map(
      (i) => (fgc[i] as number) * (fgc[3] as number) + (bg[i] as number) * (1 - (fgc[3] as number)),
    );
    const lum = (c: number[]) =>
      c
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * ([0.2126, 0.7152, 0.0722][i] as number), 0);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
    return (a + 0.05) / (b + 0.05);
  }, selector);

for (const width of ["desktop", "phone"] as const) {
  const where = width === "desktop" ? "桌面" : "手機";
  const context = await browser.newContext({
    ...WIDTHS[width],
    locale: "zh-TW",
    reducedMotion: "reduce",
  });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => failures.push(`${where}: page error: ${e.message}`));
  try {
    await page.clock.setFixedTime(NOW);
    await page.goto(`${url}/?scene=${sceneOf("知識庫的一頁")}`, { waitUntil: "load" });
    await page.locator('button:has-text("個人知識庫")').click();
    if (width === "phone") await page.locator(drawer).click();
    await page.locator("[role=radiogroup]:visible").waitFor();
    await page.waitForTimeout(300);

    // Tab from the 知識庫 view tab lands on the chosen category.
    await page.locator('.sidebar-mode-tab:has-text("知識庫"):visible').focus();
    await page.keyboard.press("Tab");
    const first = await focused(page);
    check(
      first.role === "radio" && first.checked === "true" && first.text === "全部 4",
      `${where} Tab 進分類：焦點在「${first.text}」（${first.role}，aria-checked ${first.checked}）`,
    );
    const seen: string[] = [];
    for (const k of ["ArrowRight", "ArrowRight", "ArrowRight", "End", "ArrowRight", "Home"]) {
      await page.keyboard.press(k);
      const f = await focused(page);
      seen.push(`${k}→${f.text}${f.checked === "true" ? "" : "（沒選）"}·${await rows(page)} 頁`);
    }
    check(
      seen.join(" ") ===
        "ArrowRight→人物 1·1 頁 ArrowRight→專案 2·2 頁 ArrowRight→主題 0·0 頁 End→投資 0·0 頁 ArrowRight→全部 4·4 頁 Home→全部 4·4 頁",
      `${where} 方向鍵換分類：${seen.join("、")}`,
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const empty = await page.locator(".wiki-list-note:visible").textContent();
    check(empty === "這個分類還沒有頁面", `${where} 0 頁的分類：「${empty}」`);
    await page.screenshot({ path: join(dir, `${width}-empty-category.png`) });
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    const row = await focused(page);
    check(
      row.text.startsWith("NAS 備份腳本"),
      `${where} 再按一次 Tab 到第一頁：「${row.text.slice(0, 12)}」`,
    );
    await page.screenshot({ path: join(dir, `${width}-sidebar.png`) });
    if (width === "phone") {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      const open = await page.locator(".sidebar.mobile-open").count();
      check(open === 0, `${where} Enter 開頁面，抽屜收起`);
      const box = await page.locator(".wiki-search-input").boundingBox();
      check((box?.height ?? 0) >= 44, `${where} 搜尋框高 ${box?.height} px（≥44）`);
    }

    // The banner: read-only and the last sync.
    const line = await page.locator(".wiki-sync-line:visible").textContent();
    check(
      /^由本機 tars wiki sync 更新 · 上次同步：\S+ \d\d:\d\d$/.test(line ?? ""),
      `${where} 頁面標頭：「${line}」`,
    );
    await page.locator(".wiki-cite-pill:disabled").first().waitFor({ state: "attached" });
    const gone = await contrast(page, ".wiki-cite-pill:disabled");
    check(gone >= 4.5, `${where} 不存在的相關頁 對比 ${gone.toFixed(2)}:1（≥4.5）`);

    // A source pill: Enter opens its check, Esc closes it and gives the focus back.
    const pill = page.locator(".wiki-cite-pill:visible:not(:disabled)").first();
    await pill.focus();
    const name = await pill.textContent();
    await page.keyboard.press("Enter");
    const panel = page.locator('[role=dialog][aria-labelledby="sheet-title"]');
    await panel.waitFor();
    await page.waitForTimeout(300);
    const inside = await page
      .waitForFunction(
        () =>
          document
            .querySelector('[role=dialog][aria-labelledby="sheet-title"]')
            ?.contains(document.activeElement) === true,
        undefined,
        { timeout: 2_000 },
      )
      .then(() => true)
      .catch(() => false);
    await page.screenshot({ path: join(dir, `${width}-source.png`) });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.waitForTimeout(200);
    const back = await focused(page);
    check(
      inside && back.text === name,
      `${where} 來源面板：開啟時焦點在面板內 ${inside}，Esc 後回到「${back.text}」`,
    );
  } catch (e) {
    check(false, `${where}: ${(e as Error).message.split("\n")[0]}`);
  }
  await context.close();
}
// The phone's back, and none on a desktop.
for (const width of ["desktop", "phone"] as const) {
  const where = width === "desktop" ? "桌面" : "手機";
  const context = await browser.newContext({
    ...WIDTHS[width],
    locale: "zh-TW",
    reducedMotion: "reduce",
  });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => failures.push(`${where} 返回: page error: ${e.message}`));
  try {
    await page.clock.setFixedTime(NOW);
    const start = `${url}/?scene=${sceneOf("知識庫的一頁")}`;
    await page.goto(start, { waitUntil: "load" });
    await page.locator('button:has-text("個人知識庫")').click();
    if (width === "phone") await page.locator(drawer).click();
    await page.locator("[role=radiogroup]:visible").waitFor();
    await page.waitForTimeout(300);
    const length = () => page.evaluate(() => history.length);
    const kept = () =>
      page.evaluate(
        () =>
          (
            JSON.parse(sessionStorage.getItem("tars.page") ?? "{}") as {
              wiki?: { selected?: string };
            }
          ).wiki?.selected,
      );
    const opened = () => page.locator(".sidebar.mobile-open").count();
    const back = page.locator('header button[aria-label="返回"]');
    const before = await length();
    await page
      .locator('[role=list][aria-label="知識庫頁面"]:visible button:has-text("王小明")')
      .click();
    await page.waitForTimeout(400);
    if (width === "desktop") {
      check(
        (await length()) === before && (await back.count()) === 0,
        `${where} 開頁面不推 history（${before} → ${await length()}），沒有返回鍵`,
      );
    } else {
      const box = await back.boundingBox();
      check(
        (await length()) === before + 1 &&
          (await opened()) === 0 &&
          (box?.width ?? 0) >= 44 &&
          (box?.height ?? 0) >= 44,
        `${where} 從清單開頁面：history ${before} → ${await length()}，抽屜收起，返回鍵 ${box?.width}×${box?.height}`,
      );
      await back.focus();
      const ring = await back.evaluate((e) => getComputedStyle(e).outlineStyle);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const visible = await back.evaluate(
        (e) => e.matches(":focus-visible") && getComputedStyle(e).outlineStyle !== "none",
      );
      check(visible, `${where} 返回鍵鍵盤聚焦時有焦點框（${ring} → ${visible}）`);
      await page.screenshot({ path: join(dir, "phone-back-page.png") });
      await page.goBack();
      await page.waitForTimeout(400);
      check(
        page.url() === start && (await opened()) === 1 && (await kept()) === "projects/nas-backup",
        `${where} 瀏覽器返回：仍在 app（${page.url() === start}），回到清單（抽屜開 ${await opened()}），頁面回到 ${await kept()}`,
      );
      await page.screenshot({ path: join(dir, "phone-back-list.png") });
      // A related page's link pushes; back returns to the page before, the drawer shut.
      await page
        .locator('[role=list][aria-label="知識庫頁面"]:visible button:has-text("NAS 備份腳本")')
        .click();
      await page.waitForTimeout(400);
      await page
        .locator(".wiki-cite-pill:visible:not(:disabled)", { hasText: "[[learning/" })
        .first()
        .click();
      await page.waitForTimeout(400);
      const linked = await kept();
      await back.click();
      await page.waitForTimeout(400);
      check(
        linked !== "projects/nas-backup" &&
          (await kept()) === "projects/nas-backup" &&
          (await opened()) === 0 &&
          page.url() === start,
        `${where} 連結到 ${linked}，按返回鍵回到 ${await kept()}，抽屜沒開，仍在 app`,
      );
    }
  } catch (e) {
    check(false, `${where} 返回: ${(e as Error).message.split("\n")[0]}`);
  }
  await context.close();
}
await browser.close();
server.close();
for (const r of results) console.log(`ok   ${r}`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${results.length} ok, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
