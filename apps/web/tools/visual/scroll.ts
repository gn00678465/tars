// The thread's scrolling in Chromium (M4-P3a), on scenes.ts's measuring scenes, at desktop width
// with a mouse and at phone width with touch (CDP gestures: Playwright's touchscreen only taps).
// While a reply streams in, a delta every 50–100 ms (fake.ts):
//   (a) at the end it is followed: the gap to the end, every frame for 3 s;
//   (b) scrolled up 200 px mid-stream it is left there for 2 s, 捲到最新訊息 shows inside the
//       thread and clear of the composer, and takes it back to following; and so when scrolled up
//       with no wheel, touch or key (scrollTop -= 300, as the scrollbar or find in page do);
//   a card that comes while scrolled up takes the focus on its deny, in view and not under the
//   button;
//   (c) older groups loaded do not move the row being read (its top before and after), the page
//       cut inside a group as the local end cuts by count, with the browser's scroll anchoring and
//       without it (overflow-anchor: none, as Safari has none); and so in a compacted
//       conversation, whose first row is the line saying the model no longer sees what follows,
//       cut at a group's start and inside one.
// Then how long 200 groups take to draw, against main (its tree with these scenes).
// It fails on any CSP violation or page error (zod's eval probe left out, as csp.ts).
//   node tools/visual/scroll.ts [--base <ref>]
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/scroll/.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, chromium, type Page } from "playwright-core";
import { WIDTHS } from "./overlays.ts";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { approval, SCENES, STREAM_TURN } from "./scenes.ts";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "main" },
    width: { type: "string" },
    "no-timing": { type: "boolean", default: false },
  },
});
const web = resolve(import.meta.dirname, "../..");
const repo = resolve(web, "../..");
const dir = join(web, ".visual", "scroll");
const STREAM = SCENES.findIndex((s) => s.stream !== undefined) + 1;
const BIG = SCENES.findIndex((s) => s.name.startsWith("長對話：200")) + 1;
if (STREAM === 0 || BIG === 0) throw new Error("no measuring scenes in scenes.ts");
/** At the end, as App.tsx counts it (BOTTOM_PX). */
const END_PX = 24;

await buildTree(web, join(dir, "head"), true);
const head = await serve(join(dir, "head"));
const { isProbe } = zodProbe(join(dir, "head"), head.url);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});

const failures: string[] = [];
const results: string[] = [];
const check = (ok: boolean, what: string) => {
  (ok ? results : failures).push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};
const round = (n: number) => Math.round(n * 10) / 10;

async function violations(page: Page, where: string) {
  const seen = (await page.evaluate(
    () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
  )) as Violation[];
  for (const v of seen.filter((v) => !isProbe(v)))
    failures.push(`${where}: CSP ${JSON.stringify(v)}`);
}

async function opened(
  browser: Browser,
  width: keyof typeof WIDTHS,
  url: string,
  scene: number,
  title = scene === STREAM ? "串流量測" : "兩百組",
) {
  const context = await browser.newContext({ ...WIDTHS[width], locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => failures.push(`${width}: page error: ${e.message}`));
  await page.goto(`${url}/?scene=${scene}`, { waitUntil: "load" });
  if (width === "phone") await page.locator('[aria-label="展開對話列表"]').click();
  await page.locator(`.conv-list >> text=${title}`).first().click();
  return { context, page };
}

/** Every frame for `ms`: the gap to the end, and how often the thread went up by itself. */
const follow = (page: Page, ms: number) =>
  page.evaluate(async (ms) => {
    const el = document.querySelector(".thread-scroll") as HTMLElement;
    const gaps: number[] = [];
    let up = 0;
    let last = el.scrollTop;
    const from = el.scrollHeight;
    const until = performance.now() + ms;
    await new Promise<void>((done) => {
      const frame = () => {
        gaps.push(el.scrollHeight - el.scrollTop - el.clientHeight);
        if (el.scrollTop < last - 0.5) up += 1;
        last = el.scrollTop;
        if (performance.now() < until) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
    // The longest run of frames away from the end: one frame is the scroller's (it scrolls on
    // the frame after a row grows, from its ResizeObserver).
    let run = 0;
    let longest = 0;
    for (const g of gaps) {
      run = g > 24 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      frames: gaps.length,
      max: sorted.at(-1) ?? 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      away: gaps.filter((g) => g > 24).length,
      longest,
      up,
      grew: el.scrollHeight - from,
      // At the end in one of the last three frames: the last may be the scroller's frame behind.
      end: Math.min(...gaps.slice(-3)),
    };
  }, ms);

const top = (page: Page) => page.locator(".thread-scroll").evaluate((el) => el.scrollTop);
const gap = (page: Page) =>
  page.locator(".thread-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Up by `px` as the reader does it: the wheel on a desktop, a finger on a phone. */
async function up(page: Page, width: keyof typeof WIDTHS, px: number) {
  const box = await page.locator(".thread-scroll").boundingBox();
  if (box === null) throw new Error("no thread");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (width === "desktop") {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -px);
  } else {
    // A finger down and moved in steps (Playwright's touchscreen only taps), slow enough that
    // no fling follows; a long way in drags of 200 px, each within the thread.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", at: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y: at, id: 1 }],
      });
    for (let left = px; left > 0; left -= 200) {
      const by = Math.min(200, left);
      const from = y - by / 2;
      await touch("touchStart", from);
      for (let d = 10; d <= by + 20; d += 10) {
        await touch("touchMove", from + d);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(100);
      await touch("touchEnd", from + by + 20);
    }
  }
  await page.waitForTimeout(300);
}

const rect = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r === undefined ? null : { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }, selector);
type Box = NonNullable<Awaited<ReturnType<typeof rect>>>;
const inside = (a: Box, b: Box) =>
  a.top >= b.top - 0.5 &&
  a.bottom <= b.bottom + 0.5 &&
  a.left >= b.left - 0.5 &&
  a.right <= b.right + 0.5;
const apart = (a: Box, b: Box) =>
  a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;

const BUTTON = ".thread-to-end";

/** Waits, up to 3 s, for 捲到最新訊息 to be `active`; what it was when it stopped waiting. */
async function buttonIs(page: Page, active: boolean) {
  const want = String(active);
  try {
    await page.waitForFunction(
      ([s, v]) => document.querySelector(s as string)?.getAttribute("data-active") === v,
      [BUTTON, want],
      { timeout: 3_000, polling: 50 },
    );
  } catch {
    // Said by the check below.
  }
  return page.evaluate((s) => {
    const b = document.querySelector(s) as HTMLElement;
    return { active: b.getAttribute("data-active"), opacity: getComputedStyle(b).opacity };
  }, BUTTON);
}

/**
 * Presses 捲到最新訊息 once it is active. If it never is, or something else is where it is drawn,
 * says that rather than waiting on Playwright's click.
 */
async function press(page: Page, width: keyof typeof WIDTHS) {
  const shown = await buttonIs(page, true);
  const box = await rect(page, BUTTON);
  const hit = await page.evaluate((s) => {
    const b = document.querySelector(s) as HTMLElement;
    const r = b.getBoundingClientRect();
    const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return {
      onTop: at !== null && b.contains(at),
      at: at === null ? "nothing" : `${at.tagName.toLowerCase()}.${[...at.classList].join(".")}`,
      inert: b.inert,
    };
  }, BUTTON);
  if (shown.active !== "true" || box === null || !hit.onTop || hit.inert)
    throw new Error(
      `捲到最新訊息 not pressable: data-active=${shown.active}, inert=${hit.inert}, at its middle ${hit.at}`,
    );
  if (width === "desktop") await page.locator(BUTTON).click();
  else await page.locator(BUTTON).tap();
}

async function streaming(width: keyof typeof WIDTHS) {
  const { context, page } = await opened(browser, width, head.url, STREAM);
  const where = width === "desktop" ? "桌面" : "手機";
  await page.waitForSelector(".thread .streaming");
  await page.waitForTimeout(500);

  // (a)
  const a = await follow(page, 3_000);
  check(
    a.grew > 100 && a.end <= END_PX && a.longest <= 2 && a.up === 0,
    `${where} (a) 在底部跟隨：3 秒 ${a.frames} 格，內容長高 ${a.grew} px；離底最大 ${round(a.max)} px、p95 ${round(a.p95)} px；超過 ${END_PX} px 的格 ${a.away} 格，最長連續 ${a.longest} 格；自己往上跳 ${a.up} 次；結束時離底 ${round(a.end)} px`,
  );
  await page.screenshot({ path: join(dir, `${width}-follow.png`) });
  // A screenshot at phone width redraws the page: let the thread settle first.
  await page.waitForTimeout(500);

  // (b)
  // At the end of a fast stream a finger's first pixels are within the end and get followed, so
  // a drag can be taken back whole; main does the same (2 in 8 there, 3 in 8 here). Again then.
  let drags = 0;
  let off = 0;
  while (drags < 3 && off < 50) {
    await up(page, width, 200);
    drags += 1;
    off = await gap(page);
  }
  const left = await top(page);
  await page.waitForTimeout(2_000);
  const after = await top(page);
  const button = BUTTON;
  const shown = await buttonIs(page, true);
  const [buttonBox, thread, composer] = await Promise.all([
    rect(page, button),
    rect(page, ".thread-scroll"),
    rect(page, ".composer-dock"),
  ]);
  const placed =
    buttonBox !== null &&
    thread !== null &&
    composer !== null &&
    inside(buttonBox, thread) &&
    apart(buttonBox, composer);
  check(
    Math.abs(after - left) <= 1 && off >= 50 && shown.active === "true" && placed,
    `${where} (b) 串流中往上拖 200 px（${drags} 次），放開時離底 ${round(off)} px：2 秒後 scrollTop ${round(left)} → ${round(after)}；捲到最新訊息 data-active=${shown.active}、opacity ${shown.opacity}，在對話串內${placed ? "、不壓輸入列" : "：位置不對"}`,
  );
  await page.screenshot({ path: join(dir, `${width}-up.png`) });
  await page.waitForTimeout(500);
  await press(page, width);
  await page.waitForTimeout(800);
  const back = await gap(page);
  const again = await follow(page, 1_500);
  const hidden = (await buttonIs(page, false)).active;
  check(
    back <= END_PX && again.longest <= 2 && again.end <= END_PX && hidden === "false",
    `${where} (b) 按捲到最新訊息：離底 ${round(back)} px，之後 1.5 秒又跟隨（最大 ${round(again.max)} px、最長連續 ${again.longest} 格，結束時離底 ${round(again.end)} px），鈕 data-active=${hidden}`,
  );

  // (b) with no wheel, touch or key: the scrollbar, find in page, a tap on the status bar.
  const bar = await page.locator(".thread-scroll").evaluate(async (el) => {
    el.scrollTop -= 300;
    const gaps: number[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 150));
      gaps.push(Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    }
    return gaps;
  });
  const barShown = await buttonIs(page, true);
  check(
    (bar[0] ?? 0) >= 250 &&
      bar.every((g, i) => i === 0 || g >= (bar[i - 1] ?? 0)) &&
      barShown.active === "true",
    `${where} (b) 串流中 scrollTop -= 300（沒有滾輪、觸控、按鍵）：之後每 150 ms 離底 ${bar.join(", ")} px；捲到最新訊息 data-active=${barShown.active}`,
  );
  await press(page, width);
  await page.waitForTimeout(800);
  check(
    (await gap(page)) <= END_PX,
    `${where} (b) 之後按捲到最新訊息：離底 ${round(await gap(page))} px`,
  );

  // A card while scrolled up.
  await up(page, width, 300);
  const kept = await top(page);
  await page.evaluate(
    (p) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(p),
    {
      kind: "approval.request",
      conv: "c-stream",
      p: { approval: approval("c-stream", "call-stream") },
    },
  );
  await page.waitForTimeout(800);
  const card = await page.evaluate(() => {
    const deny = document.querySelector(".thread-scroll .approval-card .sg-btn-danger");
    const r = deny?.getBoundingClientRect();
    const at =
      r === undefined
        ? null
        : document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return {
      focused: deny !== null && document.activeElement === deny,
      deny: r === undefined ? null : { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      onTop: deny !== null && at !== null && deny.contains(at),
      alert: document.querySelector('[role="alert"][aria-live="assertive"]')?.textContent ?? "",
    };
  });
  const view = await rect(page, ".thread-scroll");
  const shownNow = await rect(page, button);
  const clear =
    card.deny !== null &&
    view !== null &&
    inside(card.deny, view) &&
    card.onTop &&
    (shownNow === null ||
      apart(card.deny, shownNow) ||
      (await page.locator(button).getAttribute("data-active")) === "false");
  check(
    card.focused && clear && card.alert.includes("需要核准"),
    `${where} 往上捲時來了核准卡：公告「${card.alert.slice(0, 12)}…」，焦點在拒絕${card.focused ? "" : "（沒有）"}，拒絕鈕${clear ? "在畫面內、沒被蓋住" : "不在畫面內或被蓋住"}；scrollTop ${round(kept)} → ${round(await top(page))}`,
  );
  await page.screenshot({ path: join(dir, `${width}-card.png`) });
  await page.waitForTimeout(500);

  // (c), with the browser's anchoring.
  await older(page, width, "瀏覽器的 scroll anchoring 開著");
  await violations(page, where);
  await context.close();

  // (c), without it: only the scroller keeps the place.
  const second = await opened(browser, width, head.url, STREAM);
  await second.page.waitForSelector(".thread .streaming");
  await second.page.locator(".thread-scroll").evaluate((el) => {
    el.style.overflowAnchor = "none";
  });
  await older(second.page, width, "overflow-anchor: none");
  await violations(second.page, where);
  await second.context.close();
}

/**
 * M4-P3b: while the reply streams, a tool step comes and is opened (by its key: Enter on the
 * focused line), then its long output in full. Trace opens by height over 200 ms; the thread
 * stays at the end through it, and a drag up after it is still not taken back.
 */
async function toolOpened(width: keyof typeof WIDTHS) {
  const { context, page } = await opened(browser, width, head.url, STREAM);
  const where = width === "desktop" ? "桌面" : "手機";
  await page.waitForSelector(".thread .streaming");
  await page.waitForTimeout(500);
  const push = (p: unknown) =>
    page.evaluate((p) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(p), p);
  const item = (i: object) => ({ kind: "item", conv: "c-stream", p: { item: i } });
  await push(
    item({
      seq: 503,
      turn: STREAM_TURN,
      kind: "tool_call",
      callId: "call-open",
      name: "tars",
      input: JSON.stringify({ argv: ["script", "run", "nas-log"] }),
      truncated: false,
    }),
  );
  await push(
    item({
      seq: 504,
      turn: STREAM_TURN,
      kind: "tool_result",
      callId: "call-open",
      status: "done",
      exit: 0,
      text: Array.from({ length: 60 }, (_, i) => `rsync IMG_${1000 + i}.heic`).join("\n"),
      truncated: false,
      durationMs: 900,
    }),
  );
  const line = page.locator('.tool-step:has-text("nas-log") .tool-step-summary');
  await line.waitFor();
  await page.waitForTimeout(300);
  const before = await gap(page);
  // Two windows: the line opening (Trace's 200 ms height), then the rest of the output at once.
  let watching = follow(page, 1_200);
  await line.focus();
  await page.keyboard.press("Enter");
  const opening = await watching;
  watching = follow(page, 1_200);
  await page.locator('.tool-step:has-text("nas-log") button:has-text("展開其餘")').click();
  const rest = await watching;
  const expanded = await line.getAttribute("aria-expanded");
  const lines = await page
    .locator('.tool-step:has-text("nas-log") [data-slot=code-block-code]')
    .nth(1)
    .evaluate((e) => e.textContent?.split("\n").length ?? 0);
  const told = (w: Awaited<ReturnType<typeof follow>>) =>
    `${w.frames} 格長高 ${w.grew} px，離底最大 ${round(w.max)} px，超過 ${END_PX} px 最長連續 ${w.longest} 格，往上跳 ${w.up} 次，結束時離底 ${round(w.end)} px`;
  const held = (w: Awaited<ReturnType<typeof follow>>) =>
    w.end <= END_PX && w.longest <= 3 && w.up === 0;
  check(
    expanded === "true" && before <= END_PX && held(opening),
    `${where} 串流中來了工具列，按 Enter 展開（aria-expanded=${expanded}）：${told(opening)}`,
  );
  check(lines === 60 && held(rest), `${where} 再按展開其餘（共 ${lines} 行）：${told(rest)}`);
  await page.screenshot({ path: join(dir, `${width}-tool-open.png`) });
  await page.waitForTimeout(500);
  let drags = 0;
  let off = 0;
  while (drags < 3 && off < 50) {
    await up(page, width, 200);
    drags += 1;
    off = await gap(page);
  }
  const left = await top(page);
  await page.waitForTimeout(2_000);
  const after = await top(page);
  check(
    off >= 50 && Math.abs(after - left) <= 1,
    `${where} 工具列展開後往上拖 200 px（${drags} 次），離底 ${round(off)} px：2 秒後 scrollTop ${round(left)} → ${round(after)}`,
  );
  await violations(page, where);
  await context.close();
}

/** Up to the top, loads the older groups, and how far the row being read moved. */
async function older(
  page: Page,
  width: keyof typeof WIDTHS,
  how: string,
  first = "g82",
  label = "切在群組中間",
) {
  const where = width === "desktop" ? "桌面" : "手機";
  // By script, as find in page would: it lets go of following (App.tsx's onScroll).
  await page.locator(".thread-scroll").evaluate((el) => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(300);
  const read = await page.evaluate(() => {
    const view = (document.querySelector(".thread-scroll") as HTMLElement).getBoundingClientRect();
    const row = [...document.querySelectorAll<HTMLElement>(".thread [data-message-id]")].find(
      (r) => r.getBoundingClientRect().bottom > view.top + 1,
    );
    return {
      id: row?.dataset.messageId ?? "",
      top: row?.getBoundingClientRect().top ?? 0,
      rows: document.querySelectorAll(".thread [data-message-id]").length,
    };
  });
  await page.locator('button:has-text("載入更早的訊息")').click();
  await page.waitForTimeout(800);
  const now = await page.evaluate(
    (id) => ({
      top: document.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect().top ?? NaN,
      rows: document.querySelectorAll(".thread [data-message-id]").length,
    }),
    read.id,
  );
  const moved = now.top - read.top;
  check(
    Math.abs(moved) < 2 && now.rows >= read.rows + 20 && read.id === first,
    `${where} (c) 載入更早的訊息，${label}（${how}）：列 ${read.id} 的 top ${round(read.top)} → ${round(now.top)}（移動 ${round(moved)} px），${read.rows} → ${now.rows} 列`,
  );
}

/** (c) in a compacted conversation: its first row is the line, not a group. */
async function compacted(width: keyof typeof WIDTHS) {
  for (const cut of ["邊界", "中間"] as const) {
    const scene =
      SCENES.findIndex((s) => s.name.startsWith(`壓縮過：載入更早，切在群組${cut}`)) + 1;
    if (scene === 0) throw new Error(`no compacted scene (${cut})`);
    for (const anchoring of [true, false]) {
      const { context, page } = await opened(browser, width, head.url, scene, `壓縮量測${cut}`);
      await page.waitForSelector(".thread-scroll .compacted-notice-line");
      if (!anchoring)
        await page.locator(".thread-scroll").evaluate((el) => {
          el.style.overflowAnchor = "none";
        });
      await older(
        page,
        width,
        anchoring ? "瀏覽器的 scroll anchoring 開著" : "overflow-anchor: none",
        cut === "邊界" ? "g81" : "g82",
        `壓縮過的對話、第一列是提示行、切在群組${cut}`,
      );
      await violations(page, width);
      await context.close();
    }
  }
}

const widths = (["desktop", "phone"] as const).filter(
  (w) => args.width === undefined || w === args.width,
);
for (const width of widths) {
  try {
    await streaming(width);
    await toolOpened(width);
    await compacted(width);
  } catch (e) {
    check(false, `${width}: ${(e as Error).message.split("\n")[0]}`);
  }
}

// 200 groups: from the press on the conversation to its rows drawn, and to the page taking input
// again (a task after that frame), the median of 5, against the base with these scenes.
if (!args["no-timing"]) {
  rmSync(join(dir, "base-src"), { recursive: true, force: true });
  mkdirSync(join(dir, "base-src"), { recursive: true });
  execFileSync("sh", [
    "-c",
    `git -C "${repo}" archive "${args.base}" apps/web | tar -x -C "${join(dir, "base-src")}"`,
  ]);
  for (const f of ["fake.ts", "scenes.ts"])
    copyFileSync(join(web, "tools/visual", f), join(dir, "base-src/apps/web/tools/visual", f));
  await buildTree(join(dir, "base-src/apps/web"), join(dir, "base"), true);
  const base = await serve(join(dir, "base"));
  const timing: Record<string, Record<string, { drawn: number; ready: number }>> = {};
  for (const width of widths)
    for (const [tree, url] of [
      ["main", base.url],
      ["P3a", head.url],
    ] as const) {
      const runs: { drawn: number; ready: number }[] = [];
      for (let i = 0; i < 5; i++) {
        const context = await browser.newContext({ ...WIDTHS[width], locale: "zh-TW" });
        const page = await context.newPage();
        await page.goto(`${url}/?scene=${BIG}`, { waitUntil: "load" });
        if (width === "phone") await page.locator('[aria-label="展開對話列表"]').click();
        await page.waitForTimeout(300);
        // A phone is slower than this machine: its CPU, a quarter.
        const cdp = await context.newCDPSession(page);
        if (width === "phone") await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.evaluate(() => {
          const w = globalThis as { drawnAt?: Promise<{ drawn: number; ready: number }> };
          w.drawnAt = new Promise((done) => {
            const t0 = performance.now();
            const seen = new MutationObserver(() => {
              if (document.querySelectorAll(".msg-group").length < 200) return;
              seen.disconnect();
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const drawn = performance.now() - t0;
                  setTimeout(() => done({ drawn, ready: performance.now() - t0 }), 0);
                }),
              );
            });
            seen.observe(document.body, { childList: true, subtree: true });
          });
        });
        await page.locator(".conv-list >> text=兩百組").first().click();
        runs.push(
          (await page.evaluate(() =>
            Promise.race([
              (globalThis as { drawnAt?: Promise<{ drawn: number; ready: number }> }).drawnAt,
              new Promise<never>((_, no) =>
                setTimeout(() => no(new Error("200 groups not drawn in 30 s")), 30_000),
              ),
            ]),
          )) as { drawn: number; ready: number },
        );
        await context.close();
      }
      const median = (k: "drawn" | "ready") => runs.map((r) => r[k]).sort((a, b) => a - b)[2] ?? 0;
      (timing[width] ??= {})[tree] = { drawn: median("drawn"), ready: median("ready") };
    }
  for (const [width, t] of Object.entries(timing)) {
    const [m, h] = [t.main, t.P3a];
    if (m === undefined || h === undefined) continue;
    check(
      true,
      `${width === "desktop" ? "桌面" : "手機（CPU 1/4）"} 200 組：畫出 main ${round(m.drawn)} ms → P3a ${round(h.drawn)} ms；可輸入 main ${round(m.ready)} ms → P3a ${round(h.ready)} ms（中位數，5 次）`,
    );
  }
  base.server.close();
}

await browser.close();
head.server.close();
console.log(`${results.length} ok, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
