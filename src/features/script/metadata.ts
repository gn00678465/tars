export const EFFECTS = ["read-only", "external-write", "local-write"] as const;
export type Effects = (typeof EFFECTS)[number];

/** Where a script may connect. `any` is open network; `secret-url` takes the host from the secret. */
export type Domain =
  | { readonly kind: "host"; readonly host: string; readonly port?: number }
  | { readonly kind: "secret-url" }
  | { readonly kind: "any" };

export interface ScriptMeta {
  readonly name: string;
  readonly summary: string;
  readonly secret?: string;
  readonly domains: readonly Domain[];
  readonly effects: Effects;
  readonly args: string;
  readonly outputs: string;
  /** Exit code → meaning. Codes 124 and up belong to `tars script run`. */
  readonly exit: ReadonlyMap<number, string>;
  readonly requiresPython?: string;
  readonly dependencies: readonly string[];
}

/** Every problem found, so the author can fix them in one round. */
export class ScriptMetaError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "ScriptMetaError";
  }
}

export const SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_SCRIPT_EXIT = 123;

// The reference regex from the PEP 723 spec, so tars and uv see the same block.
const BLOCK = /^# \/\/\/ (?<type>[a-zA-Z0-9-]+)$\s(?<content>(?:^#(?:| .*)$\s)+)^# \/\/\/$/gm;

// Name, optional extras, optional version clauses. No URL, path, `@` or environment marker,
// because each of those can make uv fetch the package from somewhere other than PyPI.
const VERSION = String.raw`(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+`;
const DEPENDENCY = new RegExp(
  String.raw`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*\])?\s*(?:${VERSION}(?:\s*,\s*${VERSION})*)?$`,
);

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOSTNAME = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)*${LABEL}$`);
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

const TOP_KEYS = new Set(["requires-python", "dependencies", "tool"]);
const TARS_KEYS = new Set([
  "name",
  "summary",
  "secret",
  "domains",
  "effects",
  "args",
  "outputs",
  "exit",
]);

export function parseScriptMeta(source: string): ScriptMeta {
  const blocks = [...source.matchAll(BLOCK)].filter((m) => m.groups?.type === "script");
  if (blocks.length !== 1) {
    throw new ScriptMetaError([
      blocks.length === 0
        ? "no `# /// script` metadata block"
        : `${blocks.length} \`# /// script\` blocks; keep exactly one`,
    ]);
  }
  const content = (blocks[0]?.groups?.content ?? "")
    .split("\n")
    .map((line) => (line.startsWith("# ") ? line.slice(2) : line.slice(1)))
    .join("\n");
  let toml: unknown;
  try {
    toml = Bun.TOML.parse(content);
  } catch (err) {
    throw new ScriptMetaError([`metadata is not valid TOML: ${(err as Error).message}`]);
  }
  return validate(toml);
}

function validate(toml: unknown): ScriptMeta {
  const problems: string[] = [];
  const top = isRecord(toml) ? toml : {};
  for (const key of Object.keys(top)) {
    if (!TOP_KEYS.has(key))
      problems.push(
        `\`${key}\` is not allowed; use only requires-python, dependencies, [tool.tars]`,
      );
  }

  const requiresPython = optionalString(top, "requires-python", problems);
  const dependencies = stringArray(top, "dependencies", problems);
  for (const dep of dependencies) {
    if (!DEPENDENCY.test(dep))
      problems.push(`dependency "${dep}" must be a PyPI name with optional extras and versions`);
  }

  const tool = isRecord(top.tool) ? top.tool : {};
  for (const key of Object.keys(tool)) {
    if (key !== "tars") problems.push(`[tool.${key}] is not allowed; only [tool.tars]`);
  }
  if (!isRecord(tool.tars)) throw new ScriptMetaError([...problems, "missing [tool.tars]"]);
  const tars = tool.tars;
  for (const key of Object.keys(tars)) {
    if (!TARS_KEYS.has(key)) problems.push(`[tool.tars] has unknown key \`${key}\``);
  }

  const name = requiredLine(tars, "name", problems);
  if (name !== "" && !SLUG.test(name)) problems.push(`name "${name}" must match ${SLUG.source}`);
  const summary = requiredLine(tars, "summary", problems);
  const secret = optionalString(tars, "secret", problems);
  if (secret !== undefined && !SLUG.test(secret))
    problems.push(`secret "${secret}" must match ${SLUG.source}`);
  const domains = parseDomains(stringArray(tars, "domains", problems), secret, problems);
  const effects = tars.effects;
  if (!EFFECTS.includes(effects as Effects))
    problems.push(`effects must be one of ${EFFECTS.join(", ")}`);
  const args = requiredString(tars, "args", problems);
  const outputs = requiredString(tars, "outputs", problems);
  const exit = parseExit(tars.exit, problems);

  if (problems.length > 0) throw new ScriptMetaError(problems);
  return {
    name,
    summary,
    ...(secret === undefined ? {} : { secret }),
    domains,
    effects: effects as Effects,
    args,
    outputs,
    exit,
    ...(requiresPython === undefined ? {} : { requiresPython }),
    dependencies,
  };
}

function parseDomains(
  entries: readonly string[],
  secret: string | undefined,
  problems: string[],
): Domain[] {
  const domains: Domain[] = [];
  for (const entry of entries) {
    if (entry === "*") {
      if (secret !== undefined)
        problems.push('domains "*" is only for scripts without a secret (r49)');
      domains.push({ kind: "any" });
    } else if (entry === "secret:url") {
      if (secret === undefined) problems.push('domains "secret:url" needs a secret');
      domains.push({ kind: "secret-url" });
    } else {
      const domain = parseHost(entry);
      if (typeof domain === "string") problems.push(domain);
      else domains.push(domain);
    }
  }
  if (domains.some((d) => d.kind === "any") && domains.length > 1)
    problems.push('domains "*" must be the only entry');
  return domains;
}

function parseHost(entry: string): Domain | string {
  const [host = "", port, ...rest] = entry.split(":");
  if (rest.length > 0) return `domain "${entry}": IPv6 is not supported; use a name or IPv4`;
  if (host === "localhost" || host.endsWith(".localhost"))
    return `domain "${entry}": the sandbox never reaches localhost; write 127.0.0.1:<port>`;
  if (!HOSTNAME.test(host) && !IPV4.test(host))
    return `domain "${entry}" is not a lowercase host name or IPv4 address`;
  if (port === undefined) return { kind: "host", host };
  const n = Number(port);
  if (!/^\d+$/.test(port) || n < 1 || n > 65535)
    return `domain "${entry}": port must be 1 to 65535`;
  return { kind: "host", host, port: n };
}

function parseExit(value: unknown, problems: string[]): Map<number, string> {
  const exit = new Map<number, string>();
  if (!isRecord(value)) {
    problems.push('exit must be a table such as { 0 = "done", 1 = "failed" }');
    return exit;
  }
  for (const [key, meaning] of Object.entries(value)) {
    const code = Number(key);
    if (!/^\d+$/.test(key) || code > MAX_SCRIPT_EXIT)
      problems.push(`exit code ${key} must be 0 to ${MAX_SCRIPT_EXIT}; tars uses 124 and up`);
    else if (typeof meaning !== "string" || meaning.trim() === "")
      problems.push(`exit code ${key} needs a description`);
    else exit.set(code, meaning);
  }
  if (!exit.has(0)) problems.push("exit must describe code 0");
  return new Map([...exit].sort(([a], [b]) => a - b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  table: Record<string, unknown>,
  key: string,
  problems: string[],
): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  problems.push(`${key} must be a string`);
  return undefined;
}

function requiredString(table: Record<string, unknown>, key: string, problems: string[]): string {
  const value = table[key];
  if (typeof value === "string") return value;
  problems.push(`[tool.tars] needs ${key} (a string)`);
  return "";
}

function requiredLine(table: Record<string, unknown>, key: string, problems: string[]): string {
  const value = requiredString(table, key, problems).trim();
  if (typeof table[key] === "string" && (value === "" || value.includes("\n")))
    problems.push(`${key} must be one non-empty line`);
  return value;
}

function stringArray(table: Record<string, unknown>, key: string, problems: string[]): string[] {
  const value = table[key];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  problems.push(`${key} must be an array of strings`);
  return [];
}
