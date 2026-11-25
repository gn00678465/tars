// Pull to refresh in Chromium, with real touches (CDP Input.dispatchTouchEvent: Playwright's
// touchscreen only taps). At phone width: the page above the composer follows the finger, damped
// and capped; short of the rest it eases back to 0; past it, let go, it settles at the rest and
// the indicator's box and text do not move from 放開重新整理 to 重新整理中…, then the page
// reloads, in a conversation and on the knowledge base, and comes back to the same conversation or
// page; a finger dragging a scrolled thread
// scrolls it both ways, as before. From the top edge (the bar and the conversation's header,
// data-pull-edge) a pull is taken wherever the thread is: at its end in a conversation, scrolled
// down on the knowledge base; the indicator where a pull at the thread's top puts it; the bar's
// buttons still open what they open on a tap, and a drag from one takes nothing. With each of P2's overlays open (overlays.ts), at phone width
// and at desktop width with touch (an iPad), a pull does not reload. A card announced in the middle
// of a pull is still in the accessibility tree beside the bar. At desktop width a mouse drag does
// nothing. It fails on any CSP violation or page error (zod's eval probe left out, as csp.ts).
//   node tools/visual/pull.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/pull/.
import { join, resolve } from "node:path";
import { type CDPSession, chromium, type Page } from "playwright-core";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { OVERLAYS, WIDTHS, sceneOf } from "./overlays.ts";
import { NOW } from "./scenes.ts";

const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "pull");

await buildTree(web, dir, true);
const { url, server } = await serve(dir);
const { isProbe } = zodProbe(dir, url);
/** The indicator's box, ready, from a pull at the thread's top: the edge's must be the same. */
let readyBar = "";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});

const failures: string[] = [];
const results: string[] = [];
const check = (ok: boolean, what: string) => (ok ? results : failures).push(what);

/** What the page raised since it loaded; read before a reload throws it away. */
async function violations(page: Page, where: string) {
  const seen = (await page.evaluate(
    () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
  )) as Violation[];
  const probes = seen.filter(isProbe).length;
  for (const v of seen.filter((v) => !isProbe(v)))
    failures.push(`${where}: CSP ${JSON.stringify(v)}`);
  if (probes > 1) failures.push(`${where}: zod's probe ${probes} times, not once`);
}

/** A finger's way past the rest (56 px of page at 0.5 of the finger). */
const FULL = 140;
const scroller = (page: Page) => page.locator(".thread-scroll");
const scrollTop = (page: Page) => scroller(page).evaluate((el) => el.scrollTop);
const bar = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector(".pull-indicator");
    return b === null ? null : `${b.getAttribute("data-pull")} ${b.textContent}`;
  });

/** One finger down at (x, from) and moved to (x, to), kept down. */
async function hold(cdp: CDPSession, x: number, from: number, to: number) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: from, id: 1 }],
  });
  await moveTo(cdp, x, from, to);
}
async function moveTo(cdp: CDPSession, x: number, from: number, to: number) {
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: from + ((to - from) * i) / 10, id: 1 }],
    });
}
const lift = (cdp: CDPSession) =>
  cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

const OWN =
  'input, textarea, select, button, a[href], label, form, [contenteditable]:not([contenteditable="false"]), pre, table';
/**
 * A point on the edge `sel` that is no control: the middle of its widest stretch free of one, on
 * the line through its middle.
 */
const grip = (page: Page, sel: string) =>
  page.evaluate(
    ([sel, own]) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r === undefined) throw new Error(`no ${sel}`);
      const y = r.y + r.height / 2;
      let best = [0, 0];
      let from = -1;
      for (let x = Math.ceil(r.x); x <= r.right; x++) {
        const e = document.elementFromPoint(x, y);
        const free =
          x < r.right && e !== null && e.closest(sel) !== null && e.closest(own) === null;
        if (free && from < 0) from = x;
        if (!free && from >= 0) {
          if (x - from > (best[1] ?? 0) - (best[0] ?? 0)) best = [from, x];
          from = -1;
        }
      }
      return {
        x: ((best[0] ?? 0) + (best[1] ?? 0)) / 2,
        y,
        width: (best[1] ?? 0) - (best[0] ?? 0),
      };
    },
    [sel, OWN] as const,
  );
/** A tap: one finger down and up at one point. */
async function tap(cdp: CDPSession, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Where the moved parts, the composer and the indicator are, as page y and size. */
const LAYOUT = () => {
  const box = (s: string) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r === undefined ? null : { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  return {
    topbar: box(".topbar"),
    thread: box(".thread-scroll"),
    dock: box(".composer-dock"),
    bar: box(".pull-indicator"),
    text: box(".pull-indicator .pull-text"),
    pull: document.querySelector(".pull-indicator")?.getAttribute("data-pull") ?? "none",
    words: document.querySelector(".pull-indicator .pull-text")?.textContent ?? "",
  };
};
const layout = (page: Page) => page.evaluate(LAYOUT);
type Layout = Awaited<ReturnType<typeof layout>>;
const down = (a: Layout, b: Layout, k: "topbar" | "thread" | "dock") =>
  Math.round(((b[k]?.y ?? 0) - (a[k]?.y ?? 0)) * 10) / 10;

/** One finger from (x, from) to (x, to) in steps; `before` runs while it is still down. */
async function drag(
  cdp: CDPSession,
  x: number,
  from: number,
  to: number,
  before: () => Promise<void> = async () => undefined,
) {
  const at = (y: number) => [{ x, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  await moveTo(cdp, x, from, to);
  await before();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function phone(scene: number, open: (page: Page) => Promise<void>, where: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "zh-TW",
  });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`${where}: page error: ${e.message}`));
  let loads = 0;
  page.on("load", () => loads++);
  const cdp = await context.newCDPSession(page);
  await page.clock.setFixedTime(NOW);
  await page.goto(`${url}/?scene=${scene}`, { waitUntil: "load" });
  await open(page);
  // main's .conv-header-bar is 14 px wider than a phone (P2): a click can leave the workspace
  // scrolled sideways, and the thread with it. Not this tool's to check; put back.
  await page.evaluate(() => document.querySelector(".workspace")?.scrollTo(0, 0));
  // A Sheet closed a moment ago fades its backdrop over the thread: wait for the thread to be
  // where it stays and the one a finger at its top touches.
  await page.waitForFunction(
    () => {
      const r = document.querySelector(".thread-scroll")?.getBoundingClientRect();
      if (r === undefined || r.x !== 0) return false;
      return document.elementFromPoint(r.x + 6, r.y + 40)?.closest(".thread-scroll") != null;
    },
    undefined,
    { timeout: 3_000 },
  );
  const box = await scroller(page).boundingBox();
  if (box === null) throw new Error(`${where}: no thread`);
  // The thread's own padding, left of the messages: the finger is on no control.
  const x = box.x + 6;
  const top = box.y + 40;
  return { context, page, cdp, x, top, box, loads: () => loads };
}

try {
  // A conversation: scroll, a short pull, then a full one.
  {
    const where = "對話";
    const p = await phone(
      sceneOf("對話進行中"),
      async (page) => {
        await page.locator('[aria-label="展開對話列表"]').click();
        await page.locator(".conv-list >> text=整理 NAS 備份腳本").first().click();
        await page.locator(".tool-step-summary").first().click();
      },
      where,
    );
    const { page, cdp, x, top, box } = p;
    // No scene's thread is taller than a phone: plain lines at its end make it one, and the page
    // goes to the end as it follows a thread.
    const scrolls = await scroller(page).evaluate((el) => {
      const inner = el.querySelector(".thread-inner");
      for (let i = 0; i < 80; i++) {
        const line = document.createElement("p");
        line.textContent = `第 ${i + 1} 行`;
        inner?.append(line);
      }
      el.scrollTo(0, el.scrollHeight);
      return el.scrollHeight > el.clientHeight;
    });
    if (scrolls) {
      // The page followed the thread to its end. A finger going down scrolls it up, and back.
      const end = await scrollTop(page);
      await drag(cdp, x, box.y + 150, box.y + 450);
      await page.waitForTimeout(400);
      const up = await scrollTop(page);
      check(
        up < end && (await bar(page)) !== "ready 放開重新整理",
        `${where}：往上捲 ${end} → ${up}`,
      );
      await drag(cdp, x, box.y + 450, box.y + 250);
      await page.waitForTimeout(400);
      const down = await scrollTop(page);
      check(down > up, `${where}：往下捲 ${up} → ${down}`);
      // The last drag's fling may still run: back to the top until the thread stays there.
      for (let still = 0; still < 3; await page.waitForTimeout(200)) {
        await scroller(page).evaluate((el) => el.scrollTo(0, 0));
        still = (await scrollTop(page)) === 0 ? still + 1 : 0;
      }
    } else results.push(`${where}：對話串不夠長，沒測捲動`);
    check(p.loads() === 1, `${where}：捲動沒有重新載入（載入 ${p.loads()} 次）`);

    let seen = "";
    await drag(cdp, x, top, top + 40, async () => {
      seen = String(await bar(page));
    });
    await page.waitForTimeout(500);
    check(
      seen === "pulling 下拉重新整理" && p.loads() === 1,
      `${where}：拉 40 px 放開：放開前「${seen}」，沒有重新載入`,
    );
    await page.screenshot({ path: join(dir, "short.png") });

    // Short of the rest: eased back, then not moved.
    const still = await layout(page);
    await hold(cdp, x, top, top + 60);
    const half = await layout(page);
    await page.screenshot({ path: join(dir, "pull-half.png") });
    await lift(cdp);
    await page.waitForTimeout(80);
    const easing = await layout(page);
    await page.waitForTimeout(400);
    const rested = await layout(page);
    check(
      down(still, half, "topbar") === 30 &&
        down(still, half, "thread") === 30 &&
        down(still, half, "dock") === 0 &&
        half.pull === "pulling",
      `${where}：手指 60 px：標題列與對話串下移 ${down(still, half, "topbar")}／${down(still, half, "thread")} px，輸入列 ${down(still, half, "dock")} px，${half.pull}`,
    );
    check(
      down(still, easing, "topbar") > 0 &&
        down(still, easing, "topbar") < 30 &&
        down(still, rested, "topbar") === 0 &&
        rested.pull === "idle" &&
        p.loads() === 1,
      `${where}：未過門檻放開：80 ms 時 ${down(still, easing, "topbar")} px，之後 ${down(still, rested, "topbar")} px（${rested.pull}），沒有重新載入`,
    );

    // Past the rest: the cap, then let go; the page eases to the rest, where it is when the reload
    // starts (SETTLE_MS, 200 ms, after the release). Read halfway, before the reload: the easing's
    // end, from the transition itself.
    await violations(page, where);
    await hold(cdp, x, top, top + 60);
    const pulling = await layout(page);
    await moveTo(cdp, x, top + 60, top + 400);
    const capped = await layout(page);
    await moveTo(cdp, x, top + 400, top + FULL);
    const ready = await layout(page);
    readyBar = JSON.stringify([ready.bar, ready.text]);
    await page.screenshot({ path: join(dir, "pull-ready.png") });
    const reloaded = page.waitForEvent("load", { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    await lift(cdp);
    await page.waitForTimeout(90);
    const busy = await layout(page);
    const end = await page.evaluate(() => {
      const effect = document.querySelector(".topbar")?.getAnimations()[0]?.effect;
      return String(
        effect instanceof KeyframeEffect ? effect.getKeyframes().at(-1)?.transform : "",
      );
    });
    await page.screenshot({ path: join(dir, "pull-released.png") });
    check(
      down(still, capped, "topbar") === 120 && down(still, ready, "topbar") === FULL / 2,
      `${where}：手指 400 px 時下移 ${down(still, capped, "topbar")} px（上限 120），${FULL} px 時 ${down(still, ready, "topbar")} px「${ready.words}」`,
    );
    const at = down(still, busy, "topbar");
    check(
      end === "translate3d(0px, 56px, 0px)" &&
        at > 56 &&
        at < FULL / 2 &&
        busy.pull === "busy" &&
        busy.words === "重新整理中…",
      `${where}：過門檻放開：90 ms 時在 ${at} px，往 ${end} 收（停在 56 px）「${busy.words}」`,
    );
    const boxes = [pulling, ready, busy].map((l) => [l.bar, l.text]);
    const same = (k: "y" | "h") =>
      new Set(boxes.flatMap(([b, t]) => [`${b?.[k]}:${t?.[k]}`])).size === 1;
    const xs = boxes.map(([, t]) => t?.x ?? 0);
    check(
      same("y") &&
        same("h") &&
        boxes.every(([, t]) => t?.h === 20) &&
        Math.max(...xs) - Math.min(...xs) < 1,
      `${where}：三態指示盒 y／高 ${boxes.map(([b]) => `${b?.y}/${b?.h}`).join("、")}，文字 y／高／x ${boxes.map(([, t]) => `${t?.y}/${t?.h}/${t?.x.toFixed(1)}`).join("、")}（單行 20 px）`,
    );
    check((await reloaded) && p.loads() === 2, `${where}：重新載入（載入 ${p.loads()} 次）`);
    // Back in the same conversation (kept.ts): its rows, not the empty state.
    const back = await page
      .waitForFunction(
        () => document.querySelector(".thread .tool-step-summary") !== null,
        undefined,
        {
          timeout: 5_000,
        },
      )
      .then(
        () => true,
        () => false,
      );
    const kept = await page.evaluate(() => sessionStorage.getItem("tars.page"));
    check(
      back && (await page.locator(".empty-state").count()) === 0,
      `${where}：重新載入後還在同一個對話（${kept}）`,
    );
    await page.waitForTimeout(300);
    await violations(page, `${where}（重新載入後）`);
    await p.context.close();
  }

  // The top edge, the thread at its end: the reason for the edge (2026-11-25).
  {
    const where = "上緣";
    const p = await phone(
      sceneOf("對話進行中"),
      async (page) => {
        await page.locator('[aria-label="展開對話列表"]').click();
        await page.locator(".conv-list >> text=整理 NAS 備份腳本").first().click();
      },
      where,
    );
    const { page, cdp } = p;
    await scroller(page).evaluate((el) => {
      const inner = el.querySelector(".thread-inner");
      for (let i = 0; i < 80; i++) {
        const line = document.createElement("p");
        line.textContent = `第 ${i + 1} 行`;
        inner?.append(line);
      }
      el.scrollTo(0, el.scrollHeight);
    });
    await page.waitForTimeout(400);
    const end = await scrollTop(page);
    const bar0 = await grip(page, ".topbar");
    const head = await grip(page, ".conv-header-bar");
    check(
      end > 0 && bar0.width >= 44 && head.width >= 44,
      `${where}：對話捲到底（scrollTop ${end}）；頂列可抓 ${bar0.width} px 寬、標頭 ${head.width} px 寬`,
    );

    // A drag on a button of the bar takes nothing, and opens nothing.
    const status = await page.locator('[aria-label="開啟系統狀態與花費面板"]').boundingBox();
    if (status === null) throw new Error(`${where}: no status button`);
    const [sx, sy] = [status.x + status.width / 2, status.y + status.height / 2];
    let onButton = "";
    await drag(cdp, sx, sy, sy + FULL, async () => {
      onButton = String(await bar(page));
    });
    await page.waitForTimeout(600);
    // The status sheet; the conversation Sheet is a dialog on a phone even closed.
    const sheetOpen = () => page.locator('[data-slot="drawer-popup"][data-open]').count();
    let clicks = 0;
    await page.exposeFunction("seenClick", () => clicks++);
    await page.evaluate(() =>
      document.addEventListener(
        "click",
        () => (globalThis as { seenClick?: () => void }).seenClick?.(),
        true,
      ),
    );
    const opened = await sheetOpen();
    check(
      onButton === "idle " && opened === 0 && clicks === 0 && p.loads() === 1,
      `${where}：從狀態鈕往下拖 ${FULL} px：指示「${onButton}」，click ${clicks} 次，狀態面板開 ${opened} 個，載入 ${p.loads()} 次`,
    );
    // A tap on it still opens its sheet.
    await tap(cdp, sx, sy);
    await page.waitForTimeout(600);
    const sheet = await sheetOpen();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    check(
      sheet === 1 && clicks === 1 && p.loads() === 1,
      `${where}：點狀態鈕：click ${clicks} 次，狀態面板開 ${sheet} 個，沒有重新載入`,
    );

    // From the header, short of the rest: the page follows and eases back, the thread stays.
    const still = await layout(page);
    await hold(cdp, head.x, head.y, head.y + 60);
    const half = await layout(page);
    await lift(cdp);
    await page.waitForTimeout(500);
    const rested = await layout(page);
    check(
      down(still, half, "topbar") === 30 &&
        down(still, half, "dock") === 0 &&
        half.pull === "pulling" &&
        down(still, rested, "topbar") === 0 &&
        rested.pull === "idle" &&
        (await scrollTop(page)) === end &&
        p.loads() === 1,
      `${where}：從標頭拉 60 px：下移 ${down(still, half, "topbar")} px（${half.pull}），放開回 ${down(still, rested, "topbar")} px，對話串仍在 ${await scrollTop(page)}`,
    );

    // From the bar, past the rest: the same indicator, and the reload.
    await hold(cdp, bar0.x, bar0.y, bar0.y + FULL);
    const ready = await layout(page);
    const top = await scrollTop(page);
    await page.screenshot({ path: join(dir, "edge-ready.png") });
    const reloaded = page.waitForEvent("load", { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    await lift(cdp);
    const same = JSON.stringify([ready.bar, ready.text]) === readyBar;
    check(
      ready.pull === "ready" &&
        ready.words === "放開重新整理" &&
        down(still, ready, "topbar") === FULL / 2 &&
        same &&
        top === end,
      `${where}：對話在底，從頂列拉 ${FULL} px：下移 ${down(still, ready, "topbar")} px「${ready.words}」，指示盒與對話頂端拉的${same ? "相同" : `不同：${JSON.stringify([ready.bar, ready.text])}／${readyBar}`}，對話串仍在 ${top}`,
    );
    check((await reloaded) && p.loads() === 2, `${where}：重新載入（載入 ${p.loads()} 次）`);
    await page.waitForTimeout(300);
    await violations(page, where);
    await p.context.close();
  }

  // The knowledge base's page.
  {
    const where = "知識庫";
    const p = await phone(
      sceneOf("知識庫的一頁"),
      (page) => page.locator('button:has-text("個人知識庫")').click(),
      where,
    );
    await violations(p.page, where);
    const reloaded = p.page.waitForEvent("load", { timeout: 5000 });
    await drag(p.cdp, p.x, p.top, p.top + FULL);
    const ok = await reloaded.then(
      () => true,
      () => false,
    );
    check(ok, `${where}：拉 ${FULL} px 放開，重新載入`);
    // Back on the knowledge base and its page once wiki.status answers (kept.ts); the page asked
    // for again (the scene answers every page with the same one).
    const page = await p.page
      .waitForFunction(
        // Before the page's answer the title is its path's name: wait for the page itself.
        () => {
          const t = document.querySelector(".wiki-workspace .wiki-page-title")?.textContent;
          return t === "NAS 備份腳本" ? t : "";
        },
        undefined,
        { timeout: 5_000 },
      )
      .then(
        async (h) => String(await h.jsonValue()),
        () => "",
      );
    const kept = await p.page.evaluate(() => sessionStorage.getItem("tars.page"));
    check(
      page === "NAS 備份腳本" && kept?.includes('"selected":"projects/nas-backup"') === true,
      `${where}：重新載入後回到知識庫的同一頁「${page}」（${kept}）`,
    );
    await violations(p.page, `${where}（重新載入後）`);
    // Scrolled down, from the top edge: taken as in a conversation.
    await p.page.waitForTimeout(300);
    await scroller(p.page).evaluate((el) => {
      for (let i = 0; i < 80; i++) {
        const line = document.createElement("p");
        line.textContent = `第 ${i + 1} 行`;
        el.firstElementChild?.append(line);
      }
      el.scrollTo(0, el.scrollHeight);
    });
    await p.page.waitForTimeout(400);
    const deep = await scrollTop(p.page);
    const g = await grip(p.page, ".topbar");
    const again = p.page.waitForEvent("load", { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    let said = "";
    await drag(p.cdp, g.x, g.y, g.y + FULL, async () => {
      said = String(await bar(p.page));
    });
    check(
      deep > 0 && said === "ready 放開重新整理" && (await again) && p.loads() === 3,
      `${where}：捲到 ${deep} 後從頂列拉 ${FULL} px：「${said}」，重新載入（載入 ${p.loads()} 次）`,
    );
    await p.context.close();
  }

  // Each overlay open: a pull does not reload. A phone, and a desktop's width with touch, as an
  // iPad. The finger lands where the thread's top is; what it lands on is said, as the backdrop
  // usually takes it before the thread could.
  const touchWidths = {
    phone: WIDTHS.phone,
    desktop: { ...WIDTHS.desktop, hasTouch: true },
  };
  for (const [width, options] of Object.entries(touchWidths) as [keyof typeof WIDTHS, object][]) {
    for (const o of OVERLAYS) {
      const slot = o.slot[width];
      if (slot === undefined) continue;
      const where = `${width === "phone" ? "手機" : "桌面觸控"} ${o.name}`;
      const context = await browser.newContext({ ...options, locale: "zh-TW" });
      await context.addInitScript(COLLECT);
      const page = await context.newPage();
      page.on("pageerror", (e) => failures.push(`${where}: page error: ${e.message}`));
      let loads = 0;
      page.on("load", () => loads++);
      const cdp = await context.newCDPSession(page);
      try {
        await page.clock.setFixedTime(NOW);
        await page.goto(`${url}/?scene=${o.scene}`, { waitUntil: "load" });
        await page.waitForTimeout(400);
        for (const c of o.before[width]) {
          await page.locator(c).first().click({ timeout: 5_000 });
          await page.waitForTimeout(300);
        }
        if (o.from !== undefined && width === "phone") {
          await page.locator(o.from).first().click();
          await page.waitForTimeout(400);
        }
        await page
          .locator(`${o.button[width] as string} >> visible=true`)
          .first()
          .click();
        await page.waitForTimeout(500);
        await page.evaluate(() => document.querySelector(".workspace")?.scrollTo(0, 0));
        const box = await scroller(page).boundingBox();
        if (box === null || box.x < 0) throw new Error(`the thread is at ${box?.x}`);
        const [x, y] = [box.x + 6, box.y + 40];
        const seen = await page.evaluate(
          ([slot, x, y]) => {
            const at = document.elementFromPoint(x as number, y as number);
            return {
              open: document.querySelectorAll(`[data-slot="${slot}"][data-open]`).length,
              marked: document.querySelector(".thread-scroll")?.closest("[data-base-ui-inert]")?.id,
              under:
                at === null
                  ? "nothing"
                  : (at.getAttribute("data-slot") ??
                    (at.closest(".thread-scroll") ? "thread" : at.tagName)),
            };
          },
          [slot, x, y] as const,
        );
        await drag(cdp, x, y, y + FULL);
        await page.waitForTimeout(1_500);
        check(
          seen.open === 1 && seen.marked === "root" && loads === 1,
          `${where}：開著（${slot}，#root 標記 ${seen.marked ?? "無"}，手指落在 ${seen.under}）拉 ${FULL} px，載入 ${loads} 次`,
        );
        // From the top edge, where the bar is: no more taken than from the thread.
        const edge = await page.evaluate(() => {
          const r = document.querySelector(".topbar")?.getBoundingClientRect();
          return r === undefined ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        // A popover or a menu closes on a press outside it, the drag on the thread's: open again.
        if ((await page.locator(`[data-slot="${slot}"][data-open]`).count()) === 0) {
          await page
            .locator(`${o.button[width] as string} >> visible=true`)
            .first()
            .click();
          await page.waitForTimeout(500);
        }
        const reopened = await page.locator(`[data-slot="${slot}"][data-open]`).count();
        if (edge !== null) {
          await drag(cdp, edge.x, edge.y, edge.y + FULL);
          await page.waitForTimeout(1_500);
          check(
            reopened === 1 && loads === 1,
            `${where}：開著（${reopened}），從上緣拉 ${FULL} px，載入 ${loads} 次`,
          );
        }
        await violations(page, where);
      } catch (e) {
        failures.push(`${where}: ${(e as Error).message.split("\n")[0]}`);
      }
      await context.close();
    }
  }

  // A card announced while a pull is held: the alert and the bar are two regions, both read.
  {
    const where = "公告";
    const p = await phone(
      sceneOf("對話進行中"),
      async (page) => {
        await page.locator('[aria-label="展開對話列表"]').click();
        await page.locator(".conv-list >> text=整理 NAS 備份腳本").first().click();
      },
      where,
    );
    const { page, cdp, x, top } = p;
    let seen = { alert: "", bar: "", tree: [] as string[] };
    await drag(cdp, x, top, top + 40, async () => {
      await page.evaluate(
        (m) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(m),
        {
          kind: "approval.request",
          p: {
            approval: {
              approvalId: "approval-00000009",
              conv: "c-ledger",
              hash: "a".repeat(64),
              action: "run_script",
              script: "s9",
              version: "v1",
              summary: "推播",
              effects: "external-write",
              domains: [],
              secret: null,
              argv: [],
              expiresAt: NOW + 600_000,
            },
          },
        },
      );
      await page.waitForTimeout(800);
      const dom = await page.evaluate(() => ({
        alert: document.querySelector('[role="alert"][aria-live="assertive"]')?.textContent ?? "",
        bar: document.querySelector('.pull-indicator[role="status"]')?.textContent ?? "",
      }));
      const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
        nodes: { ignored: boolean; role?: { value: string }; name?: { value: unknown } }[];
      };
      const tree = nodes
        .filter((n) => !n.ignored && ["alert", "status"].includes(String(n.role?.value)))
        .map((n) => `${n.role?.value}`);
      const texts = nodes
        .filter((n) => !n.ignored)
        .map((n) => (typeof n.name?.value === "string" ? n.name.value : ""));
      seen = {
        ...dom,
        tree: [
          ...tree,
          ...(texts.some((t) => t.includes("需要核准")) ? ["需要核准"] : []),
          ...(texts.some((t) => t === "下拉重新整理") ? ["下拉重新整理"] : []),
        ],
      };
    });
    await page.waitForTimeout(400);
    check(
      seen.alert.includes("需要核准") &&
        seen.bar === "下拉重新整理" &&
        seen.tree.includes("alert") &&
        seen.tree.includes("status") &&
        seen.tree.includes("需要核准") &&
        seen.tree.includes("下拉重新整理") &&
        p.loads() === 1,
      `${where}：下拉中來了核准卡：alert「${seen.alert}」、status「${seen.bar}」，無障礙樹有 ${seen.tree.join("、")}`,
    );
    await violations(page, where);
    await p.context.close();
  }

  // A desktop and its mouse.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(COLLECT);
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push(`桌面: page error: ${e.message}`));
    let loads = 0;
    page.on("load", () => loads++);
    await page.clock.setFixedTime(NOW);
    await page.goto(`${url}/?scene=${sceneOf("對話進行中")}`, { waitUntil: "load" });
    await page.locator(".conv-list >> text=整理 NAS 備份腳本").first().click();
    await scroller(page).evaluate((el) => el.scrollTo(0, 0));
    const box = await scroller(page).boundingBox();
    if (box === null) throw new Error("桌面: no thread");
    await page.mouse.move(box.x + 6, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 6, box.y + 200, { steps: 10 });
    await page.mouse.up();
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(500);
    check(
      loads === 1 && (await bar(page)) === null,
      `桌面：滑鼠拖曳與滾輪，沒有指示列、沒有重新載入（載入 ${loads} 次）`,
    );
    await violations(page, "桌面");
    await context.close();
  }
} catch (e) {
  failures.push((e as Error).message.split("\n")[0] ?? "");
}

await browser.close();
server.close();
console.log(results.map((r) => `ok   ${r}`).join("\n"));
if (failures.length > 0) console.log(failures.map((f) => `FAIL ${f}`).join("\n"));
process.exitCode = failures.length === 0 ? 0 : 1;
