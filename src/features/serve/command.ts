import { X509Certificate } from "node:crypto";
import type { Command } from "commander";
import { rm } from "node:fs/promises";
import { TarsError } from "../../core/exit.ts";
import { resolvePaths, type Env, type TarsPaths } from "../../core/paths.ts";
import { refuseInSession } from "../agent/cli.ts";
import type { ChatContext } from "../agent/chat.ts";
import { LINK_KEYS, loadConfig, type NotifyConfig, type TarsConfig } from "../agent/config.ts";
import { acquireLock, openDb } from "../agent/db.ts";
import { createEngine, sleepAbortable } from "../agent/engine.ts";
import { createLog } from "../agent/log.ts";
import { reconcileAfterTurn } from "../agent/openrouter-key.ts";
import { loopbackUrl } from "../agent/provider.ts";
import { reconcile, reconcileSummary } from "../agent/reconcile.ts";
import * as approvals from "../agent/approvals.ts";
import { runSelf } from "../agent/tars-tool.ts";
import { loadScript, scriptsLayout } from "../script/library.ts";
import { secretName } from "../script/secret.ts";
import { wikiSpend } from "../wiki/db.ts";
import { AccessVerifier, realTimers, Registry, type Timers } from "./access.ts";
import { Dispatch, DROP } from "./dispatch.ts";
import { bunSocket, Link, type LinkInit, type LinkSocket } from "./link.ts";
import { NOTIFY_TIMEOUT_MS, Notifier } from "./notify.ts";
import { linkSend, type Hub } from "./remote-frontend.ts";
import {
  readStatus,
  STATUS_EVERY_MS,
  STATUS_FRESH_MS,
  writeStatus,
  type ServeStatus,
} from "./status-file.ts";
import { usageFigures } from "./wire.ts";

/** tars's version: the link's User-Agent and the hello a browser gets. */
export const TARS_VERSION = "0.0.1";

export const E2E_LINK_URL_VAR = "TARS_E2E_LINK_URL";
export const E2E_ACCESS_CERTS_URL_VAR = "TARS_E2E_ACCESS_CERTS_URL";

const KEYRING_RETRY_MS = 60_000;
const STOP_WAIT_MS = 5_000;

export interface ServeContext extends ChatContext {
  /** The link's socket; Bun's WebSocket unless a test gives its own. */
  connect?(url: string, init: LinkInit): LinkSocket;
  fetchJson?(url: string): Promise<unknown>;
  readonly timers?: Timers;
}

export interface LinkSettings {
  readonly url: string;
  readonly teamDomain: string;
  readonly aud: string;
  readonly ownerEmail: string;
  readonly certsUrl: string;
}

/**
 * [link] with all four values and no template placeholder left, and the two e2e overrides: each
 * through loopbackUrl, so only 127.0.0.1 is accepted, and a warning when one is in effect.
 */
export function linkSettings(
  config: TarsConfig,
  env: Env,
  warn: (w: string) => void,
): LinkSettings {
  const link = config.link ?? {};
  const bad = LINK_KEYS.filter((k) => {
    const v = link[k];
    return v === undefined || v === "" || /[<>]/.test(v);
  });
  if (bad.length > 0)
    throw new TarsError(
      `config.toml 的 [link] 還缺：${bad.join("、")}（沒寫，或還是範本的 <…>）。填好再執行 tars serve`,
    );
  const linkUrl = loopbackUrl(E2E_LINK_URL_VAR, env[E2E_LINK_URL_VAR], "ws");
  const certsBase = loopbackUrl(E2E_ACCESS_CERTS_URL_VAR, env[E2E_ACCESS_CERTS_URL_VAR], "http");
  if (linkUrl !== undefined) warn(`${E2E_LINK_URL_VAR} 生效：link 連到 ${linkUrl}`);
  if (certsBase !== undefined)
    warn(`${E2E_ACCESS_CERTS_URL_VAR} 生效：Access 的公鑰從 ${certsBase} 取`);
  const teamDomain = link.access_team_domain as string;
  return {
    url: linkUrl ?? (link.url as string),
    teamDomain,
    aud: link.access_aud as string,
    ownerEmail: link.owner_email as string,
    certsUrl: `${certsBase ?? `https://${teamDomain}`}/cdn-cgi/access/certs`,
  };
}

/** The notification is on only when its script is in the library and its key is stored. */
async function usableNotify(
  cfg: NotifyConfig | undefined,
  paths: TarsPaths,
  ctx: ServeContext,
): Promise<NotifyConfig | undefined> {
  if (cfg === undefined || cfg.script === "") return undefined;
  try {
    const script = await loadScript(scriptsLayout(paths.scripts), cfg.script);
    if (script.meta.secret !== undefined && script.meta.secret !== "") {
      const value = await ctx.secrets.get(secretName(script.meta.secret));
      if (value === null || value === "") return undefined;
    }
    return cfg;
  } catch {
    return undefined;
  }
}

async function fetchJsonDefault(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function serve(ctx: ServeContext): Promise<number> {
  refuseInSession(ctx.env);
  const paths = resolvePaths(ctx.env);
  const warn = (w: string) => ctx.io.err(`warning: ${w}`);
  const { config } = await loadConfig(paths);
  const settings = linkSettings(config, ctx.env, warn);
  const lock = await acquireLock(paths, ctx.now(), "serve");
  const db = await openDb(paths);
  const timers = ctx.timers ?? realTimers;
  const stops: (() => void)[] = [];
  try {
    const summary = reconcileSummary(reconcile(db, ctx.now()));
    if (summary !== undefined) ctx.io.err(summary);
    const log = createLog(paths.agentLog, () => ctx.now());
    const now = () => ctx.now().getTime();
    const startedAt = now();
    const engine = createEngine({
      db,
      paths,
      env: ctx.env,
      secrets: ctx.secrets,
      adapterFor: ctx.adapterFor,
      selfCommand: ctx.selfCommand,
      approveCommand: (name) => ctx.approveCommand(name),
      now: () => ctx.now(),
      sleep: sleepAbortable,
      log,
      warn,
      otherSpend: (provider, cfg, at) => wikiSpend(paths, db, provider, cfg, at),
    });
    // Undefined while the keyring has no certificate: there is nothing to connect with.
    let link: Link | undefined;
    const keyringSince = now();
    let dispatch: Dispatch | undefined;
    const registry = new Registry(timers, now, (conn) =>
      link?.send({ t: "drop", conn, code: DROP.auth }),
    );
    const notifier = new Notifier({
      config: await usableNotify(config.notify, paths, ctx),
      run: async (argv) =>
        (
          await runSelf(argv, NOTIFY_TIMEOUT_MS, {
            selfCommand: ctx.selfCommand,
            paths,
            env: ctx.env,
            signal: new AbortController().signal,
            onSpawn: () => undefined,
          })
        ).exit,
      now,
      timers,
      log,
      turnRunning: () => dispatch?.current !== undefined,
      turnMayRunTool: () =>
        dispatch?.current !== undefined && !dispatch.current.frontend.awaitingApproval,
    });
    stops.push(
      () => notifier.dispose(),
      () => registry.clear(),
    );
    const hub: Hub = {
      registry,
      timers,
      notifier,
      newId: () => crypto.randomUUID(),
      usageOf: usageFigures(db),
      send: linkSend(registry, (f) => link?.send(f)),
    };
    const verifier = new AccessVerifier(
      {
        teamDomain: settings.teamDomain,
        aud: settings.aud,
        ownerEmail: settings.ownerEmail,
        certsUrl: settings.certsUrl,
      },
      ctx.fetchJson ?? fetchJsonDefault,
      now,
    );

    let writing = Promise.resolve();
    const status = (): ServeStatus => ({
      pid: process.pid,
      startedAt,
      updatedAt: now(),
      version: TARS_VERSION,
      link:
        link === undefined
          ? { state: "keyring", since: keyringSince }
          : {
              state: link.state,
              since: link.since,
              ...(link.lastError === undefined ? {} : { lastError: link.lastError }),
              ...(link.replacedSince === undefined
                ? {}
                : {
                    replacedSince: link.replacedSince,
                    replacedNotified: notifier.replacedNotified,
                  }),
            },
      browsers: registry.size,
      pendingApprovals: approvals.listPending(db).length,
      turnRunning: dispatch?.current !== undefined,
      accessKeys: verifier.available ? "ok" : "unavailable",
      notify: notifier.configured ? "ok" : "not_configured",
    });
    let stopping = false;
    const changed = () => {
      if (stopping) return;
      writing = writing.then(() => writeStatus(paths.serveStatus, status())).catch(() => undefined);
    };

    const reconcileDeps = {
      db,
      paths,
      env: ctx.env,
      secrets: ctx.secrets,
      now: () => ctx.now(),
      warn,
      log,
    };
    // Read with the keys the link uses; the page shows it on the status bar.
    let certExpiresAt: number | undefined;
    dispatch = new Dispatch({
      db,
      paths,
      engine,
      verifier,
      hub,
      version: TARS_VERSION,
      log,
      now,
      sendFrame: (f) => link?.send(f),
      config: async () => (await loadConfig(paths)).config,
      reconcile: (provider) => reconcileAfterTurn(reconcileDeps, { provider }),
      sleep: (ms) => Bun.sleep(ms),
      changed,
      certExpiresAt: () => certExpiresAt,
      secrets: ctx.secrets,
    });

    const d = dispatch;
    const startLink = (tls: { cert: string; key: string }) => {
      certExpiresAt = expiryOf(tls.cert);
      const l = new Link({
        url: settings.url,
        // A ws:// link is e2e's fake relay on 127.0.0.1: no certificate goes to it.
        ...(settings.url.startsWith("wss://") ? { tls } : {}),
        version: TARS_VERSION,
        connect: ctx.connect ?? bunSocket,
        timers,
        now,
        random: Math.random,
        log,
        onFrame: (f) => void d.onFrame(f),
        onReset: () => d.reset(),
        onConnected: () => notifier.linkConnected(),
        onReplaced: (since) => notifier.replacedAgain(since),
        onState: changed,
      });
      link = l;
      stops.push(() => l.stop());
      l.start();
    };

    // The certificate is in the keyring too: without it there is no link to connect.
    const readKeys = async (): Promise<{ cert: string; key: string } | undefined> => {
      try {
        const [cert, key] = await Promise.all([
          ctx.secrets.get("link:cert"),
          ctx.secrets.get("link:key"),
        ]);
        return cert === null || key === null || cert === "" || key === ""
          ? undefined
          : { cert, key };
      } catch {
        return undefined;
      }
    };
    await verifier.refresh();
    const keys = await readKeys();
    if (keys !== undefined) startLink(keys);
    else {
      log.log("link", { state: "keyring" });
      const retry = (): void => {
        const handle = timers.setTimeout(async () => {
          const found = await readKeys();
          if (found === undefined) return retry();
          startLink(found);
        }, KEYRING_RETRY_MS);
        stops.push(() => timers.clearTimeout(handle));
      };
      retry();
    }
    changed();
    const beat = setInterval(changed, STATUS_EVERY_MS);
    stops.push(() => clearInterval(beat));

    await new Promise<void>((done) => {
      const stop = () => {
        ctx.signals.off("SIGINT", stop);
        ctx.signals.off("SIGTERM", stop);
        done();
      };
      ctx.signals.on("SIGINT", stop);
      ctx.signals.on("SIGTERM", stop);
    });
    await d.stop(STOP_WAIT_MS);
    // A file left behind reads as running for STATUS_FRESH_MS. Still under the lock, so it is
    // this serve's file; the stops below must not write it again.
    stopping = true;
    for (const stop of stops.splice(0).toReversed()) stop();
    await writing;
    await rm(paths.serveStatus, { force: true });
    return 0;
  } finally {
    for (const stop of stops.toReversed()) stop();
    db.close();
    lock.release();
  }
}

function statusLines(s: ServeStatus, now: number): string[] {
  const at = (t: number) => new Date(t).toISOString();
  const link = s.link;
  const head =
    link.state === "replaced"
      ? `本機端連線被另一台取代，已持續 ${Math.floor((now - (link.replacedSince ?? link.since)) / 60_000)} 分鐘；推播${link.replacedNotified === true ? "已送出" : "還沒送出"}。請到 Cloudflare 撤銷憑證`
      : `連線：${{ connecting: "連線中", connected: "已連上", keyring: "keyring 讀不到", replaced: "" }[link.state]}（${at(link.since)} 起）`;
  return [
    head,
    ...(link.lastError === undefined ? [] : [`最後一次錯誤：${link.lastError}`]),
    `瀏覽器連線：${s.browsers}`,
    `待核准：${s.pendingApprovals}`,
    `回合：${s.turnRunning ? "執行中" : "沒有"}`,
    `Access 的公鑰：${s.accessKeys === "ok" ? "拿得到" : "拿不到"}`,
    `通知：${s.notify === "ok" ? "已設定" : "未設定"}`,
  ];
}

export async function serveStatus(ctx: ServeContext, json: boolean): Promise<number> {
  refuseInSession(ctx.env);
  const paths = resolvePaths(ctx.env);
  const s = await readStatus(paths.serveStatus);
  const now = ctx.now().getTime();
  if (s === undefined || now - s.updatedAt > STATUS_FRESH_MS) {
    if (json) ctx.io.out(JSON.stringify({ running: false }));
    else ctx.io.err("tars serve 沒有在執行");
    return 1;
  }
  if (json) ctx.io.out(JSON.stringify({ running: true, ...s }));
  else for (const line of statusLines(s, now)) ctx.io.out(line);
  return s.link.state === "connected" ? 0 : 1;
}

export function registerServe(
  program: Command,
  ctx: ServeContext,
  exitWith: (code: number) => void,
): void {
  const cmd = program
    .command("serve")
    .description("Run the local end of the remote page: connect to the relay and answer browsers.")
    .addHelpText(
      "after",
      `
Runs in the foreground until SIGINT or SIGTERM, holding agent.db's lock like tars chat.
Needs [link] in config.toml and the client certificate in the keyring (tars link setup).
Refused inside a tars session.

Exit codes: 0 stopped; 1 config, lock or keyring problem; 2 usage error.

Examples:
  tars serve
  tars serve status
  tars serve status --json`,
    )
    .action(async () => exitWith(await serve(ctx)));
  cmd
    .command("status")
    .description("Show what a running tars serve is doing, from its status file.")
    .option("--json", "print the status file as JSON")
    .addHelpText(
      "after",
      "\nExit codes: 0 connected; 1 not running or not connected; 2 usage error.",
    )
    .action(async (opts: { json?: boolean }) =>
      exitWith(await serveStatus(ctx, opts.json === true)),
    );
}

/** The certificate's expiry, or undefined when it does not parse. */
function expiryOf(pem: string): number | undefined {
  try {
    const t = new Date(new X509Certificate(pem).validTo).getTime();
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}
