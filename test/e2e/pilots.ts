import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gcalChecks } from "./gcal.ts";
import { runDialog } from "./pty.ts";
import { finishChecks, printChecks, type Check } from "./sandbox.ts";
import { enterScriptNetns, lastJson, scriptHost } from "./script-host.ts";

const INNER = "TARS_E2E_PILOTS_INNER";
const EXAMPLES = join(import.meta.dir, "..", "..", "examples", "scripts");
const BARK_PORT = 18775;
const SITE_PORT = 18776;
const BARK = `http://127.0.0.1:${BARK_PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const KEY = "E2E-FAKE-DEVICE-KEY-0123456789";
const WRONG_KEY = "E2E-WRONG-DEVICE-KEY-9876543210";
const MIB = 1024 * 1024;
const FILE = crypto.getRandomValues(new Uint8Array(300_000));
const LIVE_SECRET = "Run it once with the real secret before deciding? [y/N] ";
const LIVE_PLAIN = "Run it once for real before deciding? [y/N] ";

interface BarkRequest {
  readonly target: string;
  readonly contentType: string;
  readonly body: Record<string, unknown>;
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Serves `chunks` MiB of zeros without a Content-Length; the stream stays open past the last one when `hang`. */
function zeros(chunks: number, hang: boolean): Response {
  let sent = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (sent < chunks) {
          sent++;
          controller.enqueue(new Uint8Array(MIB));
        } else if (hang) await Bun.sleep(60_000);
        else controller.close();
      },
    }),
  );
}

async function inner(): Promise<number> {
  const scripts = scriptHost("tars-e2e-pilots-");
  const { host, step, draft } = scripts;
  const barkSource = readFileSync(join(EXAMPLES, "bark-push", "script.py"), "utf8");
  const downloadSource = readFileSync(join(EXAMPLES, "download", "script.py"), "utf8");
  const bark: BarkRequest[] = [];
  const hits: string[] = [];
  const servers = [
    Bun.serve({
      hostname: "::",
      port: BARK_PORT,
      // Answers like Finb/bark-server's POST /push: CommonResp JSON, 400 for an unknown device key.
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        bark.push({
          target: `${req.method} ${url.pathname}${url.search}`,
          contentType: req.headers.get("content-type") ?? "",
          body,
        });
        const timestamp = Math.floor(Date.now() / 1000);
        return body.device_key === KEY
          ? Response.json({ code: 200, message: "success", timestamp })
          : Response.json(
              {
                code: 400,
                message: `failed to get device token: no device for ${String(body.device_key)}`,
                timestamp,
              },
              { status: 400 },
            );
      },
    }),
    Bun.serve({
      hostname: "::",
      port: SITE_PORT,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        hits.push(path);
        if (path === "/file.bin") return new Response(FILE);
        if (path === "/big") return zeros(101, false);
        if (path === "/slow") return zeros(1, true);
        return new Response("not found", { status: 404 });
      },
    }),
  ];
  const checks: Check[] = [];
  const check = (id: string, claim: string, pass: boolean, evidence: string) =>
    checks.push({ id, claim, pass, evidence });
  const exitOf = (stdout: string, label: string) =>
    Number(new RegExp(`^${label} (\\d+)$`, "m").exec(stdout)?.[1] ?? -1);
  const hitCount = (path: string) => hits.filter((h) => h === path).length;
  const dataDir = join(host.fakeHome, ".local/share/tars");
  const outDir = (name: string) => join(dataDir, "workspace/out", name);
  const listOut = (name: string) =>
    existsSync(outDir(name)) ? readdirSync(outDir(name)).toSorted() : [];
  try {
    const set = await step(
      "bark-secret",
      "tars secret set bark",
      {},
      JSON.stringify({ url: BARK, key: KEY }),
    );
    if (set.exitCode !== 0) throw new Error(`tars secret set bark failed: ${set.stderr}`);

    writeFileSync(join(host.fakeHome, "bark-review.md"), "BARK-REVIEW: trial without a secret\n");
    const barkGates = await step(
      "bark-gates-1-2",
      `tars script submit ${draft("bark-push", barkSource)} &&
       { tars script trial bark-push -- --title t --body b; echo "trial-exit $?"; } &&
       tars script review bark-push --report ~/bark-review.md`,
    );
    check(
      "bark-submit",
      "examples/scripts/bark-push passes gate 1 as written and ends with the approve command",
      barkGates.stdout.includes("submitted bark-push (a new script)") &&
        barkGates.stdout.includes("tars script approve bark-push") &&
        barkGates.exitCode === 0,
      `exit ${barkGates.exitCode}: ${barkGates.stdout.trim().replaceAll("\n", " | ")} ${barkGates.stderr.slice(0, 300)}`,
    );
    check(
      "bark-trial",
      "in trial bark-push gets no secret, ends with its declared 3 and no traceback, and the fake Bark hears nothing",
      exitOf(barkGates.stdout, "trial-exit") === 3 &&
        barkGates.stderr.includes("沒有金鑰") &&
        !barkGates.stderr.includes("Traceback") &&
        bark.length === 0,
      `trial-exit ${exitOf(barkGates.stdout, "trial-exit")}; ${bark.length} request(s) at the fake Bark; stderr ${barkGates.stderr.trim().slice(0, 200)}`,
    );

    const barkApprove = await runDialog(host, {
      name: "bark-approve",
      command: "tars script approve bark-push",
      tty: true,
      turns: [
        { expect: LIVE_SECRET, send: "y\n" },
        {
          expect: "Arguments as a JSON array",
          send: '["--title", "E2E title", "--body", "E2E body"]\n',
        },
        { expect: "--out directory", send: "\n" },
        { expect: "Run it again? [y/N] ", send: "n\n" },
        { expect: "Type bark-push to approve it", send: "bark-push\n" },
      ],
    });
    const live = bark[0];
    check(
      "bark-approve",
      "in a pty the user's live run of bark-push sends one push with the real device key, then the name approves it",
      barkApprove.exitCode === 0 &&
        barkApprove.missed === undefined &&
        /^approved bark-push [0-9a-f]{16}$/.test(barkApprove.stdout.trim()) &&
        barkApprove.transcript.includes('  | {"sent": true}') &&
        bark.length === 1 &&
        live?.body.device_key === KEY &&
        live.body.title === "E2E title" &&
        live.body.body === "E2E body",
      `exit ${barkApprove.exitCode}, missed ${barkApprove.missed}, stdout ${JSON.stringify(barkApprove.stdout.trim())}; fake Bark got ${JSON.stringify(bark)}; ${barkApprove.stderr.trim().slice(0, 200)}`,
    );

    const barkRun = await step(
      "bark-run",
      "tars script run bark-push -- --title '會議' --body '改到三點'",
    );
    const pushed = bark[1];
    check(
      "bark-run",
      "the approved bark-push POSTs JSON to /push with device_key, title and body, and prints its one-line JSON",
      barkRun.exitCode === 0 &&
        JSON.stringify(lastJson(barkRun.stdout)) === '{"sent":true}' &&
        bark.length === 2 &&
        pushed?.target === "POST /push" &&
        pushed.contentType.startsWith("application/json") &&
        JSON.stringify(pushed.body) ===
          JSON.stringify({ device_key: KEY, body: "改到三點", title: "會議" }),
      `exit ${barkRun.exitCode}: ${barkRun.stdout.trim()}; fake Bark got ${JSON.stringify(pushed)}; ${barkRun.stderr.slice(0, 200)}`,
    );
    const barkAll = barkApprove.transcript + barkRun.stdout + barkRun.stderr;
    check(
      "bark-quiet",
      "bark-push prints neither the device key nor the server URL, so tars has nothing to mask",
      !barkAll.includes(KEY) && !barkAll.includes("[REDACTED]") && !live?.target.includes(KEY),
      `${barkRun.stdout.trim()} | ${barkRun.stderr.trim()}`,
    );

    const rejected = await step(
      "bark-rejected",
      "tars secret set bark && tars script run bark-push -- --body x",
      {},
      JSON.stringify({ url: BARK, key: WRONG_KEY }),
    );
    check(
      "bark-rejected",
      "a device key Bark rejects with 400 ends bark-push with its declared 3, without echoing the key",
      rejected.exitCode === 3 &&
        rejected.stderr.includes("HTTP 400") &&
        bark.at(-1)?.body.device_key === WRONG_KEY &&
        !(rejected.stdout + rejected.stderr).includes("[REDACTED]"),
      `exit ${rejected.exitCode}: ${rejected.stderr.trim().slice(0, 200)}`,
    );

    const opened = await step(
      "download-open",
      `tars script submit ${draft("download", downloadSource)} &&
       for h in 127.0.0.1 localhost; do
         tars script trial download --out ~/.local/share/tars/workspace/out/open -- "http://$h:${SITE_PORT}/file.bin"; echo "$h $?"
       done`,
    );
    check(
      "download-open",
      'examples/scripts/download passes gate 1 as written, and its domains "*" cannot reach this machine',
      opened.stdout.includes("submitted download (a new script)") &&
        exitOf(opened.stdout, "127.0.0.1") === 1 &&
        exitOf(opened.stdout, "localhost") === 1 &&
        hitCount("/file.bin") === 0 &&
        listOut("open").length === 0,
      `${opened.stdout.trim().replaceAll("\n", " | ")}; site served /file.bin ${hitCount("/file.bin")} time(s); out/open holds ${JSON.stringify(listOut("open"))}; ${opened.stderr.trim().slice(0, 300)}`,
    );

    const allowed = downloadSource.replace(
      'domains = ["*"]',
      `domains = ["127.0.0.1:${SITE_PORT}"]`,
    );
    writeFileSync(join(host.fakeHome, "download-review.md"), "DOWNLOAD-REVIEW: trial saved\n");
    const dlGates = await step(
      "download-gates-1-2",
      `tars script submit ${draft("download", allowed)} &&
       { tars script trial download --out ~/.local/share/tars/workspace/out/trial -- ${SITE}/file.bin; echo "trial-exit $?"; } &&
       tars script review download --report ~/download-review.md`,
    );
    const trialSaved = join(outDir("trial"), "file.bin");
    check(
      "download-gates-1-2",
      "with the test's allow list in place of *, download passes gate 1 and its trial saves the file into --out",
      allowed !== downloadSource &&
        dlGates.exitCode === 0 &&
        exitOf(dlGates.stdout, "trial-exit") === 0 &&
        existsSync(trialSaved) &&
        sha256(readFileSync(trialSaved)) === sha256(FILE),
      `exit ${dlGates.exitCode}: ${dlGates.stdout.trim().replaceAll("\n", " | ")} ${dlGates.stderr.slice(0, 300)}`,
    );

    const dlApprove = await runDialog(host, {
      name: "download-approve",
      command: "tars script approve download",
      tty: true,
      turns: [
        { expect: LIVE_PLAIN, send: "n\n" },
        { expect: "Type download to approve it", send: "download\n" },
      ],
    });
    check(
      "download-approve",
      "in a pty the user approves download by its name",
      dlApprove.exitCode === 0 &&
        dlApprove.missed === undefined &&
        /^approved download [0-9a-f]{16}$/.test(dlApprove.stdout.trim()) &&
        dlApprove.transcript.includes("  | DOWNLOAD-REVIEW: trial saved"),
      `exit ${dlApprove.exitCode}, missed ${dlApprove.missed}, stdout ${JSON.stringify(dlApprove.stdout.trim())}; ${dlApprove.stderr.trim().slice(0, 200)}`,
    );

    const OUT = "--out ~/.local/share/tars/workspace/out/dl";
    const saved = join(outDir("dl"), "file.bin");
    const dlRun = await step("download-run", `tars script run download ${OUT} -- ${SITE}/file.bin`);
    const report = lastJson(dlRun.stdout);
    check(
      "download-run",
      "the approved download saves the bytes into --out and reports the path, size and sha256",
      dlRun.exitCode === 0 &&
        existsSync(saved) &&
        sha256(readFileSync(saved)) === sha256(FILE) &&
        report.path === join(host.home, ".local/share/tars/workspace/out/dl/file.bin") &&
        report.bytes === FILE.length &&
        report.sha256 === sha256(FILE),
      `exit ${dlRun.exitCode}: ${dlRun.stdout.trim()} ${dlRun.stderr.slice(0, 200)}`,
    );

    const servedBefore = hitCount("/file.bin");
    const refusals = await step(
      "download-refusals",
      `tars script run download ${OUT} -- ${SITE}/file.bin; echo "exists $?"
       tars script run download -- ${SITE}/file.bin; echo "no-out $?"
       tars script run download ${OUT} -- ${SITE}/file.bin --name ../escape; echo "dotdot $?"
       tars script run download ${OUT} -- ${SITE}/file.bin --name x/../../escape; echo "nested $?"
       tars script run download ${OUT} -- ${SITE}/file.bin --name .hidden; echo "hidden $?"
       tars script run download ${OUT} -- ${SITE}/a/..%2Fescape; echo "encoded $?"
       tars script run download ${OUT} -- file:///etc/hostname; echo "scheme $?"`,
    );
    const codes = Object.fromEntries(
      ["exists", "no-out", "dotdot", "nested", "hidden", "encoded", "scheme"].map((l) => [
        l,
        exitOf(refusals.stdout, l),
      ]),
    );
    check(
      "download-exists",
      "download keeps a file already in --out and ends with its declared 5 before it fetches anything",
      codes.exists === 5 &&
        sha256(readFileSync(saved)) === sha256(FILE) &&
        hitCount("/file.bin") === servedBefore,
      `${JSON.stringify(codes)}; /file.bin served ${hitCount("/file.bin") - servedBefore} more time(s)`,
    );
    check(
      "download-no-out",
      "without --out download ends with its declared 3",
      codes["no-out"] === 3,
      `${JSON.stringify(codes)}; /file.bin served ${hitCount("/file.bin") - servedBefore} more time(s)`,
    );
    check(
      "download-names",
      "a file name that climbs out of --out or hides itself, given or from the URL, and a non-http URL end with 2 before any fetch",
      codes.dotdot === 2 &&
        codes.nested === 2 &&
        codes.hidden === 2 &&
        codes.encoded === 2 &&
        codes.scheme === 2 &&
        !hits.includes("/a/..%2Fescape") &&
        hitCount("/file.bin") === servedBefore &&
        !existsSync(join(outDir(""), "escape")) &&
        JSON.stringify(listOut("dl")) === '["file.bin"]',
      `${JSON.stringify(codes)}; out holds ${JSON.stringify(listOut(""))}, out/dl holds ${JSON.stringify(listOut("dl"))}`,
    );

    const limits = await step(
      "download-limits",
      `tars script run download ${OUT} -- ${SITE}/big; echo "big $?"
       tars script run download --timeout 3 ${OUT} -- ${SITE}/slow; echo "slow $?"`,
    );
    check(
      "download-too-big",
      "a body past 100 MiB without a Content-Length ends with the declared 4 and leaves no partial file",
      exitOf(limits.stdout, "big") === 4 && JSON.stringify(listOut("dl")) === '["file.bin"]',
      `big ${exitOf(limits.stdout, "big")}; out/dl holds ${JSON.stringify(listOut("dl"))}; ${limits.stderr.trim().slice(0, 200)}`,
    );
    check(
      "download-timeout",
      "a download cut off by --timeout ends with 124 and leaves no partial file",
      exitOf(limits.stdout, "slow") === 124 && JSON.stringify(listOut("dl")) === '["file.bin"]',
      `slow ${exitOf(limits.stdout, "slow")}; out/dl holds ${JSON.stringify(listOut("dl"))}`,
    );

    await gcalChecks(scripts, check);
  } finally {
    for (const s of servers) s.stop(true);
  }
  printChecks(checks);
  return finishChecks(checks, host.work);
}

if (import.meta.main)
  process.exitCode = process.env[INNER]
    ? await inner()
    : enterScriptNetns(import.meta.path, INNER, "e2e:pilots");
