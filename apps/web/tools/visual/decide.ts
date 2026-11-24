// A double press on one approval card must decide that card only (p4_review.md 5, 6). The scene
// "別的對話的待核准卡" gets a second card from another conversation, so the pinned dock holds two
// waiting; then the first card's approve (and, in another page, deny) button takes a double
// click at the desktop's width, and two taps at the phone's, 0, 60, 150, 300, 700 and 900 ms
// apart, and a focused deny button takes Enter twice. After a decision the focus goes to the second card,
// whose buttons the browser scrolls to where the first's were: that is what a layout-free test
// cannot show. The fake local end never answers, so each decision sent stays sent; the count of
// approval.decide it got must be one, for the first card. Then, 1000 ms on, the second card's
// decision is sent: the press held back took nothing with it.
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
const scene = SCENES.findIndex((s) => s.name === "別的對話的待核准卡") + 1;
if (scene === 0) throw new Error("no scene 別的對話的待核准卡");
const FIRST = approval("c-ledger").approvalId;
const SECOND = approval("c-other").approvalId;

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

/** The first card's button in the pinned dock, by the card's place. */
const button = (page: Page, card: number, press: Press) =>
  page
    .locator(".pinned-approvals .approval-card")
    .nth(card)
    .locator(".approval-actions button")
    .nth(press === "deny" ? 0 : 1);

/** CSP violations other than zod's eval probe, as csp.ts counts them. */
const violations = async (page: Page) =>
  (
    (await page.evaluate(
      () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
    )) as Violation[]
  )
    .filter((v) => !isProbe(v))
    .map((v) => `CSP: ${v.directive} ${v.blocked}`);

async function open(w: (typeof WIDTHS)[number], problems: string[]) {
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
  await page.goto(`${url}/?scene=${scene}`, { waitUntil: "load" });
  await page.clock.runFor(400);
  await page.evaluate(
    (m) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(m),
    { kind: "approval.request", conv: "c-other", p: { approval: approval("c-other") } },
  );
  await page.clock.runFor(300);
  const n = await page.locator(".pinned-approvals .approval-card").count();
  if (n !== 2) throw new Error(`${w.name}: ${n} cards in the pinned dock, not 2`);
  return { context, page };
}

const bad: string[] = [];
let checks = 0;
const result = (name: string, got: string[], want: string[]) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad.push(`${name}: sent ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${got.length} decision(s) ${JSON.stringify(got)}`);
};

/** The presses at one spot after the first: the gaps before each, in ms. */
const RUNS = [
  ...GAPS.map((gap) => ({ name: `×2, ${gap} ms`, gaps: [gap] })),
  { name: "again 1.35 s on", gaps: [1_350] },
  { name: "×5, 330 ms apart", gaps: [330, 330, 330, 330] },
];

for (const w of WIDTHS)
  for (const press of ["approve", "deny"] as const)
    for (const run of RUNS) {
      const problems: string[] = [];
      const { context, page } = await open(w, problems);
      const box = await button(page, 0, press).boundingBox();
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
      const name = `${w.name} ${press} ${run.name}`;
      result(name, await sent(page), [`${decision}@${FIRST}`]);
      await page.screenshot({ path: join(shots, `${w.name}-${press}-${run.name}.png`) });
      // 1000 ms after the last press, the second card's own press is sent. A second card already
      // decided by then has no button to press: that run has failed above.
      await page.clock.runFor(1_000);
      if (await button(page, 1, press).isEnabled()) {
        await button(page, 1, press).click();
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
for (const w of WIDTHS)
  for (const held of [false, true]) {
    const problems: string[] = [];
    const { context, page } = await open(w, problems);
    await button(page, 0, "deny").focus();
    await page.keyboard.press("Enter");
    await page.clock.runFor(30);
    const second = await page.evaluate(
      () => document.activeElement?.closest(".approval-card") !== null,
    );
    if (held) {
      await page.keyboard.down("Enter");
      for (let i = 0; i < 45; i++) {
        await page.clock.runFor(33);
        await page.keyboard.down("Enter");
      }
      await page.keyboard.up("Enter");
    } else await page.keyboard.press("Enter");
    const name = `${w.name} Enter ${held ? "held 1.5 s" : "×2"} on deny (focus moved to a card: ${second})`;
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
  const { context, page } = await open(w, problems);
  const box = await button(page, 0, "approve").boundingBox();
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
if (bad.length > 0) {
  console.log(`failed:\n- ${bad.join("\n- ")}`);
  process.exit(1);
}
