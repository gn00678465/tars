import { Option, type Command } from "commander";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, TarsError } from "../../core/exit.ts";
import { writeFileAtomic } from "../../core/fs.ts";
import type { Io } from "../../core/io.ts";
import type { SecretName, SecretStore } from "../../core/secrets.ts";
import type { Terminal } from "../../core/terminal.ts";
import {
  credentialJson,
  DEFAULT_SCOPE,
  parseGoogleCredential,
  type GoogleEndpoints,
} from "./google.ts";
import { isRecord, parseSlug, SLUG } from "./metadata.ts";

export const SECRET_TYPES = ["static", "google-oauth"] as const;
export type SecretType = (typeof SECRET_TYPES)[number];

export const secretName = (kind: string): SecretName => `script:${kind}`;

/** The command that puts a secret of this type into the keyring; only the user runs it. */
export const obtainCommand = (kind: string, type: SecretType | undefined): string =>
  type === "google-oauth" ? `tars secret login ${kind}` : `tars secret set ${kind}`;

const typeFile = (scriptsDir: string, kind: string) => join(scriptsDir, "secrets", `${kind}.json`);

export async function readSecretType(
  scriptsDir: string,
  kind: string,
): Promise<SecretType | undefined> {
  const text = await readFile(typeFile(scriptsDir, kind), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let type: unknown;
  try {
    type = (JSON.parse(text) as { type?: unknown } | null)?.type;
  } catch {
    throw new TarsError(
      `${typeFile(scriptsDir, kind)} is not valid JSON; run tars secret set ${kind} again`,
    );
  }
  return SECRET_TYPES.includes(type as SecretType) ? (type as SecretType) : undefined;
}

export function secretUrlHost(value: string): string | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return new Error('the secret must be JSON: {"url": "<service url>", "key": "<key>"}');
  }
  const { url, key } = (parsed ?? {}) as { url?: unknown; key?: unknown };
  if (typeof url !== "string" || typeof key !== "string")
    return new Error('the secret must have string fields "url" and "key"');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return new Error('the secret\'s "url" is not a URL');
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")
    return new Error('the secret\'s "url" must be http or https');
  return parsedUrl.host;
}

/**
 * The type file decides whether a script gets the value whole (static) or never sees it
 * (google-oauth). The two writes are ordered so that a kill between them leaves the keyring's
 * value under the google-oauth type, which refuses anything that is not a credential, and never
 * leaves a credential under the static type.
 */
async function storeSecret(
  ctx: { readonly secrets: SecretStore; scriptsDir(): string },
  kind: string,
  type: SecretType,
  value: string,
): Promise<void> {
  const writeType = async () => {
    const file = typeFile(ctx.scriptsDir(), kind);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify({ type })}\n`);
  };
  const writeValue = () => ctx.secrets.set(secretName(kind), value);
  if (type === "google-oauth") {
    await writeType();
    await writeValue();
  } else {
    await writeValue();
    await writeType();
  }
}

const LOGIN_WAIT_MS = 5 * 60_000;

export interface SecretCommandContext {
  readonly io: Io;
  readonly secrets: SecretStore;
  scriptsDir(): string;
  readSecret(prompt: string): Promise<string>;
  google(): GoogleEndpoints;
  /** Whether an agent session started this tars (TARS_IN_SESSION). */
  inSession(): boolean;
  /** Opens the user's terminal; a TarsError when the process has none. */
  terminal(): Terminal;
}

export function registerSecretCommands(program: Command, ctx: SecretCommandContext): void {
  const secret = program
    .command("secret")
    .description("Store, list or delete the keyring secret a script declares. Values never print.");

  secret
    .command("set")
    .description("Read one secret from the terminal (no echo) or stdin into the keyring.")
    .argument("<kind>", "the `secret` a script declares, e.g. bark", parseKind)
    .addOption(
      new Option("--type <type>", "how tars hands it over").choices(SECRET_TYPES).default("static"),
    )
    .addHelpText(
      "after",
      `
Leading and trailing whitespace is dropped. A value starting with { must be valid JSON.
A script with domains = ["secret:url"] needs {"url": "<service url>", "key": "<key>"}.
--type google-oauth needs {"client_id": …, "client_secret": …, "refresh_token": …, "scope": …};
tars secret login signs in and stores exactly that.

Exit codes: 0 saved, 1 failure, 2 usage error.

Examples:
  tars secret set bark
  printf '%s' "$CREDENTIAL_JSON" | tars secret set gcal --type google-oauth`,
    )
    .action(async (kind: string, opts: { type: SecretType }) => {
      const value = (await ctx.readSecret(`${secretName(kind)}: `)).trim();
      if (value === "") throw new TarsError("empty secret; nothing saved");
      if (opts.type === "google-oauth") {
        const credential = parseGoogleCredential(value);
        if (credential instanceof Error)
          throw new TarsError(`${credential.message}; nothing saved`);
      } else if (value.startsWith("{")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new TarsError("the secret is not valid JSON; nothing saved");
        }
        if (!isRecord(parsed))
          throw new TarsError("the secret must be a JSON object; nothing saved");
      }
      await storeSecret(ctx, kind, opts.type, value);
      ctx.io.out(`saved ${secretName(kind)} (${opts.type})`);
    });

  secret
    .command("login")
    .description("For the user: sign in to Google in your browser and store a google-oauth secret.")
    .argument("<kind>", "the `secret` a script declares, e.g. gcal", parseKind)
    .option("--scope <scope>", "the access to ask for; space-separated for several", DEFAULT_SCOPE)
    .addHelpText(
      "after",
      `
Needs an OAuth client of type "Desktop app" from your own Google Cloud project, with the
API enabled and the app published ("In production"); a "Testing" app's sign-in ends after
7 days. Asks for the client ID and secret on /dev/tty (the secret is not shown), prints an
address to open, and waits up to 5 minutes for the browser to come back to a port on
127.0.0.1. Stores the client, the refresh token and the granted scope in the keyring and
prints none of them. Scripts only ever get a short-lived access token. Refuses inside a
tars session.

Exit codes: 0 saved, 1 not signed in or failure, 2 usage error.

Examples:
  tars secret login gcal
  tars secret login gcal --scope https://www.googleapis.com/auth/calendar.events.readonly`,
    )
    .action(async (kind: string, opts: { scope: string }) => {
      if (ctx.inSession())
        throw new TarsError(
          "login is for the user: run it in your own terminal, outside the tars session",
        );
      if (opts.scope.trim() === "") throw new TarsError("--scope is empty", EXIT.usage);
      const terminal = ctx.terminal();
      try {
        const id = (await terminal.ask("OAuth client ID: "))?.trim() ?? "";
        const clientSecret =
          id === "" ? "" : ((await terminal.askHidden("OAuth client secret: "))?.trim() ?? "");
        if (id === "" || clientSecret === "")
          throw new TarsError("no client ID or secret given; nothing saved");
        const { googleLogin } = await import("./google-login.ts");
        const credential = await googleLogin({ id, secret: clientSecret }, opts.scope.trim(), {
          endpoints: ctx.google(),
          show: terminal.write,
          waitMs: LOGIN_WAIT_MS,
        });
        await storeSecret(ctx, kind, "google-oauth", credentialJson(credential));
        ctx.io.out(`saved ${secretName(kind)} (google-oauth)`);
      } finally {
        terminal.close();
      }
    });

  secret
    .command("list")
    .description("List the script secrets tars has stored, by kind and type. Values never print.")
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      `
Lists every kind that tars secret set or login stored, and whether the keyring still holds
its value ("stored") or not ("missing"). The token of tars auth claude is not listed.

Exit codes: 0 done, 1 failure, 2 usage error.

Examples:
  tars secret list
  tars secret list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      const entries = await listSecrets(ctx);
      if (opts.json) ctx.io.out(JSON.stringify(entries));
      else if (entries.length === 0) ctx.io.err("no secret stored");
      else for (const e of entries) ctx.io.out(`${e.kind}\t${e.type ?? "unknown"}\t${e.state}`);
    });

  secret
    .command("delete")
    .description("Delete a script secret from the keyring.")
    .argument("<kind>", "the `secret` a script declares", parseKind)
    .addHelpText("after", "\nExit codes: 0 deleted or already absent, 1 failure, 2 usage error.")
    .action(async (kind: string) => {
      const result = await ctx.secrets.delete(secretName(kind));
      await rm(typeFile(ctx.scriptsDir(), kind), { force: true });
      ctx.io.out(`${result === "deleted" ? "deleted" : "already absent:"} ${secretName(kind)}`);
    });
}

// Bun.secrets cannot enumerate the keyring, so the type files that set and login write are the
// index; the keyring is asked only whether each value is still there.
async function listSecrets(ctx: { readonly secrets: SecretStore; scriptsDir(): string }) {
  const dir = join(ctx.scriptsDir(), "secrets");
  const files = await readdir(dir).catch(() => [] as string[]);
  const kinds = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((kind) => SLUG.test(kind))
    .sort();
  return Promise.all(
    kinds.map(async (kind) => ({
      kind,
      type: (await readSecretType(ctx.scriptsDir(), kind)) ?? null,
      state: (await ctx.secrets.get(secretName(kind))) === null ? "missing" : "stored",
    })),
  );
}

const parseKind = parseSlug("bark");
