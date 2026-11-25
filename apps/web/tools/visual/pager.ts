// The approval pager (M4-P4b) as a browser lays it out, at a desktop's and a phone's width: what
// jsdom cannot show. On the scene "別的對話的待核准卡" (one card from another conversation),
// cards are pushed to it:
// - one card: no pager, the dock as before;
// - two: the header and its arrows at least 44 px, ‹ off at the first card and › at the last,
//   no wrapping; a card changed to starts at its top, and where the last one's buttons were is
//   no button of it; decided, it stays shown;
// - three, one writing outside: its tag, and each arrow's count of what waits that way;
// - a phone, one card taller than the dock: scrolled to its end, the header still shows and
//   both buttons can be pressed.
//   node tools/visual/pager.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/pager/.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { approval, NOW, SCENES } from "./scenes.ts";

const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "pager");
const shots = join(dir, "shots");
await buildTree(web, join(dir, "build"), true);
mkdirSync(shots, { recursive: true });
const { url, server } = await serve(join(dir, "build"));
const { isProbe } = zodProbe(join(dir, "build"), url);
const scene = SCENES.findIndex((s) => s.name === "別的對話的待核准卡") + 1;
if (scene === 0) throw new Error("no scene 別的對話的待核准卡");

const browser: Browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});
const WIDTHS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
] as const;

/** The scene's card is the first; these come after it, in order. */
const EXTRA = {
  "c-other": { ...approval("c-other"), effects: "read", domains: [], secret: null },
  "c-fts": { ...approval("c-fts"), script: "fts-tokenize" },
};
/** A card of many arguments: on a phone, taller than the dock's 40dvh. */
const TALL = {
  ...approval("c-old"),
  argv: Array.from({ length: 40 }, (_, i) => `--arg-${i}=${"x".repeat(12)}`),
};

const bad: string[] = [];
let checks = 0;
const check = (name: string, ok: boolean, got: unknown) => {
  checks += 1;
  if (!ok) bad.push(`${name}: ${JSON.stringify(got)}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}`);
};

const push = (page: Page, a: object & { conv: string }) =>
  page.evaluate((m) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(m), {
    kind: "approval.request",
    conv: a.conv,
    p: { approval: a },
  });

async function open(w: (typeof WIDTHS)[number], more: (object & { conv: string })[]) {
  const context = await browser.newContext({
    viewport: w.viewport,
    deviceScaleFactor: 1,
    isMobile: w.isMobile,
    hasTouch: w.hasTouch,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
  await page.addInitScript(COLLECT);
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW + 1_000);
  await page.goto(`${url}/?scene=${scene}`, { waitUntil: "load" });
  await page.clock.runFor(400);
  for (const a of more) await push(page, a);
  await page.clock.runFor(300);
  return { context, page, problems };
}

const violations = async (page: Page) =>
  (
    (await page.evaluate(
      () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
    )) as Violation[]
  )
    .filter((v) => !isProbe(v))
    .map((v) => `CSP: ${v.directive} ${v.blocked}`);

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).first().boundingBox();
  if (b === null) throw new Error(`no ${sel}`);
  return b;
};
const meta = (page: Page) => page.locator(".pager-meta").textContent();
const off = (page: Page, sel: string) => page.locator(sel).getAttribute("aria-disabled");
/** What is under a point: a button's text and whether it is off, or nothing. */
const under = (page: Page, [x, y]: [number, number]) =>
  page.evaluate(
    ([x, y]) => {
      const b = document.elementFromPoint(x, y)?.closest("button");
      if (b == null) return "no button";
      const isOff = b.disabled || b.getAttribute("aria-disabled") === "true";
      return `${b.textContent?.trim()}${isOff ? " (off)" : ""}`;
    },
    [x, y] as [number, number],
  );
const pressAt = async (page: Page, touch: boolean, spot: [number, number]) => {
  if (touch) await page.touchscreen.tap(...spot);
  else await page.mouse.click(...spot);
};

for (const w of WIDTHS) {
  // One card: the dock as before, no pager.
  {
    const { context, page, problems } = await open(w, []);
    const pager = await page.locator(".pager").count();
    const paged = await page.locator(".pinned-approvals.paged").count();
    check(`${w.name} one card: no pager header`, pager === 0 && paged === 0, { pager, paged });
    await page.screenshot({ path: join(shots, `${w.name}-1-one.png`) });
    for (const p of [...problems, ...(await violations(page))]) bad.push(`${w.name} one: ${p}`);
    await context.close();
  }

  // Two cards.
  {
    const { context, page, problems } = await open(w, [EXTRA["c-other"]]);
    const head = await box(page, ".pager");
    const prev = await box(page, ".pager-prev");
    const next = await box(page, ".pager-next");
    check(`${w.name} two: header at least 44 px tall`, head.height >= 44, head.height);
    check(
      `${w.name} two: arrows at least 44×44`,
      [prev, next].every((b) => b.width >= 44 && b.height >= 44),
      [prev, next].map((b) => [b.width, b.height]),
    );
    const order =
      w.name === "phone" ? prev.x > head.x + head.width / 2 : prev.x < head.x + head.width / 2;
    check(
      `${w.name} two: ‹ ${w.name === "phone" ? "at the right, by ›" : "at the left"}`,
      order && next.x > prev.x,
      { prev: prev.x, next: next.x },
    );
    const startOk =
      (await meta(page))?.includes("1/2") === true &&
      (await off(page, ".pager-prev")) === "true" &&
      (await off(page, ".pager-next")) !== "true";
    check(`${w.name} two: starts at 1/2, ‹ off and › on`, startOk, await meta(page));
    await page.screenshot({ path: join(shots, `${w.name}-2-first.png`) });

    // ‹ at the first does nothing: no wrapping to the last. Forced: Playwright waits for an
    // arrow off (aria-disabled) to come on, where a hand presses it anyway.
    await page.locator(".pager-prev").click({ force: true });
    check(
      `${w.name} two: ‹ at the first stays`,
      (await meta(page))?.includes("1/2") === true,
      await meta(page),
    );

    // Scrolled to the first card's buttons, then changed: the second starts at its top, and where
    // the first's buttons were is none of the second's.
    const approve = page.locator(".pinned-approvals .approval-actions button").nth(1);
    await approve.scrollIntoViewIfNeeded();
    const was = await approve.boundingBox();
    if (was === null) throw new Error("no approve button");
    const spot: [number, number] = [was.x + was.width / 2, was.y + was.height / 2];
    await page.locator(".pager-next").click();
    await page.clock.runFor(100);
    const top = await page.locator(".pinned-scroll").evaluate((e) => e.scrollTop);
    check(`${w.name} two: changed to, the card starts at its top`, top === 0, top);
    const there = await under(page, spot);
    const now = await page
      .locator(".pinned-approvals .approval-actions button")
      .nth(1)
      .boundingBox();
    const moved =
      now === null ||
      Math.abs(now.x + now.width / 2 - spot[0]) > now.width / 2 ||
      Math.abs(now.y + now.height / 2 - spot[1]) > now.height / 2;
    check(
      `${w.name} two: where card 1's approve was, no button of card 2`,
      moved && !/核准執行|拒絕/.test(there),
      { there, now: now === null ? null : [now.x, now.y], was: spot },
    );
    check(
      `${w.name} two: at the last, › off`,
      (await meta(page))?.includes("2/2") === true && (await off(page, ".pager-next")) === "true",
      { meta: await meta(page), next: await off(page, ".pager-next") },
    );
    await page.locator(".pager-next").click({ force: true });
    check(
      `${w.name} two: › at the last stays`,
      (await meta(page))?.includes("2/2") === true,
      await meta(page),
    );
    await page.screenshot({ path: join(shots, `${w.name}-3-second.png`) });

    // Back to the first, decide it at its buttons, and its result comes: it stays shown.
    await page.locator(".pager-prev").click();
    const first = page.locator(".pinned-approvals .approval-actions button").nth(1);
    await first.scrollIntoViewIfNeeded();
    const at = await first.boundingBox();
    if (at === null) throw new Error("no approve button");
    const press: [number, number] = [at.x + at.width / 2, at.y + at.height / 2];
    await pressAt(page, w.hasTouch, press);
    await page.clock.runFor(1_500);
    const sentMeta = await meta(page);
    await page.evaluate(
      (m) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(m),
      {
        kind: "approval.resolved",
        p: { approvalId: approval("c-ledger").approvalId, state: "approved", via: "remote" },
      },
    );
    await page.clock.runFor(3_000);
    const doneMeta = await meta(page);
    check(
      `${w.name} two: decided, it stays shown (no moving on)`,
      sentMeta?.includes("1/2") === true &&
        sentMeta.includes("等待本機回應") &&
        doneMeta?.includes("1/2") === true &&
        doneMeta.includes("已決定（已核准）"),
      { sentMeta, doneMeta },
    );
    const focus = await page.evaluate(() => {
      const a = document.activeElement;
      return a?.tagName === "BUTTON" ? `button ${a.textContent?.trim()}` : (a?.className ?? "");
    });
    check(`${w.name} two: decided, the focus is on no button`, !focus.startsWith("button"), focus);
    const pressedAgain = await under(page, press);
    check(
      `${w.name} two: decided, where it was pressed is no button to decide`,
      !/核准執行|拒絕/.test(pressedAgain) || pressedAgain.endsWith("(off)"),
      pressedAgain,
    );
    await page.screenshot({ path: join(shots, `${w.name}-4-decided.png`) });
    for (const p of [...problems, ...(await violations(page))]) bad.push(`${w.name} two: ${p}`);
    await context.close();
  }

  // Three: the second reads only, the third writes outside.
  {
    const { context, page, problems } = await open(w, [EXTRA["c-other"], EXTRA["c-fts"]]);
    const badge = (sel: string) => page.locator(`${sel} .pager-badge`).textContent();
    check(
      `${w.name} three: › counts 2 waiting that way`,
      (await badge(".pager-next")) === "2",
      await badge(".pager-next"),
    );
    await page.locator(".pager-next").click();
    const readOnly = await page.locator(".pager .sg-tag.warn").count();
    check(`${w.name} three: the second reads only, no 寫外部`, readOnly === 0, readOnly);
    await page.locator(".pager-next").click();
    const tag = await page.locator(".pager .sg-tag.warn").textContent();
    check(
      `${w.name} three: the third, 寫外部, and ‹ counts 2`,
      tag === "寫外部" && (await badge(".pager-prev")) === "2",
      { tag, prev: await badge(".pager-prev") },
    );
    await page.screenshot({ path: join(shots, `${w.name}-5-three-external.png`) });
    for (const p of [...problems, ...(await violations(page))]) bad.push(`${w.name} three: ${p}`);
    await context.close();
  }
}

// A phone, the card taller than the dock.
{
  const w = WIDTHS[1];
  const { context, page, problems } = await open(w, [TALL]);
  await page.locator(".pager-next").click();
  const sizes = await page
    .locator(".pinned-scroll")
    .evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight }));
  check("phone tall: the card is taller than the dock", sizes.scroll > sizes.client * 1.5, sizes);
  await page.locator(".pinned-scroll").evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await page.clock.runFor(100);
  const head = await page.locator(".pager").boundingBox();
  const inView = (b: { y: number; height: number } | null) =>
    b !== null && b.y >= 0 && b.y + b.height <= w.viewport.height;
  const buttons = page.locator(".pinned-approvals .approval-actions button");
  const deny = await buttons.nth(0).boundingBox();
  const approve = await buttons.nth(1).boundingBox();
  check("phone tall: scrolled to its end, the header still shows", inView(head), head);
  check("phone tall: both buttons in sight to press", inView(deny) && inView(approve), {
    deny,
    approve,
  });
  await page.screenshot({ path: join(shots, "phone-6-tall-scrolled.png") });
  for (const p of [...problems, ...(await violations(page))]) bad.push(`phone tall: ${p}`);
  await context.close();
}

await browser.close();
server.close();
console.log(`${checks - bad.length} ok, ${bad.length} failed`);
if (bad.length > 0) {
  console.log(`failed:\n- ${bad.join("\n- ")}`);
  process.exit(1);
}
