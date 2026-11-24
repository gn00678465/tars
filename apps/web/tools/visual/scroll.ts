// The thread's scrolling in Chromium (M4-P3a), on scenes.ts's measuring scenes, at desktop width
// with a mouse and at phone width with touch (CDP gestures: Playwright's touchscreen only taps).
// While a reply streams in, a delta every 50–100 ms (fake.ts):
//   (a) at the end it is followed: the gap to the end, every frame for 3 s, judged by the frames'
//       own time (no run over 24 px past 150 ms, at the end when it stops, never up by itself);
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
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Away from the end, as a reader sees it: a run of frames over END_PX that lasts longer than
 * this, by the frames' own clock. The scroller scrolls on the frame after a row grows (its
 * ResizeObserver), so one frame, 17 ms at 60 fps, is away by design; a busy machine stretches
 * that frame to 30–70 ms. A run past 150 ms is the end slipping, which a reader sees.
 * Until M4-P3b the bar was a count of frames (2, then 3) and a single read in px after a press:
 * both hit the frame behind now and then, by luck (README, scroll.ts).
 */
const AWAY_MS = 150;
/** After 捲到最新訊息, the end within this (a smooth scroll), then followed. */
const BACK_MS = 1_000;

/** A frame: when (performance.now), the gap to the end, scrollHeight, scrollTop. */
type Frame = { t: number; gap: number; h: number; top: number };

/**
 * Every frame for `ms`, read on requestAnimationFrame so a busy machine only spaces the samples,
 * never skips one; and when `mark` (a selector) is first clicked, by the same clock.
 */
const frames = (page: Page, ms: number, mark?: string) =>
  page.evaluate(
    async ([ms, mark]) => {
      const el = document.querySelector(".thread-scroll") as HTMLElement;
      const out: { t: number; gap: number; h: number; top: number }[] = [];
      let marked: number | null = null;
      const on = () => {
        marked ??= performance.now();
      };
      const target = mark === undefined ? null : document.querySelector(mark);
      target?.addEventListener("click", on, { capture: true });
      const until = performance.now() + ms;
      await new Promise<void>((done) => {
        const frame = (t: number) => {
          out.push({
            t,
            gap: el.scrollHeight - el.scrollTop - el.clientHeight,
            h: el.scrollHeight,
            top: el.scrollTop,
          });
          if (performance.now() < until) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      });
      target?.removeEventListener("click", on, { capture: true });
      return { fs: out, marked };
    },
    [ms, mark] as const,
  );

/** A run of frames over END_PX: from its first frame to the first frame back (or the last). */
type Run = {
  from: number;
  to: number;
  ms: number;
  n: number;
  max: number;
  grewAt: boolean;
  dtMax: number;
};

/** What a window of frames says, by time. */
function judge(fs: Frame[]) {
  const runs: Run[] = [];
  let open: Run | null = null;
  let up = 0;
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i] as Frame;
    const prev = fs[i - 1];
    if (prev !== undefined && f.top < prev.top - 0.5) up += 1;
    const dt = prev === undefined ? 0 : f.t - prev.t;
    if (f.gap > END_PX) {
      if (open === null)
        open = {
          from: i,
          to: i,
          ms: 0,
          n: 0,
          max: 0,
          grewAt: prev !== undefined && f.h > prev.h,
          dtMax: 0,
        };
      open.to = i;
      open.n += 1;
      open.max = Math.max(open.max, f.gap);
      open.dtMax = Math.max(open.dtMax, dt);
    } else if (open !== null) {
      open.ms = f.t - (fs[open.from] as Frame).t;
      open.dtMax = Math.max(open.dtMax, dt);
      runs.push(open);
      open = null;
    }
  }
  const last = fs.at(-1);
  if (open !== null && last !== undefined) {
    open.ms = last.t - (fs[open.from] as Frame).t;
    runs.push(open);
  }
  const dts = fs
    .slice(1)
    .map((f, i) => f.t - (fs[i] as Frame).t)
    .sort((a, b) => a - b);
  const longest = runs.reduce<Run | null>((a, r) => (a === null || r.ms > a.ms ? r : a), null);
  const tail = last === undefined ? [] : fs.filter((f) => f.t >= last.t - AWAY_MS);
  const gaps = fs.map((f) => f.gap).sort((a, b) => a - b);
  return {
    frames: fs.length,
    grew: last === undefined ? 0 : last.h - (fs[0] as Frame).h,
    max: gaps.at(-1) ?? 0,
    p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
    runs,
    longest,
    up,
    // At the end: a frame within the last AWAY_MS at it (the last may be the frame behind).
    end: tail.length === 0 ? Infinity : Math.min(...tail.map((f) => f.gap)),
    dtMedian: dts[Math.floor(dts.length / 2)] ?? 0,
    dtMax: dts.at(-1) ?? 0,
    slow: dts.filter((d) => d > 25).length,
  };
}
type Judged = ReturnType<typeof judge>;

/** Held at the end: no run away past AWAY_MS, at the end when it stops, never up by itself. */
const held = (j: Judged) => (j.longest?.ms ?? 0) <= AWAY_MS && j.end <= END_PX && j.up === 0;

/** In words, with where the longest run came from: a row grown, the machine's frames, or not. */
const told = (j: Judged) => {
  const l = j.longest;
  const cause =
    l === null
      ? ""
      : `（${l.grewAt ? "那格內容剛長高" : "內容沒長高"}，格距最長 ${round(l.dtMax)} ms）`;
  return `${j.frames} 格（格距中位 ${round(j.dtMedian)} ms、最長 ${round(j.dtMax)} ms、超過 25 ms 的 ${j.slow} 格），內容長高 ${j.grew} px；離底最大 ${round(j.max)} px、p95 ${round(j.p95)} px；離底超過 ${END_PX} px ${j.runs.length} 段，最長 ${l === null ? 0 : `${round(l.ms)} ms／${l.n} 格`}${cause}；往上跳 ${j.up} 次；結束時離底 ${round(j.end)} px`;
};

/** Failures keep their frames: printed around the longest run, and the whole window on disk. */
const traces: Record<string, Frame[]> = {};
function trace(name: string, fs: Frame[], j: Judged) {
  traces[name] = fs;
  const l = j.longest;
  if (l === null) return;
  const t0 = (fs[0] as Frame).t;
  // Its start and its end, 3 frames each side: a long run is told in 14 lines, not all of it.
  const at = (from: number, to: number) =>
    fs.slice(Math.max(0, from), Math.min(fs.length, to)).map((f) => {
      const i = fs.indexOf(f);
      const dt = i === 0 ? "" : ` +${round(f.t - (fs[i - 1] as Frame).t)}`;
      return `    t=${round(f.t - t0)}${dt} 離底 ${round(f.gap)} 高 ${f.h}`;
    });
  const rows =
    l.to - l.from <= 6
      ? at(l.from - 3, l.to + 4)
      : [...at(l.from - 3, l.from + 4), "    …", ...at(l.to - 3, l.to + 4)];
  console.log(`  ${name}: 最長一段的開頭與結尾，前後各 3 格\n${rows.join("\n")}`);
}

/** Checks a window held; on failure its frames go to the log and .visual/scroll/traces.json. */
function checkHeld(ok: boolean, name: string, text: string, fs: Frame[], j: Judged) {
  check(ok, text);
  if (!ok) trace(name, fs, j);
}

/**
 * Presses 捲到最新訊息 and watches from the press: how long until the end (a smooth scroll), then
 * whether the rest of the window is held.
 */
async function pressBack(page: Page, width: keyof typeof WIDTHS) {
  const watching = frames(page, BACK_MS + 1_500, BUTTON);
  await press(page, width);
  const { fs, marked } = await watching;
  const reached = marked === null ? undefined : fs.find((f) => f.t >= marked && f.gap <= END_PX);
  const after = reached === undefined ? [] : fs.filter((f) => f.t >= reached.t);
  return {
    fs,
    j: judge(after.length === 0 ? fs : after),
    pressed: marked !== null,
    backMs: reached === undefined || marked === null ? Infinity : reached.t - marked,
  };
}

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
  const a = await frames(page, 3_000);
  const aj = judge(a.fs);
  checkHeld(
    aj.grew > 100 && held(aj),
    `${width} (a)`,
    `${where} (a) 在底部跟隨 3 秒：${told(aj)}`,
    a.fs,
    aj,
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
  const b = await pressBack(page, width);
  const hidden = (await buttonIs(page, false)).active;
  checkHeld(
    b.pressed && b.backMs <= BACK_MS && held(b.j) && hidden === "false",
    `${width} (b) press`,
    `${where} (b) 按捲到最新訊息：${round(b.backMs)} ms 回到底，之後 ${told(b.j)}；鈕 data-active=${hidden}`,
    b.fs,
    b.j,
  );

  // (b) with no wheel, touch or key: the scrollbar, find in page, a tap on the status bar.
  // Each frame for 1.2 s after: the reply grows below, so the gap only grows; a frame where it
  // shrinks is the thread taken back toward the end.
  await page.locator(".thread-scroll").evaluate((el) => {
    el.scrollTop -= 300;
  });
  const bar = await frames(page, 1_200);
  const pulled = bar.fs.filter((f, i) => i > 0 && f.gap < (bar.fs[i - 1] as Frame).gap - 1).length;
  const first = bar.fs[0]?.gap ?? 0;
  const barShown = await buttonIs(page, true);
  check(
    first >= 250 && pulled === 0 && barShown.active === "true",
    `${where} (b) 串流中 scrollTop -= 300（沒有滾輪、觸控、按鍵）：之後 1.2 秒 ${bar.fs.length} 格，離底 ${round(first)} → ${round(bar.fs.at(-1)?.gap ?? 0)} px，往底部拉回的格 ${pulled} 格；捲到最新訊息 data-active=${barShown.active}`,
  );
  const b2 = await pressBack(page, width);
  checkHeld(
    b2.pressed && b2.backMs <= BACK_MS && held(b2.j),
    `${width} (b) press after scrollTop`,
    `${where} (b) 之後按捲到最新訊息：${round(b2.backMs)} ms 回到底，之後 ${told(b2.j)}`,
    b2.fs,
    b2.j,
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
  // Two windows: the line opening, then the rest of the output at once.
  let watching = frames(page, 1_200);
  await line.focus();
  await page.keyboard.press("Enter");
  const opening = await watching;
  watching = frames(page, 1_200);
  await page.locator('.tool-step:has-text("nas-log") button:has-text("展開其餘")').click();
  const rest = await watching;
  const expanded = await line.getAttribute("aria-expanded");
  const lines = await page
    .locator('.tool-step:has-text("nas-log") [data-slot=code-block-code]')
    .nth(1)
    .evaluate((e) => e.textContent?.split("\n").length ?? 0);
  // In the thread a step opens at once (app.css). Its 200 ms height slid the end up to 126 px
  // for 117–150 ms, which AWAY_MS lets by: this holds the choice itself.
  const slide = await page
    .locator('.tool-step:has-text("nas-log") [data-slot=trace-collapsible-content]')
    .evaluate((e) => getComputedStyle(e).transitionDuration);
  check(slide === "0s", `${where} 對話串裡的工具列展開不做高度動畫：transition-duration ${slide}`);
  const oj = judge(opening.fs);
  const rj = judge(rest.fs);
  checkHeld(
    expanded === "true" && before <= END_PX && held(oj),
    `${width} tool open`,
    `${where} 串流中來了工具列，按 Enter 展開（aria-expanded=${expanded}）：${told(oj)}`,
    opening.fs,
    oj,
  );
  checkHeld(
    lines === 60 && held(rj),
    `${width} tool rest`,
    `${where} 再按展開其餘（共 ${lines} 行）：${told(rj)}`,
    rest.fs,
    rj,
  );
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

if (Object.keys(traces).length > 0) writeFileSync(join(dir, "traces.json"), JSON.stringify(traces));
await browser.close();
head.server.close();
console.log(`${results.length} ok, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
