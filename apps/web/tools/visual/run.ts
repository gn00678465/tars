// Screenshots the scenes of ui_spec.md 7 at two widths, before (a git ref, main by default) and
// after (this tree), and counts the pixels that differ (m4_web_stack_design.md 5.2). Each page
// is served with the app's CSP; a violation fails the run, as does a scene over the threshold.
//   node tools/visual/run.ts [--base <ref>] [--only <scene>] [--control]
// --control compares the base with itself: the noise floor.
// Needs Chromium (CHROMIUM, default /usr/bin/chromium). Writes to .visual/.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Page } from "playwright-core";
import { build, type Plugin } from "vite-plus";
import { headersFile } from "../../headers.ts";
import { NOW, SCENES, type Step } from "./scenes.ts";

/** Over this share of differing pixels, a person looks (5.2). */
const THRESHOLD = 0.5;
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

/** The scene page's local end goes before main.tsx; the app itself is the tree's own. */
const scenePage = (): Plugin => ({
  name: "tars-visual-scenes",
  resolveId: (id) => (id === "/@visual/fake.ts" ? join(import.meta.dirname, "fake.ts") : undefined),
  // pre: before Vite bundles the page's scripts, so the two become one entry, fake.ts first.
  transformIndexHtml: {
    order: "pre",
    handler: (html) =>
      html.replace(
        /<script type="module" src="\/src\/main.tsx"><\/script>/,
        '<script type="module" src="/@visual/fake.ts"></script>$&',
      ),
  },
});

/** Builds a tree's apps/web as its vite.config.ts does, less the Cloudflare and _headers plugins. */
async function buildTree(root: string, dir: string, scenesToo: boolean) {
  const config = readFileSync(join(root, "vite.config.ts"), "utf8");
  const tailwind = config.includes("tailwindcss()")
    ? [(await import("@tailwindcss/vite")).default()]
    : [];
  process.env.NODE_ENV = "production";
  await build({
    configFile: false,
    mode: "production",
    root,
    logLevel: "warn",
    plugins: [react(), ...tailwind, ...(scenesToo ? [scenePage()] : [])],
    resolve: { alias: { "@": join(root, "src") } },
    build: { outDir: dir, emptyOutDir: true },
  });
}

const CSP = /Content-Security-Policy: (.+)/.exec(headersFile("app.example.com"))?.[1] ?? "";
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** Serves a build with the app's CSP; unknown paths get index.html, as the Worker does. */
async function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://x").pathname);
    let file = join(dir, path);
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      file = join(dir, "index.html");
      body = readFileSync(file);
    }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": CSP,
    });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const a = server.address();
  if (a === null || typeof a === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${a.port}`, server };
}

/** CSP violations and page errors, collected per page. */
function watch(page: Page, problems: string[]) {
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
}
const CSP_LISTENER = () =>
  document.addEventListener("securitypolicyviolation", (e) =>
    console.error(
      `Refused to load: ${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
    ),
  );

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
    async ([a, b]) => {
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
        if (d > 6) n++;
      }
      return (n / (p.width * p.height)) * 100;
    },
    [a.toString("base64"), b.toString("base64")] as const,
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
// A violation or error the base has too, on any page, is not this change's.
const before = new Set(problems.filter((p) => p.tree === "base").map((p) => same(p.text)));
// A step that cannot be taken is the scene's fault, whichever tree.
const fresh = problems.filter(
  (p) => p.tree === "head" && (p.text.startsWith("step failed") || !before.has(same(p.text))),
);
const listed = (ps: typeof problems) => [
  ...new Set(ps.map((p) => `- ${p.tree} ${p.where}: ${p.text}`)),
];
const table = [
  `base ${args.base}, head this tree; threshold ${THRESHOLD}%`,
  "",
  "| 場景 | 寬度 | 差異 |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.scene} ${r.name} | ${r.width} | ${r.pct.toFixed(2)}% |`),
  "",
  `max ${Math.max(0, ...rows.map((r) => r.pct)).toFixed(2)}%; over the threshold: ${over.length}`,
  ...over.map((r) => `- ${r.width}-${r.scene}: .visual/shots/base/ and .visual/shots/head/`),
  `CSP violations, page errors and failed steps new in head: ${fresh.length}`,
  ...listed(fresh),
  `the base has them too (not this change's): ${problems.length - fresh.length}`,
  ...[...before].map((t) => `- ${t}`),
].join("\n");
writeFileSync(join(out, "report.md"), `${table}\n`);
console.log(table);
process.exitCode = over.length > 0 || fresh.length > 0 ? 1 : 0;
