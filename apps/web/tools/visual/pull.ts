// Pull to refresh in Chromium, with real touches (CDP Input.dispatchTouchEvent: Playwright's
// touchscreen only taps). At phone width: a pull short of the threshold does nothing; past it the
// page reloads, in a conversation and on the knowledge base; a finger dragging a scrolled thread
// scrolls it both ways, as before. With each of P2's overlays open (overlays.ts), at phone width
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

const scroller = (page: Page) => page.locator("main.thread-scroll");
const scrollTop = (page: Page) => scroller(page).evaluate((el) => el.scrollTop);
const bar = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector(".pull-indicator");
    return b === null ? null : `${b.getAttribute("data-pull")} ${b.textContent}`;
  });

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
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: at(from + ((to - from) * i) / 10),
    });
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
      const r = document.querySelector("main.thread-scroll")?.getBoundingClientRect();
      if (r === undefined || r.x !== 0) return false;
      return document.elementFromPoint(r.x + 6, r.y + 40)?.closest("main.thread-scroll") != null;
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

    await violations(page, where);
    const reloaded = page.waitForEvent("load", { timeout: 5000 });
    await drag(cdp, x, top, top + 120, async () => {
      seen = String(await bar(page));
      await page.screenshot({ path: join(dir, "ready.png") });
    });
    await reloaded;
    check(
      seen === "ready 放開重新整理" && p.loads() === 2,
      `${where}：拉 120 px 放開：放開前「${seen}」，載入 ${p.loads()} 次`,
    );
    await page.waitForTimeout(300);
    await violations(page, `${where}（重新載入後）`);
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
    await drag(p.cdp, p.x, p.top, p.top + 120);
    const ok = await reloaded.then(
      () => true,
      () => false,
    );
    check(ok, `${where}：拉 120 px 放開，重新載入`);
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
              marked: document.querySelector("main.thread-scroll")?.closest("[data-base-ui-inert]")
                ?.id,
              under:
                at === null
                  ? "nothing"
                  : (at.getAttribute("data-slot") ?? (at.closest("main") ? "thread" : at.tagName)),
            };
          },
          [slot, x, y] as const,
        );
        await drag(cdp, x, y, y + 120);
        await page.waitForTimeout(1_500);
        check(
          seen.open === 1 && seen.marked === "root" && loads === 1,
          `${where}：開著（${slot}，#root 標記 ${seen.marked ?? "無"}，手指落在 ${seen.under}）拉 120 px，載入 ${loads} 次`,
        );
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
