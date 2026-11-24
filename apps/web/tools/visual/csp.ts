// The app's CSP while the ledger form's account combobox is used (M4-P1; the design's
// csp-test, cut down to this). Chromium opens the form scene at both widths, types Chinese and
// English into the two account fields, picks, fills the rest and sends. It fails on any CSP
// violation or page error, or when ui.submit does not carry the English account names.
// Then every overlay, at both widths (M4-P2): opened by Enter and by Space, the focus inside,
// Tab kept inside a modal one, Esc and a press outside close it, the focus back on its button;
// on a phone a bottom drawer, the page behind not scrolling, and fields at 16px. jsdom cannot
// check these: it moves no focus on Tab and lays nothing out.
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
const WIDTHS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};
for (const [width, options] of Object.entries(WIDTHS)) {
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

/** A scene's number by its name's start. */
const sceneOf = (name: string) => {
  const n = SCENES.findIndex((s) => s.name.startsWith(name)) + 1;
  if (n === 0) throw new Error(`no scene ${name} in scenes.ts`);
  return n;
};
const drawer = '[aria-label="展開對話列表"]';
const conv = (title: string) => `.conv-list >> text=${title}`;
interface Overlay {
  name: string;
  scene: number;
  /** Clicks before the button, at each width. */
  before: Record<keyof typeof WIDTHS, string[]>;
  button: Partial<Record<keyof typeof WIDTHS, string>>;
  /** The popup's data-slot at each width; left out, the overlay is not there at that width. */
  slot: Partial<Record<keyof typeof WIDTHS, string>>;
  /** A menu: Tab leaves it and closes it, as the WAI-ARIA menu pattern has it. */
  menu?: boolean;
  /** On a phone, opened from another overlay, which closes: no button to give the focus back to. */
  from?: string;
}
const STATUS_PHONE = '[aria-label="開啟系統狀態與花費面板"]';
/** A phone opens the context sheet from the status sheet; the thread's hint has one too. */
const STATUS_COMPACT = '.sheet-foot button:has-text("開啟壓縮")';
const OVERLAYS: Overlay[] = [
  {
    name: "status sheet",
    scene: sceneOf("花費"),
    before: { desktop: [], phone: [] },
    button: {
      desktop: "header .sg-btn.desktop-only",
      phone: STATUS_PHONE,
    },
    slot: { desktop: "dialog-content", phone: "drawer-popup" },
  },
  {
    name: "context sheet",
    scene: sceneOf("壓縮"),
    before: {
      desktop: [conv("SQLite FTS5 的中文斷詞")],
      phone: [drawer, conv("SQLite FTS5 的中文斷詞")],
    },
    button: { desktop: '[aria-label="上下文用量與壓縮"]', phone: STATUS_COMPACT },
    slot: { desktop: "popover-content", phone: "drawer-popup" },
    from: STATUS_PHONE,
  },
  {
    name: "model menu and sheet",
    scene: sceneOf("新對話與模型選單"),
    before: { desktop: ['button:has-text("新對話")'], phone: [] },
    button: { desktop: '.run-seg:has-text("模型")', phone: '.run-seg:has-text("模型")' },
    slot: { desktop: "dropdown-menu-content", phone: "drawer-popup" },
    menu: true,
  },
  {
    name: "effort menu and sheet",
    scene: sceneOf("推理強度選單"),
    before: { desktop: [conv("整理 NAS 備份腳本")], phone: [drawer, conv("整理 NAS 備份腳本")] },
    button: { desktop: '.run-seg:has-text("推理")', phone: '.run-seg:has-text("推理")' },
    slot: { desktop: "dropdown-menu-content", phone: "drawer-popup" },
    menu: true,
  },
  {
    name: "model sheet to continue",
    scene: sceneOf("以另一個模型接續的提示"),
    before: { desktop: [conv("上個月的帳單")], phone: [drawer, conv("上個月的帳單")] },
    button: {
      desktop: 'button:has-text("以另一個模型接續")',
      phone: 'button:has-text("以另一個模型接續")',
    },
    slot: { desktop: "popover-content", phone: "drawer-popup" },
  },
  {
    name: "conversation drawer",
    scene: sceneOf("對話列表"),
    before: { desktop: [], phone: [] },
    button: { phone: drawer },
    slot: { phone: "sheet-content" },
  },
  {
    name: "wiki source",
    scene: sceneOf("知識庫的一頁"),
    before: {
      desktop: ['button:has-text("個人知識庫")'],
      phone: ['button:has-text("個人知識庫")'],
    },
    button: { desktop: ".wiki-cite-pill", phone: ".wiki-cite-pill" },
    slot: { desktop: "dialog-content", phone: "drawer-popup" },
  },
];

/** What the page says of its focus, its scroll and the open popup's fields. */
const look = (page: Page, slot: string) =>
  page.evaluate((slot) => {
    // Open and not closing: the drawer of conversations stays in the page closed.
    const open = [...document.querySelectorAll(`[data-slot="${slot}"]`)].filter(
      (e) => e.hasAttribute("data-open") && !e.hasAttribute("data-ending-style"),
    );
    const a = document.activeElement;
    return {
      open: open.length,
      inside: open[0]?.contains(a) ?? false,
      focused: `${a?.tagName ?? ""}.${a?.className ?? ""}[${a?.getAttribute("aria-label") ?? ""}]${a?.textContent?.slice(0, 20) ?? ""}`,
      fields: [...(open[0]?.querySelectorAll("input, textarea, select") ?? [])].map((e) =>
        Number.parseFloat(getComputedStyle(e).fontSize),
      ),
      box: open[0]?.getBoundingClientRect().toJSON() as
        | { left: number; top: number; right: number; bottom: number }
        | undefined,
    };
  }, slot);

/** Opens the overlay from its button by a key; the button, to check the focus comes back. */
async function open(page: Page, o: Overlay, width: keyof typeof WIDTHS, key: string) {
  if (o.from !== undefined && width === "phone") {
    await page.locator(o.from).first().click();
    await page.waitForTimeout(400);
  }
  const button = page.locator(`${o.button[width] as string} >> visible=true`).first();
  await button.focus();
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
  return button;
}

const back = (o: Overlay, width: string, button: ReturnType<Page["locator"]>) =>
  (o.from !== undefined && width === "phone") ||
  button.evaluate((b) => b === document.activeElement);

/** The scroll of every element that scrolls, outside the popup. */
const scrolls = (page: Page, slot: string) =>
  page.evaluate(
    (slot) =>
      [...document.querySelectorAll("*")]
        .filter(
          (e) =>
            e.closest(`[data-slot="${slot}"]`) === null &&
            e.scrollHeight > e.clientHeight + 1 &&
            ["auto", "scroll"].includes(getComputedStyle(e).overflowY),
        )
        .map((e) => `${e.className}:${e.scrollTop}`)
        .join(" "),
    slot,
  );

/** A wheel at a point; whether any scroll outside the popup moved. */
async function wheel(page: Page, slot: string, x: number, y: number) {
  const before = await scrolls(page, slot);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  return (await scrolls(page, slot)) !== before;
}

/** Whether the page's own markup is what a finger at the point would touch. */
const exposed = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => document.getElementById("root")?.contains(document.elementFromPoint(x, y)) ?? false,
    [x, y] as const,
  );

for (const [width, options] of Object.entries(WIDTHS) as [keyof typeof WIDTHS, object][]) {
  const context = await browser.newContext({ ...options, locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  for (const o of OVERLAYS) {
    const slot = o.slot[width];
    if (slot === undefined) continue;
    const at = `${width} ${o.name}`;
    const fail = (t: string) => failures.push(`${at}: ${t}`);
    const page = await context.newPage();
    page.on("pageerror", (e) => fail(`page error: ${e.message}`));
    try {
      await page.clock.setFixedTime(NOW);
      await page.goto(`${url}/?scene=${o.scene}`, { waitUntil: "load" });
      await page.waitForTimeout(400);
      for (const c of o.before[width]) {
        await page.locator(c).first().click({ timeout: 5_000 });
        await page.waitForTimeout(300);
      }
      let button = await open(page, o, width, "Enter");
      let seen = await look(page, slot);
      if (seen.open !== 1) throw new Error(`Enter opened ${seen.open} ${slot}`);
      if (!seen.inside) fail("the focus is not inside on open");
      if (width === "phone") for (const px of seen.fields) if (px < 16) fail(`a field at ${px}px`);
      if (width === "phone" && slot === "drawer-popup") {
        const box = seen.box;
        if (box === undefined || Math.abs(box.bottom - 844) > 1 || box.left > 1 || box.right < 389)
          fail(`not a bottom drawer: ${JSON.stringify(box)}`);
      }
      if (o.menu !== true) {
        for (let i = 0; i < 12; i += 1)
          await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
        await page.waitForTimeout(100);
        const after = await look(page, slot);
        if (!after.inside) fail(`Tab took the focus out, to ${after.focused}`);
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      if ((await look(page, slot)).open !== 0) fail("Esc did not close it");
      if (!(await back(o, width, button))) fail("the focus did not come back after Esc");
      button = await open(page, o, width, " ");
      seen = await look(page, slot);
      if (seen.open !== 1) throw new Error(`Space opened ${seen.open} ${slot}`);
      // A point on the page outside the popup: its right edge, its left, or its top.
      const { width: w, height: h } = WIDTHS[width].viewport;
      const b = seen.box ?? { left: 0, top: 0, right: 0, bottom: 0 };
      const point = [
        [w - 6, h / 2],
        [6, h / 2],
        [w / 2, 6],
      ].find(([x, y]) => !((x as number) >= b.left && x <= b.right && y >= b.top && y <= b.bottom));
      if (point === undefined) throw new Error("the popup covers the page");
      const [x, y] = point as [number, number];
      // The scenes' threads are too short to scroll, so the wheel alone shows little: what lies
      // under the point must be the overlay's backdrop, which takes the touch a scroll starts with.
      if (await exposed(page, x, y)) fail("the page behind takes a press");
      if (await wheel(page, slot, x, y)) fail("the page behind scrolled");
      await page.mouse.click(point[0] as number, point[1] as number);
      await page.waitForTimeout(500);
      if ((await look(page, slot)).open !== 0) fail("a press outside did not close it");

      if (!(await back(o, width, button)))
        fail("the focus did not come back after a press outside");
    } catch (e) {
      fail((e as Error).message.split("\n")[0] as string);
      await page.screenshot({ path: join(dir, `${at}.png`) });
    }
    const seen = (await page.evaluate(
      () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
    )) as Violation[];
    failures.push(...seen.filter((v) => !isProbe(v)).map((v) => `${at}: CSP ${JSON.stringify(v)}`));
    await page.close();
  }
  console.log(`${width}: overlays done`);

  await context.close();
}

// An overlay open while the window crosses 768 px: the panel goes from Dialog or Popover to a
// Drawer and back. Each time one popup is open with the focus inside; after Esc nothing is left
// aria-hidden or inert that was not before, and the page takes a press.
for (const o of OVERLAYS.filter(
  (x) => x.slot.desktop !== undefined && x.slot.phone !== undefined,
)) {
  if (o.menu === true) continue;
  const context = await browser.newContext({ ...WIDTHS.desktop, locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  const fail = (t: string) => failures.push(`resized ${o.name}: ${t}`);
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  /** Every element marked aria-hidden or inert, by its place in the page. */
  const marks = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[aria-hidden=true], [inert]")]
        .map((e) => {
          const at: number[] = [];
          for (let n: Element | null = e; n?.parentElement; n = n.parentElement)
            at.unshift([...n.parentElement.children].indexOf(n));
          return at.join(".");
        })
        .join(" "),
    );
  const open = async (slot: string) =>
    page.evaluate((slot) => {
      const p = [...document.querySelectorAll(`[data-slot="${slot}"][data-open]`)];
      return { n: p.length, inside: p[0]?.contains(document.activeElement) ?? false };
    }, slot);
  try {
    await page.clock.setFixedTime(NOW);
    await page.goto(`${url}/?scene=${o.scene}`, { waitUntil: "load" });
    await page.waitForTimeout(400);
    for (const c of o.before.desktop) {
      await page.locator(c).first().click({ timeout: 5_000 });
      await page.waitForTimeout(300);
    }
    const before = await marks();
    await page
      .locator(`${o.button.desktop as string} >> visible=true`)
      .first()
      .click();
    await page.waitForTimeout(400);
    for (const [width, slot] of [
      ["phone", o.slot.phone],
      ["desktop", o.slot.desktop],
    ] as const) {
      await page.setViewportSize(WIDTHS[width].viewport);
      await page.waitForTimeout(600);
      const seen = await open(slot as string);
      if (seen.n !== 1) fail(`at ${width} width ${seen.n} ${slot} open`);
      if (!seen.inside) fail(`at ${width} width the focus is not inside`);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    if ((await marks()) !== before) fail("aria-hidden or inert left after closing");
    await page.locator('button:has-text("新對話")').first().click({ timeout: 3_000 });
  } catch (e) {
    fail((e as Error).message.split("\n")[0] as string);
  }
  await context.close();
}

// An approval that comes while the status sheet is open, at both widths. ApprovalCard gives its
// deny the focus behind the overlay, as before P2; the announcement and that button must stay
// readable: nothing above them aria-hidden or inert, and both in Chromium's accessibility tree.
for (const [width, options] of Object.entries(WIDTHS) as [keyof typeof WIDTHS, object][]) {
  const context = await browser.newContext({ ...options, locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  const fail = (t: string) => failures.push(`${width} approval under an overlay: ${t}`);
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  try {
    await page.clock.setFixedTime(NOW);
    await page.goto(`${url}/?scene=1`, { waitUntil: "load" });
    await page.waitForTimeout(400);
    if (width === "phone") await page.locator(drawer).click();
    await page.locator(conv("整理 NAS 備份腳本")).first().click();
    await page.waitForTimeout(300);
    await page
      .locator(width === "phone" ? STATUS_PHONE : "header .sg-btn.desktop-only")
      .first()
      .click();
    await page.waitForTimeout(400);
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
    const seen = await page.evaluate(() => {
      const hidden = (e: Element | null) => {
        for (; e !== null; e = e.parentElement)
          if (e.getAttribute("aria-hidden") === "true" || e.hasAttribute("inert")) return true;
        return false;
      };
      const alert = document.querySelector('[role="alert"][aria-live="assertive"]');
      const a = document.activeElement;
      return {
        text: alert?.textContent ?? "",
        alertHidden: hidden(alert),
        deny: a?.matches(".approval-card .sg-btn-danger") ?? false,
        denyHidden: hidden(a),
      };
    });
    if (!seen.text.includes("需要核准")) fail(`announced ${JSON.stringify(seen.text)}`);
    if (seen.alertHidden) fail("the announcement is under aria-hidden or inert");
    if (!seen.deny) fail("the deny button does not have the focus");
    if (seen.denyHidden) fail("the focused deny is under aria-hidden or inert");
    const cdp = await context.newCDPSession(page);
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: { ignored: boolean; role?: { value: string }; name?: { value: unknown } }[];
    };
    const read = nodes.filter((n) => !n.ignored).map((n) => [n.role?.value, String(n.name?.value)]);
    if (!read.some(([, name]) => name?.includes("需要核准")))
      fail("the announcement is not in the accessibility tree");
    if (!read.some(([role, name]) => role === "button" && name?.startsWith("拒絕")))
      fail("the deny button is not in the accessibility tree");
  } catch (e) {
    fail((e as Error).message.split("\n")[0] as string);
  }
  const seen = (await page.evaluate(
    () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
  )) as Violation[];
  failures.push(
    ...seen.filter((v) => !isProbe(v)).map((v) => `${width} approval: CSP ${JSON.stringify(v)}`),
  );
  await context.close();
}

// The menu button's tooltip, on a desktop with the column folded: shown on a keyboard focus,
// gone on Esc. A phone shows it on no touch.
{
  const context = await browser.newContext({ ...WIDTHS.desktop, locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  const fail = (t: string) => failures.push(`desktop tooltip: ${t}`);
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  try {
    await page.clock.setFixedTime(NOW);
    await page.goto(`${url}/?scene=${sceneOf("對話列表")}`, { waitUntil: "load" });
    await page.waitForTimeout(400);
    await page.locator('[aria-label="收合側邊欄"]').click();
    await page.locator(drawer).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(1_000);
    const tip = page.locator('[data-slot="tooltip-content"]');
    if ((await tip.textContent()) !== "展開對話列表") fail("not shown on a keyboard focus");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    if ((await tip.count()) !== 0) fail("Esc left it shown");
  } catch (e) {
    fail((e as Error).message.split("\n")[0] as string);
  }
  const seen = (await page.evaluate(
    () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
  )) as Violation[];
  failures.push(
    ...seen.filter((v) => !isProbe(v)).map((v) => `desktop tooltip: CSP ${JSON.stringify(v)}`),
  );
  await context.close();
}

await browser.close();
server.close();
console.log(
  failures.length === 0 ? "no CSP violation, page error or wrong value" : failures.join("\n"),
);
process.exitCode = failures.length === 0 ? 0 : 1;
