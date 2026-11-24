// iOS Safari zooms the page when a form control under 16px gets focus, and the page then stays
// wider than the screen (the send button goes off it). This opens every scene at the phone's
// width, as a touch device, takes the scene's steps, and lists each visible input, textarea,
// select or editable element whose font size is under 16px. It fails when there is one.
//   node tools/visual/zoom.ts [--only <scene>]
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/zoom/.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { buildTree, serve } from "./page.ts";
import { NOW, SCENES } from "./scenes.ts";

const { values: args } = parseArgs({ options: { only: { type: "string" } } });
const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "zoom");
await buildTree(web, dir, true);
const { url, server } = await serve(dir);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: "reduce",
  locale: "zh-TW",
  timezoneId: "Asia/Taipei",
});

/** What a touch device would zoom into: a visible control the keyboard types into. */
const SMALL = () => {
  const found: string[] = [];
  const sel = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    if (
      el instanceof HTMLInputElement &&
      /^(checkbox|radio|range|hidden|button|submit)$/.test(el.type)
    )
      continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width === 0 || box.height === 0 || style.visibility === "hidden") continue;
    const size = Number.parseFloat(style.fontSize);
    if (size < 16) {
      const label = el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "";
      found.push(
        `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${label}" ${size}px`,
      );
    }
  }
  return found;
};

const bad: string[] = [];
let checked = 0;
for (const [i, s] of SCENES.entries()) {
  const n = i + 1;
  if (args.only !== undefined && String(n) !== args.only) continue;
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.goto(`${url}/?scene=${n}`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  for (const step of s.phone ?? s.steps ?? []) {
    try {
      if ("click" in step) await page.locator(step.click).first().click({ timeout: 5_000 });
      else if ("fill" in step)
        await page.locator(step.fill).first().fill(step.text, { timeout: 5_000 });
      else await page.waitForTimeout(step.wait);
    } catch {
      bad.push(`scene ${n} ${s.name}: step failed ${JSON.stringify(step)}`);
      break;
    }
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  for (const f of await page.evaluate(SMALL)) bad.push(`scene ${n} ${s.name}: ${f}`);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) bad.push(`scene ${n} ${s.name}: the page is ${wide}px wider than the screen`);
  checked += 1;
  await page.close();
}
await browser.close();
server.close();
console.log(`${checked} scene(s) at 390 px as a touch device`);
if (bad.length > 0) {
  console.log(`controls under 16px or steps not taken:\n- ${bad.join("\n- ")}`);
  process.exit(1);
}
console.log("no control under 16px");
