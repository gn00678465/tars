import { InvalidArgumentError } from "commander";
import { TarsError } from "../../core/exit.ts";
import type { Io } from "../../core/io.ts";
import { inSession, type Env } from "../../core/paths.ts";
import { PROVIDERS, type Provider, type SecretStore } from "../../core/secrets.ts";
import type { Terminal } from "../../core/terminal.ts";
import type { AdapterFor } from "./provider.ts";

/** What the agent commands (config, llm, models, cost, chat) get from main. */
export interface AgentCommandContext {
  readonly env: Env;
  readonly io: Io;
  readonly secrets: SecretStore;
  /** Throws a TarsError when the process has no controlling terminal. */
  openTerminal(): Terminal;
  readonly adapterFor: AdapterFor;
  now(): Date;
}

/** Commands that write settings, keys or the ledger are the owner's alone (r63). */
export function refuseInSession(env: Env): void {
  if (inSession(env)) throw new TarsError("只能在你自己的終端執行");
}

export function parseProvider(value: string): Provider {
  if (!PROVIDERS.includes(value as Provider))
    throw new InvalidArgumentError(`provider must be one of ${PROVIDERS.join(", ")}.`);
  return value as Provider;
}

export interface ModelRef {
  readonly provider: Provider;
  readonly id: string;
}

/** `<provider>/<id>`; the id may itself hold slashes. */
export function parseModelRef(value: string): ModelRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1)
    throw new InvalidArgumentError("write the model as <provider>/<id>, e.g. anthropic/<id>.");
  return { provider: parseProvider(value.slice(0, slash)), id: value.slice(slash + 1) };
}

/** Shows `lines` on the owner's terminal and returns whether they typed yes. */
export async function confirmOnTty(
  openTerminal: () => Terminal,
  lines: readonly string[],
  prompt = "確定？輸入 yes 或 no：",
): Promise<boolean> {
  const terminal = openTerminal();
  try {
    terminal.write(`${lines.join("\n")}\n`);
    return (await terminal.ask(prompt))?.trim() === "yes";
  } finally {
    terminal.close();
  }
}
