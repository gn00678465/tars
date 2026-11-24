// The app's CSP while the ledger form's account combobox is used (M4-P1; the design's
// csp-test, cut down to this). Chromium opens the form scene at both widths, types Chinese and
// English into the two account fields, picks, fills the rest and sends. It fails on any CSP
// violation or page error, or when ui.submit does not carry the English account names.
// zod 4's eval probe is left out, and only it (zodProbe in page.ts): main has it on every load.
//   node tools/visual/csp.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/csp/.
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { NOW, SCENES } from "./scenes.ts";

const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "csp");
const scene = SCENES.findIndex((s) => s.name.startsWith("記帳表單")) + 1;
if (scene === 0) throw new Error("no ledger form scene in scenes.ts");

await buildTree(web, dir, true);
const { url, server } = await serve(dir);

const { isProbe } = zodProbe(dir, url);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});

/** Types into an account field, checks what is listed, and picks the one option left. */
async function pick(page: Page, nth: number, typed: string, option: string) {
  const input = page.locator('input[role="combobox"]').nth(nth);
  await input.click();
  await input.fill(typed);
  // The labels of the options shown; a closed popup can stay in the DOM, hidden.
  const listed = await page.getByRole("option").locator('[data-part="label"]').allTextContents();
  if (listed.length !== 1 || listed[0] !== option)
    throw new Error(`typed ${typed}: listed ${JSON.stringify(listed)}, not only ${option}`);
  await page.getByRole("option").filter({ hasText: option }).click();
  const shown = await input.inputValue();
  if (shown !== option) throw new Error(`picked ${option}: the field shows ${shown}`);
}

const text = (page: Page, label: string) =>
  page.locator("a2ui-basic-textfield", { hasText: label }).locator("input");

const failures: string[] = [];
for (const [width, options] of Object.entries({
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
})) {
  const context = await browser.newContext({ ...options, locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  try {
    await page.clock.setFixedTime(NOW);
    await page.goto(`${url}/?scene=${scene}`, { waitUntil: "load" });
    if (width === "phone") await page.locator('[aria-label="展開對話列表"]').click();
    await page.locator(".conv-list >> text=記帳表單").first().click();
    await pick(page, 0, "晚餐", "晚餐（Expenses:Food:Dinner）");
    await pick(page, 1, "Credit", "信用卡（Liabilities:CreditCard）");
    await text(page, "金額").fill("190");
    await text(page, "摘要").fill("晚餐");
    await page.locator(".ui-form-body button", { hasText: "送出" }).click();
    await page.waitForTimeout(300);
    const submitted = await page.evaluate(() =>
      (
        (globalThis as { visualSent?: { kind: string; p: { context?: unknown } }[] }).visualSent ??
        []
      )
        .filter((m) => m.kind === "ui.submit")
        .map((m) => m.p.context),
    );
    const want = { target: "Expenses:Food:Dinner", source: "Liabilities:CreditCard" };
    const got = submitted[0] as Record<string, unknown> | undefined;
    if (submitted.length !== 1 || got?.target !== want.target || got.source !== want.source)
      failures.push(`${width}: ui.submit sent ${JSON.stringify(submitted)}`);
  } catch (e) {
    failures.push(`${width}: ${(e as Error).message.split("\n")[0]}`);
  }
  await page.screenshot({ path: join(dir, `${width}.png`) });
  const seen = await page.evaluate(() => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? []);
  const violations = seen as Violation[];
  const probes = violations.filter(isProbe);
  failures.push(
    ...errors.map((t) => `${width}: ${t}`),
    ...violations.filter((v) => !isProbe(v)).map((v) => `${width}: CSP ${JSON.stringify(v)}`),
    ...(probes.length > 1 ? [`${width}: zod's probe ${probes.length} times, not once`] : []),
  );
  console.log(`${width}: done; zod's eval probe ${probes.length} time(s), left out`);
  await context.close();
}

await browser.close();
server.close();
console.log(
  failures.length === 0 ? "no CSP violation, page error or wrong value" : failures.join("\n"),
);
process.exitCode = failures.length === 0 ? 0 : 1;
