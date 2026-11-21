import { TarsError } from "./exit.ts";

export const PROVIDERS = ["anthropic", "gemini", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

// Script secrets go through secretName(), which always adds "script:", and SLUG has no colon, so a
// script can never declare a name that reaches an llm: key or the link: client certificate.
export type SecretName = `script:${string}` | `llm:${Provider}` | `link:${"cert" | "key"}`;

/** Keyring access; tests use an in-memory fake so they never touch the real keyring. */
export interface SecretStore {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<"deleted" | "absent">;
}

const SERVICE = "tars";

const keyringError = (err: unknown): never => {
  throw new TarsError(`cannot reach the OS keyring: ${(err as Error).message}`);
};

export const keyringStore: SecretStore = {
  get: (name) => Bun.secrets.get({ service: SERVICE, name }).catch(keyringError),
  set: (name, value) => Bun.secrets.set({ service: SERVICE, name, value }).catch(keyringError),
  delete: (name) =>
    Bun.secrets
      .delete({ service: SERVICE, name })
      .then((existed) => (existed ? "deleted" : "absent"), keyringError),
};
