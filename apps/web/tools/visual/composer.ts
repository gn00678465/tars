// The composer in Chromium (M4-P3c), at desktop width with a mouse and at phone width with touch:
//   its box grows with the lines typed, from two to 180px, then scrolls inside;
//   a keyboard taking the bottom of the screen (the viewport made shorter, as Chromium cannot
//   raise a real one) leaves the box and its send button on screen;
//   a turn of its own running, the button is 停止, and 送出 is gone; with none, 送出 sends;
//   the / menu, open, is drawn on top and covers no pinned card's buttons; Esc gives them back.
// Where the menu is, over a card in the thread or above a pinned one, is told, not judged: main
// draws it the same (M4-P3c's report), and the menu and the pinned stack are not this change's.
// It fails on any CSP violation or page error (zod's eval probe left out, as csp.ts).
//   node tools/visual/composer.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/composer/.
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { conv, drawer, sceneOf, WIDTHS } from "./overlays.ts";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { NOW } from "./scenes.ts";

const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "composer");
await buildTree(web, dir, true);
const { url, server } = await serve(dir);
const { isProbe } = zodProbe(dir, url);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});
const failures: string[] = [];
const results: string[] = [];
const check = (ok: boolean, what: string) => (ok ? results : failures).push(what);
const round = (n: number) => Math.round(n * 10) / 10;

type Width = keyof typeof WIDTHS;
const BOX = ".composer-box";
const AREA = "#composer-input";

async function opened(width: Width, scene: number, title: string) {
  const context = await browser.newContext({ ...WIDTHS[width], locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => failures.push(`${width}: page error: ${e.message}`));
  await page.clock.setFixedTime(NOW);
  await page.goto(`${url}/?scene=${scene}`, { waitUntil: "load" });
  if (width === "phone") await page.locator(drawer).click();
  await page.locator(conv(title)).first().click();
  await page.locator(AREA).waitFor();
  await page.waitForTimeout(300);
  return { context, page };
}

async function violations(page: Page, where: string) {
  const seen = (await page.evaluate(
    () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
  )) as Violation[];
  for (const v of seen.filter((v) => !isProbe(v)))
    failures.push(`${where}: CSP ${JSON.stringify(v)}`);
}

const box = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r === undefined ? null : { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }, selector);
type Box = NonNullable<Awaited<ReturnType<typeof box>>>;
const apart = (a: Box, b: Box) =>
  a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;

/** Whether the middle of `selector` is the element itself, not something drawn over it. */
const onTop = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    const r = e?.getBoundingClientRect();
    if (e === null || r === undefined) return false;
    const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return at !== null && e.contains(at);
  }, selector);

async function grows(width: Width, where: string) {
  const { context, page } = await opened(width, sceneOf("對話進行中"), "整理 NAS 備份腳本");
  const area = page.locator(AREA);
  const height = () => area.evaluate((e) => e.getBoundingClientRect().height);
  const empty = await height();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `第 ${i + 1} 行`).join("\n");
  const at: number[] = [];
  for (const n of [2, 4, 12]) {
    await area.fill(lines(n));
    await page.waitForTimeout(100);
    at.push(await height());
  }
  const scrolls = await area.evaluate((e) => e.scrollHeight > e.clientHeight);
  const lineH = await area.evaluate((e) => Number.parseFloat(getComputedStyle(e).lineHeight));
  check(
    Math.abs((at[0] as number) - empty) < 1 &&
      (at[1] as number) >= empty + 2 * lineH - 1 &&
      Math.abs((at[2] as number) - 180) <= 1 &&
      scrolls,
    `${where} 換行時長高：空白 ${round(empty)} px，2 行 ${round(at[0] as number)}、4 行 ${round(at[1] as number)}、12 行 ${round(at[2] as number)} px（上限 180，行高 ${round(lineH)}），超過時在框內捲動：${scrolls}`,
  );
  await page.screenshot({ path: join(dir, `${width}-grow.png`) });

  // The keyboard: the bottom 40% of the screen gone.
  const v = WIDTHS[width].viewport;
  const short = Math.round(v.height * 0.6);
  await page.setViewportSize({ width: v.width, height: short });
  await page.waitForTimeout(300);
  await area.focus();
  const [b, send] = [await box(page, BOX), await box(page, 'button[type="submit"]')];
  const seen = await onTop(page, 'button[type="submit"]');
  check(
    b !== null && send !== null && b.top >= 0 && b.bottom <= short && send.bottom <= short && seen,
    `${where} 鍵盤佔掉下方 40%（視窗高 ${short} px）：輸入框 ${round(b?.top ?? -1)}–${round(b?.bottom ?? -1)} px，送出鈕底 ${round(send?.bottom ?? -1)} px，按得到：${seen}`,
  );
  await page.screenshot({ path: join(dir, `${width}-keyboard.png`) });
  await page.setViewportSize(v);

  // 送出 sends: the box empties.
  await area.fill("試送一則");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  const after = await area.inputValue();
  const sent = await page.evaluate(() =>
    ((globalThis as { visualSent?: { kind: string }[] }).visualSent ?? []).some(
      (m) => m.kind === "turn.submit",
    ),
  );
  check(sent && after === "", `${where} 沒有回合在跑：送出鈕送出（turn.submit ${sent}），框清空`);
  await violations(page, where);
  await context.close();
}

async function stops(width: Width, where: string) {
  const { context, page } = await opened(width, sceneOf("回合狀態：等待核准"), "整理 NAS 備份腳本");
  const names = await page
    .locator(`${BOX} .composer-toolbar-right > button`)
    .evaluateAll((bs) => bs.map((b) => b.textContent));
  const stop = await onTop(page, `${BOX} .sg-btn-danger`);
  check(
    names.includes("停止") && !names.includes("送出") && stop,
    `${where} 自己的回合在跑：右下是 ${JSON.stringify(names)}，停止鈕按得到：${stop}`,
  );

  // The / menu over a card in the thread (this conversation's, waiting): the card is under the
  // menu only where the menu is, and its buttons are not.
  await page.locator(AREA).fill("/");
  await page.locator("#slash-menu").waitFor();
  const menu = await box(page, "#slash-menu");
  const shown = await onTop(page, "#slash-menu .slash-item.selected");
  const thread = await page.evaluate(() =>
    [...document.querySelectorAll(".thread-scroll .approval-card .sg-btn")]
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.bottom > 0 && r.top < innerHeight)
      .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })),
  );
  const covered = menu === null ? [] : thread.filter((r) => !apart(r, menu));
  check(
    menu !== null && shown,
    `${where} / 選單開著：在 ${round(menu?.top ?? -1)}–${round(menu?.bottom ?? -1)} px，選取的那列在最上層：${shown}；被它蓋住的對話串核准鈕 ${covered.length} 個（看得到的 ${thread.length} 個；選單是暫時的，Esc 或點外面就關）`,
  );
  await page.screenshot({ path: join(dir, `${width}-slash.png`) });
  await violations(page, where);
  await context.close();
}

/** Another conversation's card pinned above the composer, and the / menu opened under it. */
async function pinned(width: Width, where: string) {
  const { context, page } = await opened(width, sceneOf("別的對話的待核准卡"), "整理 NAS 備份腳本");
  const card = ".composer-dock .approval-card";
  await page.locator(card).waitFor();
  await page.locator(AREA).fill("/");
  await page.locator("#slash-menu").waitFor();
  const [menu, cardBox] = [await box(page, "#slash-menu"), await box(page, card)];
  const buttons = await page.evaluate((c) => {
    const out: { top: number; bottom: number; left: number; right: number }[] = [];
    for (const b of document.querySelectorAll(`${c} .sg-btn`)) {
      const r = b.getBoundingClientRect();
      out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    return out;
  }, card);
  const shown = await onTop(page, "#slash-menu .slash-item.selected");
  const covered = menu === null ? -1 : buttons.filter((r) => !apart(r, menu)).length;
  // On a phone the pinned card is taller than the screen and the menu goes above it, off the top
  // (main the same): told, not judged.
  check(
    menu !== null && cardBox !== null && covered === 0,
    `${where} 別的對話的卡釘在輸入框上方時開 / 選單：選單 ${round(menu?.top ?? -1)}–${round(menu?.bottom ?? -1)} px、卡 ${round(cardBox?.top ?? -1)}–${round(cardBox?.bottom ?? -1)} px，選取的那列在最上層：${shown}，蓋住卡上的鈕 ${covered} 個`,
  );
  await page.screenshot({ path: join(dir, `${width}-pinned-slash.png`) });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const back = await page.evaluate((c) => {
    const b = document.querySelector(`${c} .sg-btn-danger`);
    const r = b?.getBoundingClientRect();
    if (b === null || r === undefined) return false;
    const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return at !== null && b.contains(at);
  }, card);
  check(
    (await page.locator("#slash-menu").count()) === 0 && back,
    `${where} Esc 關掉選單後，卡的拒絕鈕按得到：${back}`,
  );
  await violations(page, where);
  await context.close();
}

for (const width of ["desktop", "phone"] as const) {
  const where = width === "desktop" ? "桌面" : "手機";
  try {
    await grows(width, where);
    await stops(width, where);
    await pinned(width, where);
  } catch (e) {
    check(false, `${where}: ${(e as Error).message.split("\n")[0]}`);
  }
}
await browser.close();
server.close();
for (const r of results) console.log(`ok   ${r}`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${results.length} ok, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
