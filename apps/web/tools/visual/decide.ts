// A double press on one approval card must decide that card only (p4_review.md 5, 6). The scene
// "別的對話的待核准卡" gets a second card from another conversation, so the pinned dock holds two
// waiting; then the first card's approve (and, in another page, deny) button takes a double
// click at the desktop's width, and two taps at the phone's, 0, 60, 150 and 300 ms apart, and a
// focused deny button takes Enter twice. After a decision the focus goes to the second card,
// whose buttons the browser scrolls to where the first's were: that is what a layout-free test
// cannot show. The fake local end never answers, so each decision sent stays sent; the count of
// approval.decide it got must be one, for the first card. Then, 700 ms on, the second card's
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
const GAPS = [0, 60, 150, 300];

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
  await page.clock.install({ time: NOW });
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

for (const w of WIDTHS)
  for (const press of ["approve", "deny"] as const)
    for (const gap of GAPS) {
      const problems: string[] = [];
      const { context, page } = await open(w, problems);
      const box = await button(page, 0, press).boundingBox();
      if (box === null) throw new Error(`${w.name}: no ${press} button`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      // Two presses at one spot, as a hand gives them: what is under it the second time is
      // whatever the page has moved there.
      for (const i of [0, 1]) {
        if (i === 1) await page.clock.runFor(gap);
        if (w.hasTouch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
      }
      const decision = press === "approve" ? "approved" : "denied";
      const name = `${w.name} ${press} ×2, ${gap} ms`;
      result(name, await sent(page), [`${decision}@${FIRST}`]);
      await page.screenshot({ path: join(shots, `${w.name}-${press}-${gap}.png`) });
      // 700 ms after the first, the second card's own press is sent. A second card already
      // decided by the double press has no button to press: that run has failed above.
      await page.clock.runFor(700);
      if (await button(page, 1, press).isEnabled()) {
        await button(page, 1, press).click();
        result(`${name}, then the second card at 700 ms`, await sent(page), [
          `${decision}@${FIRST}`,
          `${decision}@${SECOND}`,
        ]);
      }
      for (const p of [...problems, ...(await violations(page))]) bad.push(`${name}: ${p}`);
      await context.close();
    }

// The keyboard: the focus on the first card's deny button, Enter twice.
for (const w of WIDTHS) {
  const problems: string[] = [];
  const { context, page } = await open(w, problems);
  await button(page, 0, "deny").focus();
  await page.keyboard.press("Enter");
  await page.clock.runFor(30);
  const second = await page.evaluate(
    () => document.activeElement?.closest(".approval-card") !== null,
  );
  await page.keyboard.press("Enter");
  result(`${w.name} Enter ×2 on deny (focus moved to a card: ${second})`, await sent(page), [
    `denied@${FIRST}`,
  ]);
  for (const p of [...problems, ...(await violations(page))]) bad.push(`${w.name} Enter: ${p}`);
  await context.close();
}

await browser.close();
server.close();
console.log(`${checks - bad.length} ok, ${bad.length} failed`);
if (bad.length > 0) {
  console.log(`failed:\n- ${bad.join("\n- ")}`);
  process.exit(1);
}
