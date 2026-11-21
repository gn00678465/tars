import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, type Env } from "../../../src/core/paths.ts";
import { CONFIG_TEMPLATE } from "../../../src/features/agent/config.ts";
import { run } from "../../../src/main.ts";
import { fakeSecrets, scriptedTerminal, tempHome, testDeps } from "../../helpers.ts";

const openssl = Bun.which("openssl");
const DAY = 24 * 3600_000;

/** A throwaway self-signed pair, made for this test only; nothing is kept in the repo. */
function pair(days = 365) {
  const dir = tempHome();
  const cert = join(dir, "client.pem");
  const key = join(dir, "client.key");
  const made = Bun.spawnSync(
    [
      openssl as string,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      String(days),
      "-subj",
      "/CN=tars-test",
    ],
    { stderr: "pipe" },
  );
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  const fp = Bun.spawnSync([
    openssl as string,
    "x509",
    "-in",
    cert,
    "-noout",
    "-fingerprint",
    "-sha256",
  ]).stdout.toString();
  return { cert, key, fingerprint: fp.split("=")[1]!.trim().replaceAll(":", "").toLowerCase() };
}

const LINK = `
[link]
url = "wss://link.example.test/link"
access_team_domain = "team.example.test"
access_aud = "aud-0001"
owner_email = "owner@example.test"
`;

function setup(opts: { answers?: string[]; config?: string; env?: Env; now?: number } = {}) {
  const home = tempHome();
  const env: Env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "cfg"),
    TARS_DATA_DIR: join(home, "data"),
    ...opts.env,
  };
  const paths = resolvePaths(env);
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(paths.configFile, opts.config ?? `${CONFIG_TEMPLATE}${LINK}`);
  const secrets = fakeSecrets();
  const terminal = scriptedTerminal(opts.answers ?? ["yes"]);
  const now = opts.now ?? Date.now();
  const deps = testDeps({ env, secrets, openTerminal: () => terminal, now: () => new Date(now) });
  return { deps, secrets, terminal };
}

describe.skipIf(openssl === null)("tars link", () => {
  test("setup: checks the pair, shows the fingerprint, stores both after yes, says to delete the key file", async () => {
    const p = pair();
    const { deps, secrets, terminal } = setup();
    expect(await run(["link", "setup", "--cert", p.cert, "--key", p.key], deps)).toBe(0);
    expect(terminal.transcript.join("\n")).toContain(p.fingerprint);
    expect(secrets.entries.get("link:cert")).toBe(readFileSync(p.cert, "utf8"));
    expect(secrets.entries.get("link:key")).toBe(readFileSync(p.key, "utf8"));
    expect(deps.io.stdout.join("\n")).toContain(`請刪除原始的私鑰檔：${p.key}`);
    expect(deps.io.stdout.join("\n")).not.toContain("BEGIN");
  });

  test("setup: no yes, nothing stored", async () => {
    const p = pair();
    const { deps, secrets } = setup({ answers: ["no"] });
    expect(await run(["link", "setup", "--cert", p.cert, "--key", p.key], deps)).toBe(1);
    expect(secrets.entries.size).toBe(0);
  });

  test("setup: a key that is not the certificate's, swapped files, or an expired certificate are refused before asking", async () => {
    const a = pair();
    const b = pair();
    const cases: [string[], string, number?][] = [
      [["--cert", a.cert, "--key", b.key], "不是一對"],
      [["--cert", a.key, "--key", a.cert], "不是 PEM 格式的憑證"],
      [["--cert", a.cert, "--key", a.cert], "不是 PEM 格式的私鑰"],
      [["--cert", a.cert, "--key", a.key], "已經過期", Date.now() + 400 * DAY],
      [["--cert", join(tempHome(), "none.pem"), "--key", a.key], "讀不到"],
    ];
    for (const [args, words, now] of cases) {
      const { deps, secrets, terminal } = setup(now === undefined ? {} : { now });
      expect(await run(["link", "setup", ...args], deps)).toBe(1);
      expect(deps.io.stderr.join("\n")).toContain(words);
      expect(terminal.transcript).toEqual([]);
      expect(secrets.entries.size).toBe(0);
    }
  });

  test("setup names the [link] keys still missing", async () => {
    const p = pair();
    const { deps } = setup({ config: CONFIG_TEMPLATE });
    expect(await run(["link", "setup", "--cert", p.cert, "--key", p.key], deps)).toBe(0);
    expect(deps.io.stdout.join("\n")).toContain(
      "[link] 還缺：url、access_team_domain、access_aud、owner_email",
    );
  });

  test("status: fingerprint, expiry, [link]; a warning under 30 days", async () => {
    const p = pair(20);
    const { deps, secrets } = setup();
    await secrets.set("link:cert", readFileSync(p.cert, "utf8"));
    expect(await run(["link", "status"], deps)).toBe(0);
    const out = deps.io.stdout.join("\n");
    expect(out).toContain(`指紋（SHA-256）：${p.fingerprint}`);
    expect(out).toContain("[link]：齊全");
    expect(deps.io.stderr.join("\n")).toContain("天內到期");
  });

  test("status without a certificate, or with [link] incomplete: exit 1", async () => {
    const none = setup();
    expect(await run(["link", "status"], none.deps)).toBe(1);
    expect(none.deps.io.stdout.join("\n")).toContain("keyring 裡沒有 link 的憑證");
    const p = pair();
    const half = setup({
      config: `${CONFIG_TEMPLATE}\n[link]\nurl = "wss://link.<OWNER_DOMAIN>/link"\n`,
    });
    await half.secrets.set("link:cert", readFileSync(p.cert, "utf8"));
    expect(await run(["link", "status"], half.deps)).toBe(1);
    expect(half.deps.io.stdout.join("\n")).toContain("[link] 還缺：url、access_team_domain");
  });

  test("refused inside a tars session", async () => {
    const p = pair();
    const { deps } = setup({ env: { TARS_IN_SESSION: "1" } });
    expect(await run(["link", "setup", "--cert", p.cert, "--key", p.key], deps)).toBe(1);
    expect(await run(["link", "status"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain("只能在你自己的終端執行");
  });
});
