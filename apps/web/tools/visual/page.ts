// What run.ts and csp.ts share: a tree's build, with or without the scene page, served with the
// app's CSP, and the listener that turns a CSP violation into a console line.
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
