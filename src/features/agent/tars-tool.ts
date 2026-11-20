import { mkdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { processStartTime, spawnAndWait, type SandboxResult } from "../../core/spawn.ts";
import {
  DATA_DIR_VAR,
  IN_SESSION_VAR,
  LAUNCH_DIR_VAR,
  type Env,
  type TarsPaths,
} from "../../core/paths.ts";
import { loadApprovedScript } from "../script/approved.ts";
import { domainText, OUTPUT_LIMIT, SLUG } from "../script/metadata.ts";
import {
  OUT_ROOT_ONLY_VAR,
  realpathOfExistingAncestorPlusRest,
  refuseLinkedWorkspace,
  within,
} from "../script/out-dir.ts";
import { cutUtf8 } from "./bytes.ts";
import type { ToolOutcome } from "./tools.ts";
import type { ApprovalFields } from "./types.ts";

/** The approval card's fields that come from the script; the approval adds its id and expiry. */
export type ScriptFields = Omit<ApprovalFields, "approvalId" | "expiresAt">;

export type Classified =
  | { readonly kind: "allow"; readonly canonicalArgv: string[]; readonly timeoutMs: number }
  | {
      readonly kind: "approve";
      readonly canonicalArgv: string[];
      readonly timeoutMs: number;
      readonly fields: ScriptFields;
    }
  | { readonly kind: "refuse"; readonly reason: string };

export interface ClassifyContext {
  readonly paths: TarsPaths;
  approveCommand(name: string): string;
}

export const REFUSAL_TEXT = "tars chat 不執行這個指令，沒有任何動作發生。";

const READ_TIMEOUT_MS = 30_000;
const RUN_DEFAULT_S = 120;
const RUN_MAX_S = 300;
const RUN_EXTRA_MS = 30_000;

const refuse = (reason: string): Classified => ({ kind: "refuse", reason });
const allow = (canonicalArgv: string[]): Classified => ({
  kind: "allow",
  canonicalArgv,
  timeoutMs: READ_TIMEOUT_MS,
});

/** One token stream, eaten from the front; only `--name value` options as two elements. */
class Tokens {
  private i = 0;
  constructor(private readonly items: readonly string[]) {}
  get done() {
    return this.i >= this.items.length;
  }
  next(): string | undefined {
    return this.items[this.i++];
  }
  rest(): string[] {
    const r = this.items.slice(this.i);
    this.i = this.items.length;
    return r;
  }
}

/**
 * Parses argv into a known shape and rebuilds a canonical argv from it; the card, the hash and
 * the child all use that, never the model's own strings, so this parser and commander in the
 * child cannot read one argv two ways. Anything not in the table is refused, including CLI
 * options added later.
 */
export async function classify(argv: unknown, ctx: ClassifyContext): Promise<Classified> {
  if (!Array.isArray(argv) || argv.length === 0) return refuse("argv 是空的");
  if (!argv.every((a): a is string => typeof a === "string" && !a.includes("\0")))
    return refuse("argv 只能是不含 NUL 的字串");
  const [a, b] = argv;
  if (a === "cost") return jsonOnly(["cost"], argv.slice(1));
  const rest = argv.slice(2);
  switch (`${a} ${b}`) {
    case "script search":
      return search(rest);
    case "script list":
    case "secret list":
    case "models list":
      return jsonOnly([a as string, b as string], rest);
    case "script show":
      return show(rest);
    case "script run":
      return run(rest, ctx);
    default:
      return refuse(`${argv.slice(0, 2).join(" ")} 不在白名單上`);
  }
}

function jsonOnly(head: string[], rest: readonly string[]): Classified {
  if (rest.length === 0) return allow(head);
  if (rest.length === 1 && rest[0] === "--json") return allow([...head, "--json"]);
  return refuse(`${head.join(" ")} 只接受 --json`);
}

function search(rest: readonly string[]): Classified {
  const words: string[] = [];
  let json = false;
  for (const t of rest) {
    if (t === "--json" && !json) json = true;
    else if (t.startsWith("-")) return refuse(`script search 不接受 ${t}`);
    else words.push(t);
  }
  if (words.length === 0) return refuse("script search 至少要一個字");
  return allow(["script", "search", ...words, ...(json ? ["--json"] : [])]);
}

function show(rest: readonly string[]): Classified {
  let name: string | undefined;
  let json = false;
  for (const t of rest) {
    if (t === "--json" && !json) json = true;
    else if (t.startsWith("-") || name !== undefined) return refuse(`script show 不接受 ${t}`);
    else name = t;
  }
  if (name === undefined || !SLUG.test(name)) return refuse("script show 要一個腳本名稱");
  return allow(["script", "show", name, ...(json ? ["--json"] : [])]);
}

async function run(rest: readonly string[], ctx: ClassifyContext): Promise<Classified> {
  const tokens = new Tokens(rest);
  let name: string | undefined;
  let timeoutText: string | undefined;
  let out: string | undefined;
  while (!tokens.done) {
    const t = tokens.next() as string;
    if (t === "--") break;
    if (t === "--timeout" && timeoutText === undefined) timeoutText = tokens.next();
    else if (t === "--out" && out === undefined) out = tokens.next();
    else if (!t.startsWith("-") && name === undefined) name = t;
    else return refuse(`script run 不接受 ${t}`);
    if ((t === "--timeout" && timeoutText === undefined) || (t === "--out" && out === undefined))
      return refuse(`${t} 後面要有值`);
  }
  const args = tokens.rest();
  if (name === undefined || !SLUG.test(name)) return refuse("script run 要一個腳本名稱");
  let script;
  try {
    script = await loadApprovedScript(ctx.paths.scripts, name, ctx.approveCommand);
  } catch (err) {
    return refuse((err as Error).message);
  }
  const timeout = timeoutText === undefined ? RUN_DEFAULT_S : Number(timeoutText);
  if (
    timeoutText !== undefined &&
    (!/^\d+$/.test(timeoutText) || timeout < 1 || timeout > RUN_MAX_S)
  )
    return refuse(`--timeout 要 1 到 ${RUN_MAX_S} 的整數秒`);
  const realOut = out === undefined ? undefined : await checkOut(out, ctx.paths);
  if (realOut === null)
    return refuse(`--out ${out} 必須是 workspace/out 底下的子目錄，而且不在點開頭的目錄裡`);
  const canonicalArgv = [
    "script",
    "run",
    name,
    "--expect-version",
    script.version,
    "--timeout",
    String(timeout),
    ...(realOut === undefined ? [] : ["--out", realOut]),
    "--",
    ...args,
  ];
  const timeoutMs = timeout * 1000 + RUN_EXTRA_MS;
  const { meta } = script;
  const only = meta.domains.length === 1 ? meta.domains[0] : undefined;
  // A wildcard domain is anyone's subdomain, so it is as open as any host (r64).
  const free =
    meta.effects === "read-only" &&
    only?.kind === "host" &&
    !only.host.startsWith("*.") &&
    realOut === undefined;
  if (free) return { kind: "allow", canonicalArgv, timeoutMs };
  return {
    kind: "approve",
    canonicalArgv,
    timeoutMs,
    fields: {
      action: "run_script",
      script: script.name,
      version: script.version,
      summary: meta.summary,
      effects: meta.effects,
      domains: meta.domains.map(domainText),
      secret: meta.secret ?? null,
      argv: canonicalArgv,
    },
  };
}

/**
 * The real path for --out, or null. Resolved here, not in the child, so a symlink to
 * workspace/.evidence (which the child's prepareOutDir would accept) is caught first.
 */
async function checkOut(out: string, paths: TarsPaths): Promise<string | null> {
  try {
    await refuseLinkedWorkspace(paths.data);
  } catch {
    return null;
  }
  const real = await realpathOfExistingAncestorPlusRest(resolve(paths.workspace, out));
  const root = await realpathOfExistingAncestorPlusRest(paths.outRoot);
  if (!within(real, root) || real === root) return null;
  return relative(root, real)
    .split(sep)
    .some((s) => s.startsWith("."))
    ? null
    : real;
}

/** The variables a child gets, and nothing else: no API key is ever in the environment. */
const PASSED_THROUGH = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_BIN_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

export function childEnv(env: Env, paths: TarsPaths): Record<string, string> {
  const passed = Object.fromEntries(
    PASSED_THROUGH.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k] as string]])),
  );
  return {
    ...passed,
    [DATA_DIR_VAR]: paths.data,
    [LAUNCH_DIR_VAR]: paths.outRoot,
    [IN_SESSION_VAR]: "1",
    // checkOut resolved --out once here; the child resolves it again when it creates the
    // directory, and must hold the same rule then, or a swapped symlink reaches .evidence.
    [OUT_ROOT_ONLY_VAR]: "1",
  };
}

export interface RunSelfContext {
  readonly selfCommand: readonly string[];
  readonly paths: TarsPaths;
  readonly env: Env;
  readonly signal: AbortSignal;
  /** The child's pid and start time, recorded so reconcile can find a group left behind. */
  readonly onSpawn: (pid: number, start: string | null) => void;
}

/** The script runner in the child gives the sandbox 2 s; 5 s here leaves it time to finish. */
const GRACE_MS = 5000;

export async function runSelf(
  canonicalArgv: readonly string[],
  timeoutMs: number,
  ctx: RunSelfContext,
): Promise<SandboxResult> {
  await mkdir(ctx.paths.workspace, { recursive: true });
  return spawnAndWait(
    [...ctx.selfCommand, ...canonicalArgv],
    ctx.paths.workspace,
    childEnv(ctx.env, ctx.paths),
    timeoutMs,
    {
      signal: ctx.signal,
      graceMs: GRACE_MS,
      group: true,
      handleSignals: false,
      onSpawn: (pid) => ctx.onSpawn(pid, processStartTime(pid) ?? null),
    },
  );
}

export function toolText(result: SandboxResult): ToolOutcome {
  const text = `exit ${result.exit}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
  const clipped = cutUtf8(text, OUTPUT_LIMIT);
  return {
    status: result.exit === 0 ? "done" : "failed",
    text: clipped,
    truncated: result.truncated || clipped.length < text.length,
    exit: result.exit,
  };
}
