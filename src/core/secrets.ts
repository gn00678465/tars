import { TarsError } from "./exit.ts";

export type SecretName = "claude-oauth-token";

/** Keyring access; tests use an in-memory fake so they never touch the real keyring. */
export interface SecretStore {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
}

const SERVICE = "tars";

const keyringError = (err: unknown): never => {
  throw new TarsError(`cannot reach the OS keyring: ${(err as Error).message}`);
};

export const keyringStore: SecretStore = {
  get: (name) => Bun.secrets.get({ service: SERVICE, name }).catch(keyringError),
  set: (name, value) => Bun.secrets.set({ service: SERVICE, name, value }).catch(keyringError),
};
