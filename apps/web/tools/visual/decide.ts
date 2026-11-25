// A double press on one approval card must decide that card only (p4_review.md 5, 6). Two
// layouts of two cards waiting, each a scene with one card and a second pushed to it:
// - pager, on "別的對話的待核准卡": a second card from another conversation, so the pinned dock
//   pages them (M4-P4b) and the second is reached by its arrow;
// - thread, on "核准卡：等待中，寫外部加任意主機" (its turn running, so the cards stay): a second
//   card of the conversation open, one under the other in the thread, where a
//   decision moves the focus to the second and the browser may scroll its buttons to where the
//   first's were (what a layout-free test cannot show).
// The first card's approve (and, in another page, deny) button takes a double click at the
// desktop's width, and two taps at the phone's, 0, 60, 150, 300, 700 and 900 ms apart, and a
// focused deny button takes Enter twice. The fake local end never answers, so each decision sent
// stays sent; the count of approval.decide it got must be one, for the first card. Then, 1000 ms
// on, the second card's decision is sent: the press held back took nothing with it.
//   node tools/visual/decide.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/decide/.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { approval, NOW, SCENES } from "./scenes.ts";

const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "decide");
const shots = join(dir, "shots");
await buildTree(web, join(dir, "build"), true);
mkdirSync(shots, { recursive: true });
const { url, server } = await serve(join(dir, "build"));
const { isProbe } = zodProbe(join(dir, "build"), url);
const sceneOf = (name: string) => {
  const n = SCENES.findIndex((s) => s.name === name) + 1;
  if (n === 0) throw new Error(`no scene ${name}`);
  return n;
};
const SCENE = {
  pager: sceneOf("別的對話的待核准卡"),
  thread: sceneOf("核准卡：等待中，寫外部加任意主機"),
};
type Layout = "pager" | "thread";
const LAYOUTS = ["pager", "thread"] as const;
const two = (layout: Layout) =>
  layout === "pager"
    ? [approval("c-ledger"), approval("c-other")]
    : [
        approval("c-backup", "call-1"),
        { ...approval("c-backup", "call-1"), approvalId: "ap-thread-2" },
      ];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});
const WIDTHS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
] as const;
type Press = "approve" | "deny";
const GAPS = [0, 60, 150, 300, 700, 900];

const sent = (page: Page) =>
  page.evaluate(() =>
    ((globalThis as { visualSent?: { kind: string; p: unknown }[] }).visualSent ?? [])
      .filter((m) => m.kind === "approval.decide")
      .map((m) => {
        const p = m.p as { approvalId: string; decision: string };
        return `${p.decision}@${p.approvalId}`;
      }),
  );

const CARDS = {
  pager: ".pinned-approvals .approval-card",
  thread: ".thread-scroll .approval-card",
};
/**
 * A card's button by its place among the cards in the page. Behind the pager only the one shown
 * is there: card 1 is reached by pressing its arrow first (`second`).
 */
const button = (page: Page, layout: Layout, card: number, press: Press) =>
  page
    .locator(CARDS[layout])
    .nth(layout === "pager" ? 0 : card)
    .locator(".approval-actions button")
    .nth(press === "deny" ? 0 : 1);
/** Shows the second card: behind the pager, its arrow; in the thread it is there already. */
const second = async (page: Page, layout: Layout) => {
  if (layout === "pager") await page.locator(".pager-next").click();
};

/** CSP violations other than zod's eval probe, as csp.ts counts them. */
const violations = async (page: Page) =>
  (
    (await page.evaluate(
      () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
    )) as Violation[]
  )
    .filter((v) => !isProbe(v))
    .map((v) => `CSP: ${v.directive} ${v.blocked}`);

async function open(w: (typeof WIDTHS)[number], layout: Layout, problems: string[]) {
  const context = await browser.newContext({
    viewport: w.viewport,
    isMobile: w.isMobile,
    hasTouch: w.hasTouch,
    reducedMotion: "reduce",
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
  await page.addInitScript(COLLECT);
  // Stopped: only runFor moves the page's time, so a gap is what the run says, however slow the
  // machine (with install alone it went on with the wall clock; double_decide_review.md 3).
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW + 1_000);
  await page.goto(`${url}/?scene=${SCENE[layout]}`, { waitUntil: "load" });
  await page.clock.runFor(400);
  // The thread's scene opens its conversation (on a phone, through the drawer).
  const steps = SCENES[SCENE[layout] - 1];
  for (const step of (w.hasTouch ? steps?.phone : undefined) ?? steps?.steps ?? [])
    if ("click" in step) {
      await page.click(step.click);
      await page.clock.runFor(400);
    }
  // The scene's own card is the first; the second comes here.
  for (const a of two(layout).slice(1))
    await page.evaluate(
      (m) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(m),
      { kind: "approval.request", conv: a.conv, p: { approval: a } },
    );
  await page.clock.runFor(300);
  const n =
    layout === "pager"
      ? await page.locator(".pager-meta").textContent()
      : String(await page.locator(CARDS.thread).count());
  if (layout === "pager" ? !(n ?? "").includes("1/2") : n !== "2")
    throw new Error(`${w.name} ${layout}: ${n}, not two cards`);
  return { context, page };
}

const bad: string[] = [];
let checks = 0;
const known: string[] = [];
const result = (name: string, got: string[], want: string[], isKnown = false) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  // In the thread, a press past the 1000 ms window can land on the next card's button, scrolled
  // there: so on main too (512d5f8), a design question put to the owner (M4-P4b), not a pager
  // fault. Printed and counted apart, never as a pass.
  if (isKnown) {
    if (!ok) known.push(`${name}: sent ${JSON.stringify(got)}`);
    console.log(
      `${ok ? "ok  " : "KNOWN"} ${name}: ${got.length} decision(s) ${JSON.stringify(got)}`,
    );
    return;
  }
  checks += 1;
  if (!ok) bad.push(`${name}: sent ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${got.length} decision(s) ${JSON.stringify(got)}`);
};

/** The presses at one spot after the first: the gaps before each, in ms. */
const RUNS = [
  ...GAPS.map((gap) => ({ name: `×2, ${gap} ms`, gaps: [gap] })),
  { name: "again 1.35 s on", gaps: [1_350] },
  { name: "×5, 330 ms apart", gaps: [330, 330, 330, 330] },
];

for (const layout of LAYOUTS)
  for (const w of WIDTHS)
    for (const press of ["approve", "deny"] as const)
      for (const run of RUNS) {
        const problems: string[] = [];
        const { context, page } = await open(w, layout, problems);
        const [FIRST, SECOND] = two(layout).map((a) => a.approvalId);
        // A hand scrolls to the buttons first: behind the pager they start below the dock's fold.
        await button(page, layout, 0, press).scrollIntoViewIfNeeded();
        const box = await button(page, layout, 0, press).boundingBox();
        if (box === null) throw new Error(`${w.name}: no ${press} button`);
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        // Presses at one spot, as a hand gives them: what is under it each time is whatever the
        // page has put there.
        for (const gap of [0, ...run.gaps]) {
          await page.clock.runFor(gap);
          if (w.hasTouch) await page.touchscreen.tap(x, y);
          else await page.mouse.click(x, y);
        }
        const decision = press === "approve" ? "approved" : "denied";
        const name = `${layout} ${w.name} ${press} ${run.name}`;
        result(
          name,
          await sent(page),
          [`${decision}@${FIRST}`],
          layout === "thread" && run.gaps.some((g) => g >= 1_000),
        );
        await page.screenshot({
          path: join(shots, `${layout}-${w.name}-${press}-${run.name}.png`),
        });
        // 1000 ms after the last press, the second card's own press is sent. A second card already
        // decided by then has no button to press: that run has failed above.
        await page.clock.runFor(1_000);
        await second(page, layout);
        if (await button(page, layout, 1, press).isEnabled()) {
          await button(page, layout, 1, press).click();
          result(`${name}, then the second card 1000 ms on`, await sent(page), [
            `${decision}@${FIRST}`,
            `${decision}@${SECOND}`,
          ]);
        }
        for (const p of [...problems, ...(await violations(page))]) bad.push(`${name}: ${p}`);
        await context.close();
      }

// The keyboard: the focus on the first card's deny button, Enter twice, then Enter held for
// 1.5 s (a keydown each 33 ms, as auto-repeat sends them).
for (const layout of LAYOUTS)
  for (const w of WIDTHS)
    for (const held of [false, true]) {
      const problems: string[] = [];
      const { context, page } = await open(w, layout, problems);
      const [FIRST] = two(layout).map((a) => a.approvalId);
      await button(page, layout, 0, "deny").focus();
      await page.keyboard.press("Enter");
      await page.clock.runFor(30);
      // Behind the pager the focus stays on the card decided (its box); in the thread it moves to
      // the next card's deny.
      const moved = await page.evaluate(() => {
        const card = document.activeElement?.closest(".approval-card");
        return card == null
          ? "no"
          : document.activeElement?.tagName === "BUTTON"
            ? "a button"
            : "yes";
      });
      if (held) {
        await page.keyboard.down("Enter");
        for (let i = 0; i < 45; i++) {
          await page.clock.runFor(33);
          await page.keyboard.down("Enter");
        }
        await page.keyboard.up("Enter");
      } else await page.keyboard.press("Enter");
      const name = `${layout} ${w.name} Enter ${held ? "held 1.5 s" : "×2"} on deny (focus moved to a card: ${moved})`;
      result(name, await sent(page), [`denied@${FIRST}`]);
      for (const p of [...problems, ...(await violations(page))]) bad.push(`${name}: ${p}`);
      await context.close();
    }

// Not a check (double_decide_review.md, task A3): after the first card's result comes, what is
// under the spot the first press was made at.
const UNDER = ([x, y]: [number, number]) => {
  const b = document.elementFromPoint(x, y)?.closest("button");
  const card = b?.closest(".approval-card");
  const all = [...document.querySelectorAll(".pinned-approvals .approval-card")];
  return b == null
    ? `no button (${document.elementFromPoint(x, y)?.className ?? "nothing"})`
    : `card ${card == null ? "-" : all.indexOf(card) + 1} 「${b.textContent}」${b.disabled ? " disabled" : ""}`;
};
for (const w of WIDTHS) {
  const problems: string[] = [];
  const { context, page } = await open(w, "pager", problems);
  const [FIRST] = two("pager").map((a) => a.approvalId);
  await button(page, "pager", 0, "approve").scrollIntoViewIfNeeded();
  const box = await button(page, "pager", 0, "approve").boundingBox();
  if (box === null) throw new Error(`${w.name}: no approve button`);
  const spot: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
  if (w.hasTouch) await page.touchscreen.tap(...spot);
  else await page.mouse.click(...spot);
  await page.clock.runFor(100);
  const pressed = await page.evaluate(UNDER, spot);
  await page.evaluate(
    (m) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(m),
    { kind: "approval.resolved", p: { approvalId: FIRST, state: "approved", via: "remote" } },
  );
  await page.clock.runFor(300);
  const cards = await page.locator(".pinned-approvals .approval-card").count();
  const resolved = await page.evaluate(UNDER, spot);
  await page.screenshot({ path: join(shots, `${w.name}-after-result.png`) });
  console.log(
    `info ${w.name}: under the spot after the press: ${pressed}; after the result: ${resolved}; ${cards} card(s) in the dock`,
  );
  await context.close();
}

await browser.close();
server.close();
console.log(`${checks - bad.length} ok, ${bad.length} failed`);
if (known.length > 0)
  console.log(`known, not counted (thread, past the window):\n- ${known.join("\n- ")}`);
if (bad.length > 0) {
  console.log(`failed:\n- ${bad.join("\n- ")}`);
  process.exit(1);
}
