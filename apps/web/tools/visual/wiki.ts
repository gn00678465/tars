// The knowledge base's sidebar by keyboard (ui_spec 5.7), at desktop width and at phone width in
// the drawer: Tab lands on the chosen category, the arrows change it, Home and End; one more Tab
// is the first page; a source pill opens its check and Esc gives the focus back to it. Also the
// two audit items: the phone's search box ≥44 px, an unknown related page's text ≥4.5:1.
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
await browser.close();
server.close();
for (const r of results) console.log(`ok   ${r}`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${results.length} ok, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
