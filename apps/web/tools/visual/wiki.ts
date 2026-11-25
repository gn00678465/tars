// The knowledge base's sidebar by keyboard (ui_spec 5.7), at desktop width and at phone width in
// the drawer: Tab lands on the chosen category, the arrows change it, Home and End; one more Tab
// is the first page; a source pill opens its check and Esc gives the focus back to it. Also the
// two audit items: the phone's search box ≥44 px, an unknown related page's text ≥4.5:1. And the
// focus ring whole on all four sides, nothing it sits in cutting it: each category reached by the
// arrows, the two view tabs, the pages, the search box, the example chips, and on a desktop the
// chat view's first conversation, in the same scroller.
// Then the phone's back (M4 wiki back): a page opened from the list pushes an entry, and the
// browser's back (page.goBack, as iOS's edge swipe and Android's back key) returns to the list
// in the app, and forward (page.goForward) opens that page again with the list put away; a
// related page's link pushes, and back returns to the page before; the back button
// is there on a phone, ≥44 px, and not on a desktop, where nothing is pushed.
//   node tools/visual/wiki.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/wiki/.
import { writeFileSync } from "node:fs";
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

/** A screenshot's pixels, RGBA, decoded in a page of its own. */
async function pixels(png: Buffer) {
  const page = await browser.newPage();
  const got = await page.evaluate(async (b64) => {
    const i = new Image();
    i.src = `data:image/png;base64,${b64}`;
    await i.decode();
    const c = new OffscreenCanvas(i.width, i.height).getContext("2d");
    if (c === null) throw new Error("no canvas");
    c.drawImage(i, 0, 0);
    const d = c.getImageData(0, 0, i.width, i.height);
    return { width: d.width, height: d.height, data: [...d.data] };
  }, png.toString("base64"));
  await page.close();
  return got;
}
/** A screenshot, k times as big, pixel for pixel: a ring 2 px wide, to be seen. */
async function zoom(png: Buffer, k: number, path: string) {
  const page = await browser.newPage();
  const out = await page.evaluate(
    async ([b64, k]) => {
      const i = new Image();
      i.src = `data:image/png;base64,${b64}`;
      await i.decode();
      const canvas = new OffscreenCanvas(i.width * k, i.height * k);
      const c = canvas.getContext("2d");
      if (c === null) throw new Error("no canvas");
      c.imageSmoothingEnabled = false;
      c.drawImage(i, 0, 0, i.width * k, i.height * k);
      const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    },
    [png.toString("base64"), k] as const,
  );
  await page.close();
  writeFileSync(path, Buffer.from(out, "base64"));
}

const PAD = 8;
/**
 * The focused element's ring, side by side: the element focused, then not, and on each side the
 * pixels that changed along the outward normal, from the box out to PAD. A side counts where at
 * least the ring's width changed, sampled over the side's middle half (the corners are round), as
 * % of the samples. A container's overflow cuts the ring to nothing there, or to 1 px.
 */
async function ring(page: Page, shot?: string) {
  const at = await page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      visible: e.matches(":focus-visible"),
      w: Number.parseFloat(s.outlineWidth),
    };
  });
  const vw = page.viewportSize() ?? { width: 0, height: 0 };
  const x0 = Math.max(0, Math.floor(at.x) - PAD);
  const y0 = Math.max(0, Math.floor(at.y) - PAD);
  const clip = {
    x: x0,
    y: y0,
    width: Math.min(vw.width, Math.ceil(at.x + at.width) + PAD) - x0,
    height: Math.min(vw.height, Math.ceil(at.y + at.height) + PAD) - y0,
  };
  const onPng = await page.screenshot({ clip, scale: "css" });
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.waitForTimeout(80);
  const offPng = await page.screenshot({ clip, scale: "css" });
  if (shot !== undefined) await zoom(onPng, 4, shot);
  const [a, b] = [await pixels(onPng), await pixels(offPng)];
  const changed = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= a.width || y >= a.height) return false;
    const k = (y * a.width + x) * 4;
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs((a.data[k + c] ?? 0) - (b.data[k + c] ?? 0));
    return d > 60;
  };
  // The box in the screenshot's pixels.
  const [l, t] = [at.x - clip.x, at.y - clip.y];
  const [r, bt] = [l + at.width, t + at.height];
  const side = (name: "top" | "right" | "bottom" | "left") => {
    const along = name === "top" || name === "bottom" ? at.width : at.height;
    let hits = 0;
    let n = 0;
    for (let i = Math.round(along / 4); i <= Math.round((along * 3) / 4); i++, n++) {
      let got = 0;
      for (let d = 0; d <= PAD; d++) {
        const [x, y] =
          name === "top"
            ? [l + i, t - d]
            : name === "bottom"
              ? [l + i, bt + d]
              : name === "left"
                ? [l - d, t + i]
                : [r + d, t + i];
        if (changed(Math.floor(x), Math.floor(y))) got++;
      }
      if (got >= at.w) hits++;
    }
    return n === 0 ? 0 : Math.round((hits / n) * 100);
  };
  return {
    visible: at.visible,
    top: side("top"),
    right: side("right"),
    bottom: side("bottom"),
    left: side("left"),
  };
}
const whole = (r: Awaited<ReturnType<typeof ring>>) =>
  r.visible && r.top >= 90 && r.right >= 90 && r.bottom >= 90 && r.left >= 90;
const sides = (r: Awaited<ReturnType<typeof ring>>) =>
  `上 ${r.top}% 右 ${r.right}% 下 ${r.bottom}% 左 ${r.left}%${r.visible ? "" : "（沒有 :focus-visible）"}`;

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

    // The ring, whole: each category by the arrows, then the two view tabs and the pages.
    await page.locator('.sidebar-mode-tab:has-text("知識庫"):visible').focus();
    await page.keyboard.press("Tab");
    // Every category, and the last ArrowRight wraps back to 全部.
    const radios = await page.locator("[role=radiogroup]:visible [role=radio]").count();
    for (let i = 0; i < radios; i++) {
      const what = (await focused(page)).text;
      const r = await ring(page, i === 0 ? join(dir, `${width}-ring-pill.png`) : undefined);
      check(whole(r), `${where} 焦點框 分類「${what}」：${sides(r)}`);
      await page.locator("[role=radiogroup]:visible [role=radio][aria-checked=true]").focus();
      await page.keyboard.press("ArrowRight");
    }
    await page.keyboard.press("Shift+Tab");
    for (const name of ["知識庫", "對話"]) {
      const what = (await focused(page)).text;
      const r = await ring(
        page,
        name === "知識庫" ? join(dir, `${width}-ring-tab.png`) : undefined,
      );
      check(whole(r) && what.startsWith(name), `${where} 焦點框 分頁「${what}」：${sides(r)}`);
      await page.locator(`.sidebar-mode-tab:has-text("${name}"):visible`).focus();
      await page.keyboard.press("Shift+Tab");
    }
    await page.locator("[role=radiogroup]:visible [role=radio][aria-checked=true]").focus();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      const what = (await focused(page)).text.slice(0, 12);
      const r = await ring(page, i === 0 ? join(dir, `${width}-ring-page.png`) : undefined);
      check(whole(r), `${where} 焦點框 頁面「${what}」：${sides(r)}`);
      await page.locator('[role=list][aria-label="知識庫頁面"]:visible .conv-item').nth(i).focus();
    }

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

    // The ring, whole, on the search box and the example chips.
    await page.locator(".wiki-search-input").focus();
    {
      const r = await ring(page, join(dir, `${width}-ring-search.png`));
      check(whole(r), `${where} 焦點框 搜尋框：${sides(r)}`);
    }
    const chips = await page.locator(".wiki-query-chip:visible").count();
    await page.locator(".wiki-search-input").focus();
    for (let i = 0; i < chips; i++) {
      await page.keyboard.press("Tab");
      const what = (await focused(page)).text;
      const r = await ring(page, i === 0 ? join(dir, `${width}-ring-chip.png`) : undefined);
      check(whole(r) && what !== "", `${where} 焦點框 快速示範「${what}」：${sides(r)}`);
      await page.locator(".wiki-query-chip:visible").nth(i).focus();
    }
    check(chips > 0, `${where} 快速示範 chip 有 ${chips} 個`);

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

    // The same list in the chat view: its first conversation sits at the scroller's top.
    if (width === "desktop") {
      await page.locator('.sidebar-mode-tab:has-text("對話")').focus();
      await page.keyboard.press("Enter");
      await page.locator('.conv-list[aria-label="歷史對話"] .conv-item').first().focus();
      const what = (await focused(page)).text.slice(0, 12);
      const r = await ring(page, join(dir, `${width}-ring-conversation.png`));
      check(whole(r), `${where} 焦點框 對話檢視第一列「${what}」：${sides(r)}`);
    }
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
      const depth = () =>
        page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0);
      await page.goForward();
      await page.waitForTimeout(400);
      check(
        page.url() === start &&
          (await kept()) === "people/wang-xiaoming" &&
          (await opened()) === 0 &&
          (await depth()) === 1,
        `${where} 瀏覽器前進：頁面 ${await kept()}，抽屜開 ${await opened()}，depth ${await depth()}，仍在 app（${page.url() === start}）`,
      );
      await page.screenshot({ path: join(dir, "phone-forward-page.png") });
      await page.goBack();
      await page.waitForTimeout(400);
      check(
        (await kept()) === "projects/nas-backup" && (await opened()) === 1 && (await depth()) === 0,
        `${where} 前進後再返回：頁面 ${await kept()}，抽屜開 ${await opened()}，depth ${await depth()}`,
      );
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
