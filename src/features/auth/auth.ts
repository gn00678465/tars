import type { Command } from "commander";
import { TarsError } from "../../core/exit.ts";
import type { Io } from "../../core/io.ts";
import type { SecretStore } from "../../core/secrets.ts";
import { harnessEntries } from "../session/harness/registry.ts";

export interface AuthDeps {
  readonly io: Io;
  readonly secrets: SecretStore;
  readSecret(prompt: string): Promise<string>;
}

export function registerAuth(program: Command, deps: AuthDeps): void {
  const auth = program.command("auth").description("store a harness login in the keyring");
  for (const [name, adapter] of harnessEntries) {
    if (!adapter.credential) continue;
    const { secret, obtain } = adapter.credential;
    auth
      .command(name)
      .description(`read one ${name} token from stdin and store it in the keyring`)
      .addHelpText(
        "after",
        `
Get the token with \`${obtain}\`. On a terminal tars prompts without echo.
The token is stored as service "tars", name "${secret}", and never printed.

Examples:
  tars auth ${name}
  tars auth ${name} < token.txt`,
      )
      .action(async () => {
        const token = (await deps.readSecret(`${name} token: `)).trim();
        if (!token) throw new TarsError(`no token on stdin; get one with \`${obtain}\``);
        if (/\s/.test(token)) throw new TarsError("expected one token without whitespace");
        await deps.secrets.set(secret, token);
        deps.io.out(`stored ${secret} in the keyring`);
      });
  }
}
