// The approval card in Chromium (M4-P4), at desktop width with a mouse and keyboard and at phone
// width with touch. What a script runs on is decided here; each check counts the decisions the
// page sent the local end (approval.decide), not what the card shows.
//   the card that comes has the focus on deny, never on approve; Tab goes deny, then approve;
//   an approve button that is off (a decision on its way; offline) sends nothing to a mouse
//   click, a tap, or the focus and Enter or Space, nor to a click dispatched from script;
//   writing outside: the approve button says 確認核准寫外部 in the warning colour, the effect
//   says （高風險）, any host (*) is a warning tag;
//   a phone, the card taller than the screen: deny and approve both scroll into reach, and a
//   tap on deny sends one denial;
//   approved, denied, expired, cancelled: the card has no button left.
// It fails on any CSP violation or page error (zod's eval probe left out, as csp.ts).
//   node tools/visual/approval.ts
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/approval/.
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { conv, drawer, sceneOf, WIDTHS } from "./overlays.ts";
import { buildTree, COLLECT, serve, type Violation, zodProbe } from "./page.ts";
import { NOW } from "./scenes.ts";

const web = resolve(import.meta.dirname, "../..");
const dir = join(web, ".visual", "approval");
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

type Width = keyof typeof WIDTHS;
const CARD = ".thread-scroll .approval-card";
const DENY = `${CARD} .approval-actions button:nth-child(1)`;
const APPROVE = `${CARD} .approval-actions button:nth-child(2)`;

/** Scene 3: the backup conversation, its turn waiting on the external-write card. */
async function opened(width: Width) {
  const context = await browser.newContext({ ...WIDTHS[width], locale: "zh-TW" });
  await context.addInitScript(COLLECT);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => failures.push(`${width}: page error: ${e.message}`));
  await page.clock.setFixedTime(NOW);
  await page.goto(`${url}/?scene=${sceneOf("核准卡：等待中")}`, { waitUntil: "load" });
  if (width === "phone") await page.locator(drawer).click();
  await page.locator(conv("整理 NAS 備份腳本")).first().click();
  await page.locator(CARD).waitFor();
  await page.waitForTimeout(300);
  return { context, page };
}

const decisions = (page: Page) =>
  page.evaluate(() =>
    (
      (
        globalThis as {
          visualSent?: { kind: string; p: { decision?: string; approvalId?: string } }[];
        }
      ).visualSent ?? []
    )
      .filter((m) => m.kind === "approval.decide")
      .map((m) => `${m.p.decision}${m.p.approvalId === "ap-c-backup" ? "" : `@${m.p.approvalId}`}`),
  ) as Promise<string[]>;

const push = (page: Page, m: unknown) =>
  page.evaluate((x) => (globalThis as { visualPush?: (m: unknown) => void }).visualPush?.(x), m);

async function violations(page: Page, where: string) {
  const seen = (await page.evaluate(
    () => (globalThis as { cspSeen?: unknown[] }).cspSeen ?? [],
  )) as Violation[];
  for (const v of seen.filter((v) => !isProbe(v)))
    failures.push(`${where}: CSP ${JSON.stringify(v)}`);
}

/** The middle of `selector`, scrolled into view; and whether a press there lands on it. */
async function reach(page: Page, selector: string) {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  return page.evaluate((s) => {
    const e = document.querySelector(s);
    const r = e?.getBoundingClientRect();
    if (e === null || r === undefined) return null;
    const x = (r.left + r.right) / 2;
    const y = (r.top + r.bottom) / 2;
    const at = document.elementFromPoint(x, y);
    return {
      x,
      y,
      on: at !== null && e.contains(at),
      inside: r.top >= 0 && r.bottom <= innerHeight,
    };
  }, selector);
}

/** Every way to press an approve button that is off; the decisions sent before and after. */
async function pressOff(page: Page, width: Width, where: string, why: string) {
  // This card's decisions only: the focus moves on to the next card's deny once this one is
  // decided (App), and a key there is that card's.
  const mine = async () => (await decisions(page)).filter((d) => !d.includes("@"));
  const before = await mine();
  const off = await page
    .locator(APPROVE)
    .first()
    .evaluate((b) => ({
      disabled: (b as HTMLButtonElement).disabled,
      aria: b.getAttribute("aria-disabled"),
    }));
  const at = await reach(page, APPROVE);
  if (at !== null) {
    await page.mouse.click(at.x, at.y);
    if (width === "phone") await page.touchscreen.tap(at.x, at.y);
  }
  await page
    .locator(APPROVE)
    .first()
    .evaluate((b) => (b as HTMLButtonElement).focus());
  const holder = await page.evaluate(() => {
    const a = document.activeElement;
    if (a === null || a === document.body) return "頁面本身";
    const id = a.closest(".approval-card")?.querySelector(".approval-ids")?.textContent ?? "卡外";
    return `「${a.textContent}」（${id}）`;
  });
  for (const key of ["Enter", " "]) await page.keyboard.press(key);
  await page
    .locator(APPROVE)
    .first()
    .evaluate((b) => {
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      (b as HTMLButtonElement).click();
    });
  await page.waitForTimeout(200);
  const after = await mine();
  check(
    off.disabled &&
      off.aria === null &&
      after.length === before.length &&
      !holder.startsWith("「確認核准"),
    `${where} ${why}：核准鈕是原生 disabled（${off.disabled}，aria-disabled ${off.aria}），拿不到焦點（焦點在 ${holder}）；滑鼠${width === "phone" ? "、觸控" : ""}、Enter／Space、程式送的 click 之後，這張卡送出的決定 ${before.length} → ${after.length} 個`,
  );
}

async function focusAndLook(width: Width, where: string) {
  const { context, page } = await opened(width);
  // A card that comes now, as the local end sends it: App names it, and its deny takes the focus.
  await push(page, {
    kind: "approval.request",
    p: {
      approval: {
        approvalId: "ap-c-backup-2",
        conv: "c-backup",
        hash: "b".repeat(64),
        action: "run_script",
        script: "nas-backup",
        version: "3",
        summary: "第二張",
        effects: "external-write",
        domains: ["*"],
        secret: null,
        argv: ["--dry-run"],
        expiresAt: NOW + 4 * 60_000,
      },
    },
  });
  await page.waitForTimeout(400);
  const focused = await page.evaluate(() => {
    const a = document.activeElement;
    const card = a?.closest(".approval-card");
    const buttons = card === null || card === undefined ? [] : [...card.querySelectorAll("button")];
    return { text: a?.textContent ?? "", index: buttons.indexOf(a as HTMLButtonElement) };
  });
  check(
    focused.text === "拒絕（預設）" && focused.index === 0,
    `${where} 卡出現後焦點在「${focused.text}」（卡上第 ${focused.index + 1} 顆），不是核准`,
  );
  // Tab from there: approve next, then out of the card; Shift+Tab back to deny.
  const tabs: string[] = [];
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Tab");
    tabs.push(
      await page.evaluate(() => {
        const a = document.activeElement;
        return a?.closest(".approval-card") == null ? "（卡外）" : (a?.textContent ?? "");
      }),
    );
  }
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  const back = await page.evaluate(() => document.activeElement?.textContent ?? "");
  check(
    tabs[0] === "確認核准寫外部" && back === "拒絕（預設）",
    `${where} Tab 順序：拒絕 → ${tabs.join(" → ")}；Shift+Tab 兩次回到「${back}」`,
  );
  // No single key decides: the keys pressed on the page, with the focus on the card's text.
  await page.locator(`${CARD} .approval-grid`).first().click();
  for (const key of ["y", "n", "a", "d", "Enter", " "]) await page.keyboard.press(key);
  const keyed = await decisions(page);
  check(
    keyed.length === 0,
    `${where} 焦點在卡的文字上按 y n a d Enter Space：送出的決定 ${keyed.length} 個`,
  );

  // Writing outside, in the warning colour (styles.css .sg-btn-warn-action).
  const look = await page
    .locator(APPROVE)
    .first()
    .evaluate((b) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--status-warn)";
      document.body.append(probe);
      const warn = getComputedStyle(probe).color;
      probe.remove();
      const card = b.closest(".approval-card");
      const tags = [...(card?.querySelectorAll(".approval-field-val .sg-tag") ?? [])].map((t) => ({
        text: t.textContent,
        warn: t.classList.contains("warn"),
        color: getComputedStyle(t).color,
      }));
      return { text: b.textContent, color: getComputedStyle(b).color, warn, tags };
    });
  const effect = look.tags.find((t) => t.text?.startsWith("寫外部"));
  const any = look.tags.find((t) => t.text === "任意主機（*）");
  check(
    look.text === "確認核准寫外部" &&
      look.color === look.warn &&
      effect?.text === "寫外部（高風險）" &&
      effect.warn &&
      any?.warn === true,
    `${where} 寫外部：核准鈕「${look.text}」顏色 ${look.color}（警告色 ${look.warn}），影響「${effect?.text}」warn ${effect?.warn}，任意主機 warn ${any?.warn}`,
  );
  await page.screenshot({ path: join(dir, `${width}-card.png`), fullPage: false });

  // Deny and approve, on a phone the card is taller than the screen: each scrolls into reach.
  const reachDeny = await reach(page, DENY);
  const reachApprove = await reach(page, APPROVE);
  check(
    reachDeny?.on === true && reachApprove?.on === true && reachDeny.inside && reachApprove.inside,
    `${where} 捲到拒絕與核准鈕：拒絕按得到 ${reachDeny?.on}、核准按得到 ${reachApprove?.on}`,
  );

  // Approve, then while it is on its way both are off: no press of any kind sends a second one.
  await page.locator(APPROVE).first().click();
  await page.waitForTimeout(200);
  const first = await decisions(page);
  check(
    first.length === 1 && first[0] === "approved",
    `${where} 按一次核准：送出 ${JSON.stringify(first)}`,
  );
  await pressOff(page, width, where, "決定送出中");
  await violations(page, where);
  await context.close();
}

async function offline(width: Width, where: string) {
  const { context, page } = await opened(width);
  await push(page, { kind: "relay.status", p: { online: false } });
  await page.waitForTimeout(300);
  const reason = await page.locator(`${CARD} .composer-disabled-reason`).first().textContent();
  check(reason !== null && reason !== "", `${where} 離線：卡上說明「${reason}」`);
  await pressOff(page, width, where, "離線");
  check((await decisions(page)).length === 0, `${where} 離線：整段沒有送出任何決定`);
  await violations(page, where);
  await context.close();
}

async function tapDeny(where: string) {
  const { context, page } = await opened("phone");
  const at = await reach(page, DENY);
  if (at !== null) await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(200);
  const sent = await decisions(page);
  check(
    at?.on === true && sent.length === 1 && sent[0] === "denied",
    `${where} 捲到拒絕鈕後觸控點一下：送出 ${JSON.stringify(sent)}`,
  );
  await context.close();
}

async function resolved(width: Width, where: string) {
  const { context, page } = await opened(width);
  // One at a time: the page keeps only the latest few decided elsewhere (App.test, four decided
  // elsewhere), so each card is read as its result comes.
  const seen: string[] = [];
  let ok = true;
  for (const [i, state] of (["approved", "denied", "expired", "cancelled"] as const).entries()) {
    const approvalId = `ap-done-${i}`;
    const script = `done-${state}`;
    await push(page, {
      kind: "approval.request",
      p: {
        approval: {
          approvalId,
          conv: "c-backup",
          hash: "c".repeat(64),
          action: "run_script",
          script,
          version: "1",
          summary: state,
          effects: "read-only",
          domains: [],
          secret: null,
          argv: [],
          expiresAt: NOW + 4 * 60_000,
        },
      },
    });
    // The page takes each message in its turn: the card is there before its result comes.
    await page.waitForTimeout(150);
    const card = (s: string) =>
      page.evaluate((name) => {
        const c = [...document.querySelectorAll(".approval-card")].find((e) =>
          e.querySelector(".approval-grid dd")?.textContent?.startsWith(`${name} @`),
        );
        return c === undefined
          ? null
          : {
              tag: c.querySelector(".approval-head .sg-tag")?.textContent ?? "",
              buttons: c.querySelectorAll("button").length,
            };
      }, s);
    const waiting = await card(script);
    await push(page, {
      kind: "approval.resolved",
      p: {
        approvalId,
        state,
        via: state === "expired" ? "timeout" : state === "cancelled" ? "abort" : "remote",
        ...(state === "approved" ? { source: "other_device" } : {}),
      },
    });
    await page.waitForTimeout(150);
    const done = await card(script);
    ok &&= waiting?.buttons === 2 && done?.buttons === 0;
    seen.push(`「${done?.tag}」${waiting?.buttons}→${done?.buttons} 顆鈕`);
  }
  check(ok, `${where} 四種已決定的卡（等待時 → 決定後）：${seen.join("、")}`);
  await violations(page, where);
  await context.close();
}

/** What looks() read from main's build at 36e9d74, before the cards had shadcn's Button. */
const MAIN = {
  desktop: {
    height: [40, 40],
    translate: ["none", "none", "none"],
    moved: [0, 0],
    focus: "solid 2px oklch(0.78 0.12 235 / 0.88) 2px visible=true",
    off: "oklch(0.175 0.006 250) oklch(0.73 0.007 250) opacity 1 not-allowed",
  },
  phone: {
    height: [46, 46],
    translate: ["none", "none", "none"],
    moved: [0, 0],
    focus: "solid 2px oklch(0.78 0.12 235 / 0.88) 2px visible=true",
    off: "oklch(0.175 0.006 250) oklch(0.73 0.007 250) opacity 1 not-allowed",
  },
};

/**
 * The two buttons' look, read from the page: the prototype's, as main draws them with plain
 * buttons (MAIN, read by this function from main's build). Height, no move when pressed, the
 * keyboard's focus ring, the off look; and deny before approve as the eye reads them.
 */
async function looks(width: Width, where: string) {
  const { context, page } = await opened(width);
  const read = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((b) => {
        const c = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        return {
          height: Math.round(r.height),
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          translate: c.translate,
          transform: c.transform,
          outline: `${c.outlineStyle} ${c.outlineWidth} ${c.outlineColor} ${c.outlineOffset}`,
          background: c.backgroundColor,
          color: c.color,
          opacity: c.opacity,
          cursor: c.cursor,
        };
      });
  const deny = await read(DENY);
  const approve = await read(APPROVE);
  // Pressed: held down on deny, let go elsewhere so nothing is decided.
  await page.locator(DENY).first().scrollIntoViewIfNeeded();
  const at = await reach(page, DENY);
  await page.mouse.move(at?.x ?? 0, at?.y ?? 0);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const held = await read(DENY);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  // The keyboard's focus: Tab away and back.
  await page.locator(DENY).first().focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const focused = await read(DENY);
  const visible = await page.evaluate(() => document.activeElement?.matches(":focus-visible"));
  await push(page, { kind: "relay.status", p: { online: false } });
  await page.waitForTimeout(300);
  const off = await read(APPROVE);
  await page.mouse.move(off.left + 4, off.top + 4);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const offHeld = await read(APPROVE);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  const got = {
    height: [deny.height, approve.height],
    translate: [deny.translate, held.translate, offHeld.translate],
    moved: [held.top - deny.top, offHeld.top - off.top],
    focus: `${focused.outline} visible=${visible}`,
    off: `${off.background} ${off.color} opacity ${off.opacity} ${off.cursor}`,
  };
  const want = MAIN[width];
  check(
    JSON.stringify(got) === JSON.stringify(want),
    `${where} 外觀與 main 相同：${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? "" : `，main 是 ${JSON.stringify(want)}`}`,
  );
  const sent = await decisions(page);
  check(sent.length === 0, `${where} 量外觀時沒有送出決定：${JSON.stringify(sent)}`);
  // Deny first as seen: left of approve on a desktop, above it on a phone.
  const order =
    width === "desktop"
      ? deny.right <= approve.left && Math.abs(deny.top - approve.top) < 1
      : deny.bottom <= approve.top && Math.abs(deny.left - approve.left) < 1;
  check(
    order,
    `${where} 看到的順序：拒絕 ${Math.round(deny.left)},${Math.round(deny.top)}、核准 ${Math.round(approve.left)},${Math.round(approve.top)}（${width === "desktop" ? "拒絕在左" : "拒絕在上"}）`,
  );
  await context.close();
}

for (const width of ["desktop", "phone"] as const) {
  const where = width === "desktop" ? "桌面" : "手機";
  for (const run of [looks, focusAndLook, offline, resolved]) {
    try {
      await run(width, where);
    } catch (e) {
      check(false, `${where} ${run.name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}
try {
  await tapDeny("手機");
} catch (e) {
  check(false, `手機 tapDeny: ${(e as Error).message.split("\n")[0]}`);
}
await browser.close();
server.close();
for (const r of results) console.log(`ok   ${r}`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${results.length} ok, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
