// What run.ts, csp.ts and pull.ts share: a tree's build, with or without the scene page, served
// with the app's CSP; the listener that turns a CSP violation into a console line; and the
// violations as data, less zod's eval probe.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import react from "@vitejs/plugin-react";
import type { Page } from "playwright-core";
import { build, type Plugin } from "vite-plus";
import { headersFile } from "../../headers.ts";

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
export async function buildTree(root: string, dir: string, scenesToo: boolean) {
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
export async function serve(dir: string): Promise<{ url: string; server: Server }> {
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
export function watch(page: Page, problems: string[]) {
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
}
export const CSP_LISTENER = () =>
  document.addEventListener("securitypolicyviolation", (e) =>
    console.error(
      `Refused to load: ${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
    ),
  );

export interface Violation {
  directive: string;
  blocked: string;
  source: string;
  line: number;
  column: number;
}

/** Every violation the page raises, as data (globalThis.cspSeen): read back before it closes. */
export const COLLECT = () => {
  const seen: unknown[] = [];
  (globalThis as { cspSeen?: unknown[] }).cspSeen = seen;
  document.addEventListener("securitypolicyviolation", (e) =>
    seen.push({
      directive: e.effectiveDirective,
      blocked: e.blockedURI,
      source: e.sourceFile,
      line: e.lineNumber,
      column: e.columnNumber,
    }),
  );
};

/**
 * zod 4's eval probe (zod/v4/core/util.js allowsEval, 4.6.7): `try { return Function(""), true }`
 * in the first-load entry, once per load (cached). A violation is it only when it is script-src
 * refusing eval, raised in the entry chunk, on that code. Anything else counts, eval or not.
 */
const PROBE_CODE = "try{return Function(``),!0}catch{return!1}";
export function zodProbe(dir: string, url: string) {
  const entry = /<script type="module"[^>]*src="(\/assets\/index-[\w-]+\.js)"/.exec(
    readFileSync(join(dir, "index.html"), "utf8"),
  )?.[1];
  if (entry === undefined) throw new Error("no entry script in index.html");
  const code = readFileSync(join(dir, entry), "utf8");
  const at = code.indexOf(PROBE_CODE);
  if (at < 0 || code.indexOf(PROBE_CODE, at + 1) >= 0)
    throw new Error(`zod's probe is not once in ${entry}: update PROBE_CODE`);
  const line = code.slice(0, at).split("\n").length;
  const column = at - code.lastIndexOf("\n", at - 1);
  const isProbe = (v: Violation) =>
    v.directive === "script-src" &&
    v.blocked === "eval" &&
    new URL(v.source, url).pathname === entry &&
    v.line === line &&
    v.column >= column &&
    v.column < column + PROBE_CODE.length;
  return { isProbe };
}
