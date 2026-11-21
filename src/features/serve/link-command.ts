import type { Command } from "commander";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TarsError } from "../../core/exit.ts";
import { resolvePaths } from "../../core/paths.ts";
import { confirmOnTty, refuseInSession } from "../agent/cli.ts";
import { LINK_KEYS, loadConfig } from "../agent/config.ts";
import type { ServeContext } from "./command.ts";

const WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** As Cloudflare writes it in certFingerprintSHA256: lowercase hex, no colons. */
export const fingerprint = (cert: X509Certificate) =>
  cert.fingerprint256.replaceAll(":", "").toLowerCase();

const isPem = (text: string, label: RegExp) =>
  new RegExp(`-----BEGIN ${label.source}-----[\\s\\S]+-----END ${label.source}-----`).test(text);

/** Both PEM, a pair, and not expired; nothing is written otherwise. */
export function checkPair(certText: string, keyText: string, now: Date): X509Certificate {
  if (!isPem(certText, /CERTIFICATE/)) throw new TarsError("憑證檔不是 PEM 格式的憑證");
  if (!isPem(keyText, /(?:RSA |EC )?PRIVATE KEY/)) throw new TarsError("私鑰檔不是 PEM 格式的私鑰");
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certText);
  } catch {
    throw new TarsError("讀不了憑證");
  }
  let matches = false;
  try {
    matches = cert.checkPrivateKey(createPrivateKey(keyText));
  } catch {
    throw new TarsError("讀不了私鑰");
  }
  if (!matches) throw new TarsError("憑證與私鑰不是一對");
  if (new Date(cert.validTo).getTime() <= now.getTime())
    throw new TarsError(`憑證已經過期（${new Date(cert.validTo).toISOString()}）`);
  return cert;
}

/** [link]'s keys that are missing or still the template's placeholder. */
async function missingLinkKeys(ctx: ServeContext): Promise<string[]> {
  try {
    const link = (await loadConfig(resolvePaths(ctx.env))).config.link ?? {};
    return LINK_KEYS.filter((k) => {
      const v = link[k];
      return v === undefined || v === "" || /[<>]/.test(v);
    });
  } catch {
    return [...LINK_KEYS];
  }
}

/**
 * The keyring has no transaction: a new certificate next to the old key cannot connect, so a
 * key that fails to be written puts the certificate back the way it was. A known limit: setup
 * killed between the two writes, or two setups at once, can still leave a mismatched pair;
 * running setup again fixes it.
 */
async function storePair(ctx: ServeContext, cert: string, key: string): Promise<void> {
  const before = await ctx.secrets.get("link:cert");
  await ctx.secrets.set("link:cert", cert);
  try {
    await ctx.secrets.set("link:key", key);
  } catch (err) {
    try {
      if (before === null) await ctx.secrets.delete("link:cert");
      else await ctx.secrets.set("link:cert", before);
    } catch {
      throw new TarsError(
        `私鑰寫不進 keyring，憑證也還原不了：keyring 裡的 link:cert 與 link:key 可能不成對，請重新執行 tars link setup（${(err as Error).message}）`,
      );
    }
    throw new TarsError(`私鑰寫不進 keyring，憑證已還原，沒有改變：${(err as Error).message}`);
  }
}

async function setup(ctx: ServeContext, opts: { cert: string; key: string }): Promise<number> {
  refuseInSession(ctx.env);
  const [certText, keyText] = await Promise.all([
    readFile(opts.cert, "utf8").catch(() => {
      throw new TarsError(`讀不到 ${opts.cert}`);
    }),
    readFile(opts.key, "utf8").catch(() => {
      throw new TarsError(`讀不到 ${opts.key}`);
    }),
  ]);
  const cert = checkPair(certText, keyText, ctx.now());
  const ok = await confirmOnTty(ctx.openTerminal, [
    "把 link 的用戶端憑證與私鑰存進 keyring：",
    `  指紋（SHA-256）：${fingerprint(cert)}`,
    `  到期：${new Date(cert.validTo).toISOString()}`,
  ]);
  if (!ok) {
    ctx.io.err("沒有寫入");
    return 1;
  }
  await storePair(ctx, certText, keyText);
  // The dashboard made the key and the browser saved it: it is on disk, and tars does not delete it.
  ctx.io.out(`私鑰已存進 keyring。請刪除原始的私鑰檔：${opts.key}`);
  const missing = await missingLinkKeys(ctx);
  if (missing.length > 0) ctx.io.out(`config.toml 的 [link] 還缺：${missing.join("、")}`);
  return 0;
}

async function status(ctx: ServeContext): Promise<number> {
  refuseInSession(ctx.env);
  const text = await ctx.secrets.get("link:cert");
  const missing = await missingLinkKeys(ctx);
  const config = missing.length === 0 ? "[link]：齊全" : `[link] 還缺：${missing.join("、")}`;
  if (text === null || text === "") {
    ctx.io.out("keyring 裡沒有 link 的憑證。設定：tars link setup --cert <檔> --key <檔>");
    ctx.io.out(config);
    return 1;
  }
  const cert = new X509Certificate(text);
  const expires = new Date(cert.validTo);
  const days = Math.floor((expires.getTime() - ctx.now().getTime()) / DAY_MS);
  ctx.io.out(`指紋（SHA-256）：${fingerprint(cert)}`);
  ctx.io.out(`到期：${expires.toISOString()}（剩 ${days} 天）`);
  if (days < WARN_DAYS) ctx.io.err(`warning: 憑證 ${days} 天內到期，請準備新的憑證`);
  ctx.io.out(config);
  return days < 0 || missing.length > 0 ? 1 : 0;
}

export function registerLink(
  program: Command,
  ctx: ServeContext,
  exitWith: (code: number) => void,
): void {
  const cmd = program
    .command("link")
    .description("The client certificate tars serve connects to the relay with.");
  cmd
    .command("setup")
    .description("Store the client certificate and its private key in the keyring.")
    .requiredOption("--cert <file>", "the certificate, PEM")
    .requiredOption("--key <file>", "its private key, PEM")
    .addHelpText(
      "after",
      `
Checks that both are PEM, that they are a pair and that the certificate has not expired, shows
the fingerprint, and writes only after you type yes. config.toml is not changed. Refused inside
a tars session.

Exit codes: 0 stored; 1 a check failed or not confirmed; 2 usage error.

Example:
  tars link setup --cert ./client.pem --key ./client.key`,
    )
    .action(async (opts: { cert: string; key: string }) => exitWith(await setup(ctx, opts)));
  cmd
    .command("status")
    .description(
      "Show the stored certificate's fingerprint and expiry, and whether [link] is complete.",
    )
    .addHelpText(
      "after",
      "\nExit codes: 0 stored, unexpired, [link] complete; 1 otherwise; 2 usage error.",
    )
    .action(async () => exitWith(await status(ctx)));
}
