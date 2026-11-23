import type { Plugin } from "vite-plus";

/** A host name and nothing else: no scheme, port, path or template placeholder. */
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Cloudflare's _headers for every asset. connect-src names the host, which is not in the repo,
 * so the file is made at build time. 'self' and wss://<APP_HOST> both: whether 'self' covers a
 * same-host wss:// on mobile Safari is unverified (P1 (i)).
 */
export function headersFile(appHost: string | undefined): string {
  if (appHost === undefined || !HOST.test(appHost))
    throw new Error("APP_HOST must be the page's host name (app.<OWNER_DOMAIN>) to build the CSP");
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' wss://${appHost}`,
    "img-src 'self' data:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `/*\n  Content-Security-Policy: ${csp}\n`;
}

/** Writes _headers next to the page's assets; a build without APP_HOST fails. */
export const headersPlugin = (appHost: string | undefined): Plugin => ({
  name: "tars-headers",
  apply: "build",
  applyToEnvironment: (env) => env.name === "client",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(appHost) });
  },
});
