import type { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { TarsError } from "../../core/exit.ts";
import { createExclusive } from "../../core/fs.ts";
import { resolvePaths } from "../../core/paths.ts";
import { PROVIDERS, type Provider } from "../../core/secrets.ts";
import { confirmOnTty, parseProvider, refuseInSession, type AgentCommandContext } from "./cli.ts";
import { CONFIG_TEMPLATE } from "./config.ts";

export function registerSetupCommands(program: Command, ctx: AgentCommandContext): void {
  program
    .command("config")
    .description("Settings for tars chat in ~/.config/tars.")
    .command("init")
    .description("Write the config.toml template; an existing file is left alone.")
    .addHelpText(
      "after",
      `
Writes $XDG_CONFIG_HOME/tars/config.toml (default ~/.config/tars/config.toml), with anthropic
enabled and the default budget and limits. Edit it by hand afterwards; tars only reads it.

Exit codes: 0 written, 1 it already exists or inside a tars session, 2 usage error.

Examples:
  tars config init`,
    )
    .action(async () => {
      refuseInSession(ctx.env);
      const paths = resolvePaths(ctx.env);
      await mkdir(paths.config, { recursive: true });
      if (!(await createExclusive(paths.configFile, CONFIG_TEMPLATE)))
        throw new TarsError(`${paths.configFile} 已存在，沒有覆寫`);
      ctx.io.out(`wrote ${paths.configFile}`);
    });

  const key = program
    .command("llm")
    .description("API keys for model providers, kept in the OS keyring as llm:<provider>.")
    .command("key")
    .description("Store, delete or check a provider's API key.");

  key
    .command("set")
    .description("Store a provider's API key, typed on your terminal.")
    .argument("<provider>", PROVIDERS.join(" | "), parseProvider)
    .addHelpText(
      "after",
      `
Reads the key from /dev/tty with echo off, never from stdin or an argument.

Exit codes: 0 stored, 1 empty key, no terminal or inside a tars session, 2 usage error.

Examples:
  tars llm key set anthropic`,
    )
    .action(async (provider: Provider) => {
      refuseInSession(ctx.env);
      const terminal = ctx.openTerminal();
      let value: string | undefined;
      try {
        value = (await terminal.askHidden(`${provider} API 金鑰：`))?.trim();
      } finally {
        terminal.close();
      }
      if (!value) throw new TarsError("金鑰是空的，沒有儲存");
      await ctx.secrets.set(`llm:${provider}`, value);
      ctx.io.out(`stored llm:${provider}`);
    });

  key
    .command("delete")
    .description("Delete a provider's API key after you confirm on your terminal.")
    .argument("<provider>", PROVIDERS.join(" | "), parseProvider)
    .addHelpText(
      "after",
      `
Exit codes: 0 deleted or absent, 1 not confirmed or inside a tars session, 2 usage error.

Examples:
  tars llm key delete anthropic`,
    )
    .action(async (provider: Provider) => {
      refuseInSession(ctx.env);
      if (!(await confirmOnTty(ctx.openTerminal, [`刪除 keyring 裡的 llm:${provider}。`])))
        throw new TarsError("沒有確認，金鑰保留");
      const result = await ctx.secrets.delete(`llm:${provider}`);
      ctx.io.out(result === "deleted" ? `deleted llm:${provider}` : `llm:${provider} was not set`);
    });

  key
    .command("status")
    .description("Say which providers have a key, never the key itself.")
    .addHelpText(
      "after",
      `
Exit codes: 0 done, 1 the keyring cannot be reached.

Examples:
  tars llm key status`,
    )
    .action(async () => {
      for (const provider of PROVIDERS) {
        const set = (await ctx.secrets.get(`llm:${provider}`)) !== null;
        ctx.io.out(`${provider}\t${set ? "已設定" : "未設定"}`);
      }
    });
}
