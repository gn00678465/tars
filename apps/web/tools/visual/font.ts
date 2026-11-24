// Which fonts a page fetches (M4-F). Each scene opens in a fresh context, so nothing is cached.
// The woff2 responses are held until the page has drawn with the fallback, then let go: the boxes
// of the text before and after, and the layout shifts after, are the swap's. Two builds:
// - as built: this machine has no PingFang TC, so the Chinese takes Noto Sans TC Variable;
// - an Apple device's stand-in: the build's CSS with "PingFang TC" renamed to a CJK font this
//   machine has (--local, default "Noto Sans CJK TC", from fc-list :lang=zh-tw), so that name
//   draws at PingFang's place in the stack. It should fetch no font.
// For each it counts the woff2 requests and bytes, the faces document.fonts loaded, the font
// Chromium drew a Chinese line with (CDP's platform fonts), the swap's shift, and the CSP
// violations other than zod's eval probe. It fails when the stand-in fetches a font, when the
// build as is draws Chinese without the served font, or on a violation.
//   node tools/visual/font.ts [--local <family>]
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/font/.
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright-core";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { NOW, SCENES } from "./scenes.ts";

const { values: args } = parseArgs({ options: { local: { type: "string" } } });
const local = args.local ?? "Noto Sans CJK TC";
const web = resolve(import.meta.dirname, "../..");
const asBuilt = join(web, ".visual", "font", "build");
const apple = join(web, ".visual", "font", "apple");
await buildTree(web, asBuilt, true);
cpSync(asBuilt, apple, { recursive: true });
for (const f of readdirSync(join(apple, "assets")).filter((f) => f.endsWith(".css"))) {
  const path = join(apple, "assets", f);
  const css = readFileSync(path, "utf8");
  if (!css.includes("PingFang TC")) throw new Error(`no "PingFang TC" in ${f}`);
  writeFileSync(path, css.replaceAll("PingFang TC", local));
}

const scene = (start: string) => {
  const n = SCENES.findIndex((s) => s.name.startsWith(start)) + 1;
  if (n === 0) throw new Error(`no scene "${start}"`);
  return n;
};
const PAGES = [
  { name: "空狀態（首頁）", scene: scene("空狀態") },
  { name: "對話", scene: scene("對話進行中") },
  { name: "知識庫", scene: scene("知識庫的一頁") },
  { name: "核准卡", scene: scene("核准卡：等待中") },
];
const WIDTHS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

/** The first element whose own text has Chinese, marked so CDP can find it. */
const MARK = () => {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n !== null; n = walk.nextNode())
    if (/[一-鿿]{4}/.test(n.textContent ?? "") && n.parentElement !== null) {
      n.parentElement.setAttribute("data-font-probe", "");
      return n.textContent?.trim().slice(0, 12) ?? "";
    }
  return "";
};
/** The layout shifts since a time, summed. */
const SHIFT = (since: number) =>
  new Promise<number>((ok) => {
    let sum = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (e.startTime >= since) sum += (e as unknown as { value: number }).value;
    }).observe({ type: "layout-shift", buffered: true });
    setTimeout(() => ok(sum), 50);
  });
/** Each visible text block's box, by its place in the page. */
const BOXES = () =>
  [...document.querySelectorAll<HTMLElement>("body *")]
    .filter((e) =>
      [...e.childNodes].some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? "")),
    )
    .map((e) => e.getBoundingClientRect())
    .filter((b) => b.width > 0 && b.height > 0)
    .map((b) => [b.x, b.y, b.width, b.height].map(Math.round));

interface Row {
  tree: string;
  width: string;
  page: string;
  requests: number;
  bytes: number;
  loaded: number;
  drawn: string;
  shift: number;
  moved: string;
  violations: number;
}

async function measure(browser: Browser, tree: string, dir: string): Promise<Row[]> {
  const { url, server } = await serve(dir);
  const { isProbe } = zodProbe(dir, url);
  const rows: Row[] = [];
  for (const w of WIDTHS)
    for (const p of PAGES) {
      const context = await browser.newContext({
        viewport: w.viewport,
        isMobile: w.isMobile,
        hasTouch: w.hasTouch,
        reducedMotion: "reduce",
        locale: "zh-TW",
        timezoneId: "Asia/Taipei",
      });
      const page = await context.newPage();
      await page.addInitScript(COLLECT);
      await page.clock.setFixedTime(NOW);
      const woff2: { url: string; bytes: number }[] = [];
      let release = () => {};
      const held = new Promise<void>((ok) => (release = ok));
      await page.route("**/*.woff2", async (r) => {
        await held;
        await r.continue();
      });
      page.on("response", async (r) => {
        if (r.url().endsWith(".woff2"))
          woff2.push({ url: r.url(), bytes: (await r.body()).length });
      });
      await page.goto(`${url}/?scene=${p.scene}`, { waitUntil: "load" });
      await page.waitForTimeout(400);
      // The scene's steps, as zoom.ts takes them: the knowledge base's page is a click away.
      const s = SCENES[p.scene - 1];
      for (const step of (w.isMobile ? s?.phone : undefined) ?? s?.steps ?? []) {
        if ("click" in step) await page.locator(step.click).first().click({ timeout: 5_000 });
        else if ("fill" in step) await page.locator(step.fill).first().fill(step.text);
        else if ("wait" in step) await page.waitForTimeout(step.wait);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(600);
      const before = await page.evaluate(BOXES);
      const early = await page.evaluate(
        () => [...document.fonts].filter((f) => f.status === "loaded").length,
      );
      const since = await page.evaluate(() => performance.now());
      release();
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      const text = await page.evaluate(MARK);
      const cdp = await context.newCDPSession(page);
      const { root } = (await cdp.send("DOM.getDocument")) as { root: { nodeId: number } };
      const { nodeId } = (await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "[data-font-probe]",
      })) as { nodeId: number };
      const { fonts } = (await cdp
        .send("CSS.enable")
        .then(() => cdp.send("CSS.getPlatformFontsForNode", { nodeId }))) as {
        fonts: { familyName: string; isCustomFont: boolean; glyphCount: number }[];
      };
      const loaded = await page.evaluate(
        () => [...document.fonts].filter((f) => f.status === "loaded").length,
      );
      const shift = await page.evaluate(SHIFT, since);
      const after = await page.evaluate(BOXES);
      const changed = after.filter((b, i) => before[i]?.join() !== b.join());
      const dh = after.reduce(
        (n, b, i) => Math.max(n, Math.abs(b[3] - (before[i]?.[3] ?? b[3]))),
        0,
      );
      const dw = after.reduce(
        (n, b, i) => Math.max(n, Math.abs(b[2] - (before[i]?.[2] ?? b[2]))),
        0,
      );
      const seen = (await page.evaluate(
        () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
      )) as Violation[];
      rows.push({
        tree,
        width: w.name,
        page: p.name,
        requests: woff2.length,
        bytes: woff2.reduce((n, f) => n + f.bytes, 0),
        loaded,
        drawn: `${text} → ${fonts.map((f) => `${f.familyName}${f.isCustomFont ? " (web)" : ""} ×${f.glyphCount}`).join(", ")}`,
        shift: Math.round(shift * 10_000) / 10_000,
        moved: `${changed.length}/${after.length} boxes${before.length === after.length ? "" : ` (${before.length} before)`}, max Δw ${dw}px Δh ${dh}px, ${early} faces loaded while held`,
        violations: seen.filter((v) => !isProbe(v)).length,
      });
      await context.close();
    }
  server.close();
  return rows;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});
const rows = [
  ...(await measure(browser, "as built", asBuilt)),
  ...(await measure(browser, `PingFang → ${local}`, apple)),
];
await browser.close();
for (const r of rows)
  console.log(
    `${r.tree} | ${r.width} | ${r.page} | woff2 ${r.requests}, ${r.bytes} B | faces loaded ${r.loaded} | swap shift ${r.shift}, ${r.moved} | CSP ${r.violations} | ${r.drawn}`,
  );
const bad = rows.filter(
  (r) =>
    r.violations > 0 ||
    (r.tree === "as built" ? !/Noto Sans TC[^,]*\(web\)/.test(r.drawn) : r.requests > 0),
);
if (bad.length > 0) {
  console.log(`failed:\n- ${bad.map((r) => `${r.tree} ${r.width} ${r.page}`).join("\n- ")}`);
  process.exit(1);
}
console.log(
  "as built: Chinese in the served Noto Sans TC; the stand-in fetched no font; CSP clean",
);
