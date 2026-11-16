import { InvalidArgumentError, Option, type Command } from "commander";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { writeFileAtomic } from "../../core/fs.ts";
import type { Io } from "../../core/io.ts";
import type { SecretName, SecretStore } from "../../core/secrets.ts";
import { SLUG } from "./metadata.ts";

/** static: handed to the script as is. google-oauth: tars trades it for an access token (step 7). */
export const SECRET_TYPES = ["static", "google-oauth"] as const;
export type SecretType = (typeof SECRET_TYPES)[number];

export const secretName = (kind: string): SecretName => `script:${kind}`;

// One file per kind, so two sessions setting different kinds never overwrite each other.
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

/** The host (with port) a `"secret:url"` script may reach, or why the secret cannot give one. */
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

export interface SecretCommandContext {
  readonly io: Io;
  readonly secrets: SecretStore;
  scriptsDir(): string;
  readSecret(prompt: string): Promise<string>;
}

export function registerSecretCommands(program: Command, ctx: SecretCommandContext): void {
  const secret = program
    .command("secret")
    .description("Store or delete the keyring secret a script declares. Values never print.");

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

Exit codes: 0 saved, 1 failure, 2 usage error.

Examples:
  tars secret set bark
  printf '%s' "$TOKEN" | tars secret set gcal --type google-oauth`,
    )
    .action(async (kind: string, opts: { type: SecretType }) => {
      const value = (await ctx.readSecret(`${secretName(kind)}: `)).trim();
      if (value === "") throw new TarsError("empty secret; nothing saved");
      if (value.startsWith("{") || opts.type === "google-oauth") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new TarsError("the secret is not valid JSON; nothing saved");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          throw new TarsError("the secret must be a JSON object; nothing saved");
      }
      await ctx.secrets.set(secretName(kind), value);
      const file = typeFile(ctx.scriptsDir(), kind);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify({ type: opts.type })}\n`);
      ctx.io.out(`saved ${secretName(kind)} (${opts.type})`);
    });

  secret
    .command("delete")
    .description("Delete a script secret from the keyring.")
    .argument("<kind>", "the `secret` a script declares", parseKind)
    .addHelpText("after", "\nExit codes: 0 deleted or already absent, 1 failure, 2 usage error.")
    .action(async (kind: string) => {
      const existed = await ctx.secrets.delete(secretName(kind));
      await rm(typeFile(ctx.scriptsDir(), kind), { force: true });
      ctx.io.out(`${existed ? "deleted" : "already absent:"} ${secretName(kind)}`);
    });
}

function parseKind(value: string): string {
  if (!SLUG.test(value))
    throw new InvalidArgumentError("use lowercase letters, digits and hyphens, e.g. bark.");
  return value;
}
