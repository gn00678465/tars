import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWithSecret } from "../../src/features/script/execute.ts";
import { submit } from "../../src/features/script/gate1.ts";
import { seccompHelper } from "../../src/features/script/seccomp.ts";
import { fakeGoogle, granted } from "../features/script/fake-google.ts";
import { draftDir, testToolchain } from "../features/script/gates.ts";
import { fakeSecrets } from "../helpers.ts";
import { runDialog } from "./pty.ts";
import { rawHttp } from "./raw-http.ts";
import type { ScriptHost } from "./script-host.ts";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "..", "examples", "scripts", "gcal-day", "script.py"),
  "utf8",
);
const CAL_PORT = 18777;
const CAL = `http://127.0.0.1:${CAL_PORT}`;
const CUT_PORT = 18779;
const TOKEN = "E2E-FAKE-ACCESS-TOKEN/with+chars=0123456789";
const WRONG_TOKEN = "E2E-WRONG-ACCESS-TOKEN-9876543210";
const CLIENT_ID = "e2e-client.apps.example";
const CLIENT_SECRET = "E2E-FAKE-CLIENT-SECRET-0123456789";
const REFRESH_TOKEN = "E2E-FAKE-REFRESH-TOKEN/with+chars=0123456789";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.owned.readonly";
const CREDENTIAL = JSON.stringify({
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  refresh_token: REFRESH_TOKEN,
  scope: SCOPE,
});
const LIVE_SECRET = "Run it once with the real secret before deciding? [y/N] ";

const MEETING = {
  id: "abc123",
  status: "confirmed",
  summary: "會議",
  start: { dateTime: "2026-11-16T10:00:00+08:00", timeZone: "Asia/Taipei" },
  end: { dateTime: "2026-11-16T11:00:00+08:00", timeZone: "Asia/Taipei" },
};
const ALL_DAY = {
  id: "def456",
  summary: "全天",
  start: { date: "2026-11-16" },
  end: { date: "2026-11-17" },
};
const UNTITLED = { id: "ghi789", start: { date: "2026-11-16" }, end: { date: "2026-11-17" } };
const EXPECTED = JSON.stringify([
  { start: "2026-11-16T10:00:00+08:00", end: "2026-11-16T11:00:00+08:00", summary: "會議" },
  { start: "2026-11-16", end: "2026-11-17", summary: "全天" },
  { start: "2026-11-16", end: "2026-11-17", summary: "" },
]);

interface CalendarRequest {
  readonly target: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string;
}

/**
 * events.list as Google documents it: two pages joined by nextPageToken, a timed and two all-day
 * events, and Google's 401 body for any other bearer token. 2026-11-17 has no events, and
 * 2026-11-18 gets Google's 403 for a token without the calendar scope.
 */
function fakeCalendar(bearer: () => string) {
  const requests: CalendarRequest[] = [];
  const server = Bun.serve({
    hostname: "::",
    port: CAL_PORT,
    fetch: (req) => {
      const url = new URL(req.url);
      const query = Object.fromEntries(url.searchParams);
      const authorization = req.headers.get("authorization") ?? "";
      requests.push({ target: `${req.method} ${url.pathname}`, query, authorization });
      if (authorization !== `Bearer ${bearer()}`)
        return Response.json(
          {
            error: {
              code: 401,
              message: "Request had invalid authentication credentials. LEAK-CANARY",
              errors: [{ message: "Invalid Credentials", domain: "global", reason: "authError" }],
              status: "UNAUTHENTICATED",
            },
          },
          {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="https://accounts.google.com/", error="invalid_token"',
            },
          },
        );
      const head = { kind: "calendar#events", timeZone: "Asia/Taipei", accessRole: "owner" };
      if (query.timeMin?.startsWith("2026-11-17")) return Response.json({ ...head, items: [] });
      if (query.timeMin?.startsWith("2026-11-18"))
        return Response.json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes. LEAK-CANARY",
              errors: [
                {
                  message: "Insufficient Permission",
                  domain: "global",
                  reason: "insufficientPermissions",
                },
              ],
              status: "PERMISSION_DENIED",
            },
          },
          { status: 403 },
        );
      return query.pageToken === "PAGE-2"
        ? Response.json({ ...head, items: [ALL_DAY, UNTITLED] })
        : Response.json({ ...head, items: [MEETING], nextPageToken: "PAGE-2" });
    },
  });
  return { requests, stop: () => void server.stop(true) };
}

/**
 * The gcal-day pilot and the google-oauth secret. dist/tars has no way to point the token
 * endpoint anywhere but Google, so its three-gate run uses a static secret that stands in for
 * the access token, and the token trade is run from src with the endpoints passed in.
 */
export async function gcalChecks(
  { host, step, draft }: ScriptHost,
  check: (id: string, claim: string, pass: boolean, evidence: string) => void,
): Promise<void> {
  const exitOf = (stdout: string, label: string) =>
    Number(new RegExp(`^${label} (\\d+)$`, "m").exec(stdout)?.[1] ?? -1);
  let accepted = TOKEN;
  const calendar = fakeCalendar(() => accepted);
  const cutOff = rawHttp(CUT_PORT, {
    "/calendar/v3/calendars/primary/events":
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\n{"kin\r\n',
  });
  const { requests } = calendar;
  const local = SOURCE.replace(
    'domains = ["www.googleapis.com"]',
    `domains = ["127.0.0.1:${CAL_PORT}", "127.0.0.1:${CUT_PORT}"]`,
  );
  const DAY = `--date 2026-11-16 --tz Asia/Taipei --api ${CAL}`;
  try {
    const noTty = await runDialog(host, {
      name: "login-no-tty",
      command: "tars secret login gcal",
      tty: false,
      turns: [],
    });
    const inSession = await step("login-in-session", "tars secret login gcal", {
      TARS_IN_SESSION: "1",
    });
    check(
      "login-refusals",
      "tars secret login exits 1 without a controlling terminal, and inside a tars session",
      noTty.exitCode === 1 &&
        noTty.stderr.includes("/dev/tty") &&
        inSession.exitCode === 1 &&
        inSession.stderr.includes("outside the tars session"),
      `no tty: exit ${noTty.exitCode} ${noTty.stderr.trim()}; in session: exit ${inSession.exitCode} ${inSession.stderr.trim()}`,
    );

    const cancelled = await runDialog(host, {
      name: "login-cancel-at-secret",
      command:
        "trap : INT; tars secret login gcal; echo \"login-exit $?\"; stty -a </dev/tty | tr ' ;' '\\n\\n' | grep -x -e echo -e -echo",
      tty: true,
      turns: [
        { expect: "OAuth client ID: ", send: `${CLIENT_ID}\n` },
        { expect: "OAuth client secret: ", send: `${CLIENT_SECRET.slice(0, 12)}\x03` },
      ],
      waitMs: 20_000,
    });
    check(
      "login-hidden-cancel",
      "the client secret typed at tars secret login is not echoed, and Ctrl-C there exits 1 with the terminal's echo back on",
      cancelled.missed === undefined &&
        !cancelled.transcript.includes(CLIENT_SECRET.slice(0, 12)) &&
        cancelled.transcript.includes(CLIENT_ID) &&
        exitOf(cancelled.stdout, "login-exit") === 1 &&
        cancelled.stderr.includes("cancelled") &&
        cancelled.stdout.trim().endsWith("\necho"),
      `missed ${cancelled.missed}; stdout ${JSON.stringify(cancelled.stdout)}; stderr ${cancelled.stderr.trim()}; transcript ${JSON.stringify(cancelled.transcript)}`,
    );

    const waiting = await runDialog(host, {
      name: "login-cancel-while-waiting",
      command: 'trap : INT; tars secret login gcal; echo "login-exit $?"',
      tty: true,
      turns: [
        { expect: "OAuth client ID: ", send: `${CLIENT_ID}\n` },
        { expect: "OAuth client secret: ", send: `${CLIENT_SECRET}\n` },
        { expect: "code_challenge_method=S256", send: "\x03" },
      ],
      waitMs: 20_000,
    });
    const shown = /https:\/\/\S+/.exec(waiting.transcript)?.[0] ?? "";
    const asked = Object.fromEntries(new URL(shown || "http://missing").searchParams);
    const afterCancel = await step(
      "login-nothing-saved",
      `tars script submit ${draft("gcal-day", SOURCE)}`,
    );
    check(
      "login-address",
      "dist/tars shows Google's own authorization address on the terminal, with PKCE, a state and a loopback redirect, and never the client secret",
      waiting.missed === undefined &&
        shown.startsWith("https://accounts.google.com/o/oauth2/v2/auth?") &&
        asked.client_id === CLIENT_ID &&
        asked.scope === SCOPE &&
        asked.response_type === "code" &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(asked.redirect_uri ?? "") &&
        (asked.code_challenge ?? "").length === 43 &&
        (asked.state ?? "").length >= 43 &&
        !waiting.transcript.includes(CLIENT_SECRET) &&
        !(waiting.stdout + waiting.stderr).includes(CLIENT_SECRET) &&
        !waiting.stdout.includes("https://"),
      `missed ${waiting.missed}; asked ${JSON.stringify({ ...asked, state: `<${(asked.state ?? "").length} chars>`, code_challenge: `<${(asked.code_challenge ?? "").length} chars>` })}; stdout ${JSON.stringify(waiting.stdout)}`,
    );
    check(
      "login-cancel-saves-nothing",
      "Ctrl-C while login waits for the browser ends it, and gate 1 still finds no script:gcal",
      exitOf(waiting.stdout, "login-exit") === 130 &&
        afterCancel.exitCode === 1 &&
        afterCancel.stderr.includes("no script:gcal in the keyring"),
      `login-exit ${exitOf(waiting.stdout, "login-exit")}; submit exit ${afterCancel.exitCode}: ${afterCancel.stderr.trim().slice(0, 200)}`,
    );

    const set = await step("gcal-static-secret", "tars secret set gcal", {}, TOKEN);
    if (set.exitCode !== 0) throw new Error(`tars secret set gcal failed: ${set.stderr}`);
    writeFileSync(join(host.fakeHome, "gcal-review.md"), "GCAL-REVIEW: trial without a token\n");
    const gates = await step(
      "gcal-gates-1-2",
      `tars script submit ${draft("gcal-day", local)} &&
       { tars script trial gcal-day -- ${DAY}; echo "trial-exit $?"; } &&
       tars script review gcal-day --report ~/gcal-review.md`,
    );
    check(
      "gcal-trial",
      "with the test's allow list, gcal-day passes gate 1; its trial gets no token, ends with its declared 3 and asks the fake Calendar nothing",
      local !== SOURCE &&
        gates.exitCode === 0 &&
        gates.stdout.includes("submitted gcal-day (a new script)") &&
        exitOf(gates.stdout, "trial-exit") === 3 &&
        gates.stderr.includes("沒有金鑰") &&
        !gates.stderr.includes("Traceback") &&
        requests.length === 0,
      `exit ${gates.exitCode}: ${gates.stdout.trim().replaceAll("\n", " | ")}; ${requests.length} request(s); ${gates.stderr.trim().slice(0, 300)}`,
    );

    const approve = await runDialog(host, {
      name: "gcal-approve",
      command: "tars script approve gcal-day",
      tty: true,
      turns: [
        { expect: LIVE_SECRET, send: "y\n" },
        { expect: "Arguments as a JSON array", send: `${JSON.stringify(DAY.split(" "))}\n` },
        { expect: "--out directory", send: "\n" },
        { expect: "Run it again? [y/N] ", send: "n\n" },
        { expect: "Type gcal-day to approve it", send: "gcal-day\n" },
      ],
    });
    check(
      "gcal-approve",
      "in a pty the user's live run of gcal-day lists the day, then the name approves it",
      approve.exitCode === 0 &&
        approve.missed === undefined &&
        /^approved gcal-day [0-9a-f]{16}$/.test(approve.stdout.trim()) &&
        approve.transcript.includes(`  | ${EXPECTED}`) &&
        approve.transcript.includes("  | GCAL-REVIEW: trial without a token"),
      `exit ${approve.exitCode}, missed ${approve.missed}, stdout ${JSON.stringify(approve.stdout.trim())}; ${approve.stderr.trim().slice(0, 200)}`,
    );

    requests.length = 0;
    const run = await step("gcal-run", `tars script run gcal-day -- ${DAY}`);
    const [first, second] = requests;
    check(
      "gcal-run",
      "the approved gcal-day asks events.list for the day with the offset of --tz, follows nextPageToken, sends the token only as a Bearer header, and prints one JSON line",
      run.exitCode === 0 &&
        run.stdout.trim() === EXPECTED &&
        requests.length === 2 &&
        requests.every(
          (r) =>
            r.target === "GET /calendar/v3/calendars/primary/events" &&
            r.authorization === `Bearer ${TOKEN}` &&
            !JSON.stringify(r.query).includes(TOKEN),
        ) &&
        JSON.stringify(first?.query) ===
          JSON.stringify({
            timeMin: "2026-11-16T00:00:00+08:00",
            timeMax: "2026-11-17T00:00:00+08:00",
            timeZone: "Asia/Taipei",
            singleEvents: "true",
            orderBy: "startTime",
          }) &&
        JSON.stringify(second?.query) === JSON.stringify({ ...first?.query, pageToken: "PAGE-2" }),
      `exit ${run.exitCode}: ${run.stdout.trim()}; fake Calendar got ${JSON.stringify(requests.map((r) => r.query))}; ${run.stderr.slice(0, 200)}`,
    );
    const all = approve.transcript + run.stdout + run.stderr;
    check(
      "gcal-quiet",
      "gcal-day never prints the token, so tars has nothing to mask",
      !all.includes(TOKEN) && !all.includes("[REDACTED]"),
      `${run.stdout.trim()} | ${run.stderr.trim()}`,
    );

    requests.length = 0;
    const args = await step(
      "gcal-args",
      `tars script run gcal-day -- --date 2026-11-01 --tz America/New_York --api ${CAL} >/dev/null; echo "dst $?"
       tars script run gcal-day -- --date 2026-11-31 --api ${CAL}; echo "date $?"
       tars script run gcal-day -- --date 2026-11-16 --tz Mars/Olympus --api ${CAL}; echo "tz $?"
       tars script run gcal-day -- --date 2026-11-16 --api http://www.googleapis.com; echo "plain $?"
       tars script run gcal-day -- --date 2026-11-16 --api https://; echo "nohost $?"`,
    );
    const dst = requests[0]?.query;
    check(
      "gcal-args",
      "a day on which the clocks change is asked for with each midnight's own offset; a bad date, time zone, plain-http or hostless --api ends with 2 before any request",
      exitOf(args.stdout, "dst") === 0 &&
        dst?.timeMin === "2026-11-01T00:00:00-04:00" &&
        dst.timeMax === "2026-11-02T00:00:00-05:00" &&
        exitOf(args.stdout, "date") === 2 &&
        exitOf(args.stdout, "tz") === 2 &&
        exitOf(args.stdout, "plain") === 2 &&
        exitOf(args.stdout, "nohost") === 2 &&
        requests.length === 2,
      `${args.stdout.trim().replaceAll("\n", " | ")}; dst asked ${JSON.stringify(dst)}; ${requests.length} request(s)`,
    );

    accepted = WRONG_TOKEN;
    const rejected = await step("gcal-rejected", `tars script run gcal-day -- ${DAY}`);
    accepted = TOKEN;
    check(
      "gcal-rejected",
      "a token the Calendar API answers with 401 ends gcal-day with its declared 3, without the response body",
      rejected.exitCode === 3 &&
        rejected.stderr.includes("HTTP 401") &&
        !rejected.stderr.includes("LEAK-CANARY") &&
        !rejected.stderr.includes("Traceback"),
      `exit ${rejected.exitCode}: ${rejected.stderr.trim().slice(0, 200)}`,
    );

    const odd = await step(
      "gcal-odd-days",
      `tars script run gcal-day -- --date 2026-11-17 --tz Asia/Taipei --api ${CAL}; echo "empty $?"
       tars script run gcal-day -- --date 2026-11-18 --tz Asia/Taipei --api ${CAL}; echo "forbidden $?"
       tars script run gcal-day -- --date 2026-11-16 --api http://127.0.0.1:${CUT_PORT}; echo "cut $?"`,
    );
    const oddEvidence = `${odd.stdout.trim().replaceAll("\n", " | ")}; cut-off server asked for ${JSON.stringify(cutOff.hits)}; ${odd.stderr.trim().slice(0, 400)}`;
    check(
      "gcal-empty",
      "a day without events ends gcal-day with 0 and prints []",
      exitOf(odd.stdout, "empty") === 0 && odd.stdout.split("\n").includes("[]"),
      oddEvidence,
    );
    check(
      "gcal-forbidden",
      "a 403 from the Calendar API ends gcal-day with 1 and says the scope or the API is missing, without the response body",
      exitOf(odd.stdout, "forbidden") === 1 &&
        odd.stderr.includes("HTTP 403") &&
        odd.stderr.includes("scope") &&
        !odd.stderr.includes("LEAK-CANARY"),
      oddEvidence,
    );
    check(
      "gcal-cut",
      "a Calendar reply cut off mid-body ends gcal-day with 1 and no traceback",
      exitOf(odd.stdout, "cut") === 1 &&
        cutOff.hits.length === 1 &&
        !odd.stderr.includes("Traceback"),
      oddEvidence,
    );

    const malformed = await step(
      "gcal-oauth-malformed",
      "tars secret set gcal --type google-oauth",
      {},
      JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: SCOPE }),
    );
    const stillStatic = await step("gcal-still-static", `tars script run gcal-day -- ${DAY}`);
    check(
      "oauth-set-shape",
      "tars secret set --type google-oauth refuses a JSON object without refresh_token, names the field, and leaves the stored secret alone",
      malformed.exitCode === 1 &&
        malformed.stderr.includes('"refresh_token"') &&
        !(malformed.stdout + malformed.stderr).includes(CLIENT_SECRET) &&
        stillStatic.exitCode === 0,
      `set exit ${malformed.exitCode}: ${malformed.stderr.trim()}; run after it exit ${stillStatic.exitCode}`,
    );

    const oauthSet = await step(
      "gcal-oauth-set",
      "tars secret set gcal --type google-oauth",
      {},
      CREDENTIAL,
    );
    const urlDraft = SOURCE.replace('name = "gcal-day"', 'name = "gcal-url"').replace(
      'domains = ["www.googleapis.com"]',
      'domains = ["secret:url"]',
    );
    const urlSubmit = await step(
      "gcal-oauth-url",
      `tars script submit ${draft("gcal-url", urlDraft)}`,
    );
    check(
      "oauth-secret-url",
      'gate 1 refuses a script that declares "secret:url" with a google-oauth secret',
      oauthSet.exitCode === 0 &&
        oauthSet.stdout.trim() === "saved script:gcal (google-oauth)" &&
        urlSubmit.exitCode === 1 &&
        urlSubmit.stderr.includes(
          'gate 1: gcal is a google-oauth secret, which has no url for "secret:url"',
        ),
      `set exit ${oauthSet.exitCode}: ${oauthSet.stdout.trim()}; submit exit ${urlSubmit.exitCode}: ${urlSubmit.stderr.trim().slice(0, 300)}`,
    );

    const asWritten = await step(
      "gcal-oauth-submit",
      `tars script submit ${draft("gcal-day", SOURCE)}`,
    );
    const oauthApprove = await runDialog(host, {
      name: "gcal-oauth-approve",
      command: "tars script approve gcal-day",
      tty: true,
      turns: [
        { expect: LIVE_SECRET, send: "n\n" },
        { expect: "Type gcal-day to approve it", send: "gcal-day\n" },
      ],
    });
    requests.length = 0;
    const oauthRun = await step("gcal-oauth-run", "tars script run gcal-day -- --date 2026-11-16");
    const oauthAll = [asWritten, oauthApprove, oauthRun]
      .map((s) => s.stdout + s.stderr)
      .join("\n")
      .concat(oauthApprove.transcript);
    check(
      "oauth-as-written",
      "examples/scripts/gcal-day passes gate 1 as written with a google-oauth secret of four fields, without any request for a token, and is approved",
      asWritten.exitCode === 0 &&
        asWritten.stdout.includes("submitted gcal-day (updates version") &&
        oauthApprove.exitCode === 0 &&
        oauthApprove.missed === undefined,
      `submit exit ${asWritten.exitCode}: ${asWritten.stdout.trim().replaceAll("\n", " | ")} ${asWritten.stderr.trim().slice(0, 200)}; approve exit ${oauthApprove.exitCode}, missed ${oauthApprove.missed}`,
    );
    check(
      "oauth-run-offline",
      "dist/tars trades the credential only at Google: with no route there the run exits 1 before the script starts, and prints neither the refresh token nor the client secret",
      oauthRun.exitCode === 1 &&
        oauthRun.stderr.includes("error: script:gcal: could not reach Google's token endpoint") &&
        requests.length === 0 &&
        !oauthAll.includes(REFRESH_TOKEN) &&
        !oauthAll.includes(CLIENT_SECRET),
      `exit ${oauthRun.exitCode} in ${oauthRun.ms} ms: ${oauthRun.stderr.trim().slice(0, 300)}; ${requests.length} request(s) at the fake Calendar`,
    );

    await tokenTrade(host.work, local, check, requests);
  } finally {
    calendar.stop();
    cutOff.stop();
  }
}

const PROBE = `# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "gcal-probe"
# summary = "prints what the sandbox was given"
# secret = "gcal"
# domains = []
# effects = "read-only"
# args = ""
# outputs = "its environment"
# exit = { 0 = "ok" }
# ///
import base64, os, sys, urllib.parse
secret = os.environ["TARS_SECRET"]
print("plain", secret)
print("quoted", urllib.parse.quote(secret, safe=""))
print("base64", base64.b64encode(secret.encode()).decode(), file=sys.stderr)
print("names", sorted(k for k in os.environ if "TARS" in k or "SECRET" in k or "TOKEN" in k))
print("others", [v for v in os.environ.values() if "E2E-FAKE" in v and v != secret])
`;

/**
 * The token trade end to end, from src: the real sandbox and the real gcal-day, with only the
 * keyring and Google's two addresses replaced.
 */
async function tokenTrade(
  work: string,
  source: string,
  check: (id: string, claim: string, pass: boolean, evidence: string) => void,
  requests: CalendarRequest[],
): Promise<void> {
  const data = join(work, "src-run");
  const scriptsDir = join(data, "scripts");
  mkdirSync(join(scriptsDir, "secrets"), { recursive: true });
  writeFileSync(join(scriptsDir, "secrets", "gcal.json"), '{"type":"google-oauth"}');
  const secrets = fakeSecrets({ "script:gcal": CREDENTIAL });
  const google = fakeGoogle(() => granted({ access_token: TOKEN, scope: SCOPE }));
  const toolchain = testToolchain();
  const ctx = {
    secrets,
    scriptsDir,
    google: google.endpoints,
    toolchain,
    host: {
      realHome: toolchain.realHome,
      data,
      bins: [],
      seccomp: await seccompHelper(data, []),
    },
  };
  const gate = { ...ctx, osv: { url: "http://127.0.0.1:9", timeoutMs: 1000 }, now: new Date() };
  try {
    requests.length = 0;
    const day = await submit(draftDir(source), gate);
    if (!day.ok) throw new Error(`gate 1 refused gcal-day: ${JSON.stringify(day.problems)}`);
    const listed = await runWithSecret(
      day.submission.dir,
      day.submission.meta,
      {
        args: ["--date", "2026-11-16", "--tz", "Asia/Taipei", "--api", CAL],
        timeoutMs: 60_000,
      },
      ctx,
    );
    const form = google.requests[0]?.form;
    check(
      "trade-gcal-day",
      "run from src with a google-oauth secret: tars sends the refresh form with the stored scope, and gcal-day in the sandbox reaches the Calendar API with the access token it got back",
      listed.exit === 0 &&
        listed.stdout.trim() === EXPECTED &&
        google.requests.length === 1 &&
        JSON.stringify(form) ===
          JSON.stringify({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: REFRESH_TOKEN,
            scope: SCOPE,
          }) &&
        requests.length === 2 &&
        requests.every((r) => r.authorization === `Bearer ${TOKEN}`),
      `exit ${listed.exit}: ${listed.stdout.trim()} ${listed.stderr.trim().slice(0, 200)}; token endpoint got ${google.requests.length} request(s) with fields ${Object.keys(form ?? {})}; Calendar got ${requests.length}`,
    );

    const probe = await submit(draftDir(PROBE), gate);
    if (!probe.ok) throw new Error(`gate 1 refused the probe: ${JSON.stringify(probe.problems)}`);
    const seen = await runWithSecret(
      probe.submission.dir,
      probe.submission.meta,
      { args: [], timeoutMs: 60_000 },
      ctx,
    );
    const out = seen.stdout + seen.stderr;
    check(
      "trade-only-token",
      "in the sandbox TARS_SECRET is the access token and nothing else from the credential is there; printed plain, URL-quoted or as base64, tars masks it",
      seen.exit === 0 &&
        seen.stdout.includes("plain [REDACTED]\n") &&
        seen.stdout.includes("quoted [REDACTED]\n") &&
        seen.stderr.includes("base64 [REDACTED]\n") &&
        seen.stdout.includes("names ['TARS_SECRET']\n") &&
        seen.stdout.includes("others []\n") &&
        ![TOKEN, REFRESH_TOKEN, CLIENT_SECRET].some((v) => out.includes(v)),
      `exit ${seen.exit}: ${JSON.stringify(seen.stdout)} ${JSON.stringify(seen.stderr.slice(0, 200))}`,
    );
  } finally {
    google.stop();
  }
}
