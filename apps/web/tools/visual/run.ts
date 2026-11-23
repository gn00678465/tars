// Screenshots the scenes of ui_spec.md 7 at two widths, before (a git ref, main by default) and
// after (this tree), and counts the pixels that differ (m4_web_stack_design.md 5.2). Each page
// is served with the app's CSP. A new violation fails the run, as does a step not taken on
// either side or a scene over the threshold.
//   node tools/visual/run.ts [--base <ref>] [--only <scene>] [--control]
// --control compares the base with itself: the noise floor.
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildTree, CSP_LISTENER, serve, watch } from "./page.ts";
import { NOW, SCENES, type Step } from "./scenes.ts";

/** Over this share of differing pixels, a person looks (5.2). */
const THRESHOLD = 0.5;
/**
 * A pixel counts as different when its R, G and B differ by more than this in all: not byte for
 * byte. The same page drawn twice can land a channel a step or two apart where text and
 * translucent layers are blended; no visible change is that small. Kept from the design's tool,
 * which read 0.00% for a page against itself and 15–23% for one letter-spacing rule.
 */
const TOLERANCE = 6;
const WIDTHS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "main" },
    only: { type: "string" },
    control: { type: "boolean", default: false },
  },
});
const web = resolve(import.meta.dirname, "../..");
const repo = resolve(web, "../..");
const out = join(web, ".visual");
const scenes = SCENES.map((s, i) => ({ ...s, n: i + 1 })).filter(
  (s) => args.only === undefined || String(s.n) === args.only,
);
if (scenes.length === 0) {
  console.error(`no scene ${args.only}; scenes are 1 to ${SCENES.length}`);
  process.exit(2);
}
const short = (ref: string) =>
  execFileSync("git", ["-C", repo, "rev-parse", "--short", ref], { encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["-C", repo, "status", "--porcelain", "--", web], { encoding: "utf8" }) !==
  "";
const commits = `base ${args.base} (${short(args.base)}), head ${args.control ? "the base again (--control)" : `this tree (${short("HEAD")}${dirty ? " with uncommitted changes" : ""})`}`;

/** Takes the steps, then the screenshot; a step that fails is a problem, and the shot is taken. */
async function take(page: Page, steps: readonly Step[], problems: string[]) {
  for (const s of steps) {
    try {
      if ("click" in s) await page.locator(s.click).first().click({ timeout: 5_000 });
      else if ("fill" in s) await page.locator(s.fill).first().fill(s.text, { timeout: 5_000 });
      else await page.waitForTimeout(s.wait);
    } catch {
      problems.push(`step failed: ${JSON.stringify(s)}`);
      break;
    }
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  return page.screenshot({ animations: "disabled", caret: "hide" });
}

/** Share of pixels whose channels differ by more than 6 in all, in a page of its own. */
async function differ(browser: Browser, a: Buffer, b: Buffer): Promise<number> {
  const page = await browser.newPage();
  const share = await page.evaluate(
    async ([a, b, tolerance]) => {
      const load = async (s: string) => {
        const i = new Image();
        i.src = `data:image/png;base64,${s}`;
        await i.decode();
        const c = new OffscreenCanvas(i.width, i.height).getContext("2d");
        if (c === null) throw new Error("no canvas");
        c.drawImage(i, 0, 0);
        return c.getImageData(0, 0, i.width, i.height);
      };
      const [p, q] = [await load(a), await load(b)];
      if (p.width !== q.width || p.height !== q.height) return 100;
      let n = 0;
      for (let i = 0; i < p.data.length; i += 4) {
        const d =
          Math.abs((p.data[i] ?? 0) - (q.data[i] ?? 0)) +
          Math.abs((p.data[i + 1] ?? 0) - (q.data[i + 1] ?? 0)) +
          Math.abs((p.data[i + 2] ?? 0) - (q.data[i + 2] ?? 0));
        if (d > tolerance) n++;
      }
      return (n / (p.width * p.height)) * 100;
    },
    [a.toString("base64"), b.toString("base64"), TOLERANCE] as const,
  );
  await page.close();
  return share;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "base-src"), { recursive: true });
// The base's apps/web, under this one so it resolves this tree's node_modules.
execFileSync("sh", [
  "-c",
  `git -C "${repo}" archive "${args.base}" apps/web | tar -x -C "${join(out, "base-src")}"`,
]);
const built: Record<string, string> = { base: join(out, "base-scenes") };
await buildTree(join(out, "base-src/apps/web"), built.base as string, true);
built.head = args.control ? (built.base as string) : join(out, "head-scenes");
if (!args.control) await buildTree(web, built.head, true);
// The real page too, for the CSP: its first load without the scene page's socket.
await buildTree(web, join(out, "head-app"), false);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
});
const servers = Object.fromEntries(
  await Promise.all(Object.entries(built).map(async ([k, d]) => [k, await serve(d)] as const)),
);
const app = await serve(join(out, "head-app"));
/** What went wrong, by tree and by where; the same text with the hashes left out, to match. */
const problems: { tree: string; where: string; text: string }[] = [];
const same = (t: string) =>
  t.replace(/127\.0\.0\.1:\d+/g, "host").replace(/-[\w-]{8}\.js:\d+:\d+/g, ".js");
const rows: { scene: number; name: string; width: string; pct: number }[] = [];

for (const [width, options] of Object.entries(WIDTHS)) {
  const shots: Record<string, Buffer> = {};
  for (const [tree, { url }] of Object.entries(servers)) {
    const context = await browser.newContext({
      ...options,
      reducedMotion: "reduce",
      locale: "zh-TW",
      timezoneId: "Asia/Taipei",
    });
    await context.addInitScript(CSP_LISTENER);
    for (const s of scenes) {
      const page = await context.newPage();
      const seen: string[] = [];
      watch(page, seen);
      await page.clock.setFixedTime(NOW);
      await page.goto(`${url}/?scene=${s.n}`, { waitUntil: "load" });
      await page.waitForTimeout(400);
      const shot = await take(
        page,
        (width === "phone" ? s.phone : undefined) ?? s.steps ?? [],
        seen,
      );
      const file = join(out, "shots", tree, `${width}-${s.n}.png`);
      mkdirSync(join(out, "shots", tree), { recursive: true });
      writeFileSync(file, shot);
      shots[`${tree}/${s.n}`] = shot;
      problems.push(...seen.map((text) => ({ tree, where: `${width} scene ${s.n}`, text })));
      await page.close();
    }
    await context.close();
  }
  for (const s of scenes) {
    const a = shots[`base/${s.n}`];
    const b = shots[`head/${s.n}`];
    if (a !== undefined && b !== undefined)
      rows.push({ scene: s.n, name: s.name, width, pct: await differ(browser, a, b) });
  }
}

// The real first page under the CSP, at both widths.
for (const options of Object.values(WIDTHS)) {
  const context = await browser.newContext(options);
  await context.addInitScript(CSP_LISTENER);
  const page = await context.newPage();
  const seen: string[] = [];
  watch(page, seen);
  await page.goto(`${app.url}/`, { waitUntil: "load" });
  await page.waitForTimeout(1_000);
  problems.push(...seen.map((text) => ({ tree: "head", where: "app /", text })));
  await context.close();
}

await browser.close();
for (const { server } of [...Object.values(servers), app]) server.close();

const over = rows.filter((r) => r.pct > THRESHOLD);
// A step not taken leaves a shot of some other state, on either side: the comparison is void.
const step = (p: { text: string }) => p.text.startsWith("step failed");
const failed = problems.filter(step);
// A violation or error the base has too, on any page, is not this change's.
const others = problems.filter((p) => !step(p));
const before = new Set(others.filter((p) => p.tree === "base").map((p) => same(p.text)));
const fresh = others.filter((p) => p.tree === "head" && !before.has(same(p.text)));
const listed = (ps: typeof problems) => [
  ...new Set(ps.map((p) => `- ${p.tree} ${p.where}: ${p.text}`)),
];
const table = [
  commits,
  `threshold ${THRESHOLD}% of pixels; a pixel differs when R, G and B differ by more than ${TOLERANCE} in all (not byte for byte)`,
  "",
  "| 場景 | 寬度 | 差異 |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.scene} ${r.name} | ${r.width} | ${r.pct.toFixed(2)}% |`),
  "",
  `max ${Math.max(0, ...rows.map((r) => r.pct)).toFixed(2)}%; over the threshold: ${over.length}`,
  ...over.map((r) => `- ${r.width}-${r.scene}: .visual/shots/base/ and .visual/shots/head/`),
  `steps not taken, on either side: ${failed.length}`,
  ...listed(failed),
  `CSP violations and page errors new in head: ${fresh.length}`,
  ...listed(fresh),
  `the base has them too (not this change's): ${others.length - fresh.length}`,
  ...[...before].map((t) => `- ${t}`),
].join("\n");
writeFileSync(join(out, "report.md"), `${table}\n`);
console.log(table);
process.exitCode = over.length > 0 || failed.length > 0 || fresh.length > 0 ? 1 : 0;
