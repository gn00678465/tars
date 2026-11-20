import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TarsError } from "../../core/exit.ts";

export interface OutDirRules {
  readonly cwd: string;
  readonly launchDir: string;
  readonly realHome: string;
  readonly data: string;
  readonly bins: readonly string[];
  /**
   * tars chat's child: only a subdirectory of workspace/out, never .evidence, and `requested` is
   * the real path the owner approved, so it must still resolve to exactly itself.
   */
  readonly outRootOnly?: boolean;
}

/** Set by tars chat for the tars it starts; the model has no way to set or clear it. */
export const OUT_ROOT_ONLY_VAR = "TARS_OUT_ROOT_ONLY";

export const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * Where trials and the agent's test runs write, apart from out/, which holds what scripts make
 * for the user. approve and abandon remove a script's part, so test output never piles up.
 */
export const evidenceDir = (data: string, name: string) =>
  join(data, "workspace", ".evidence", name);

export const removeEvidence = (data: string, name: string) =>
  rm(evidenceDir(data, name), { recursive: true, force: true });

/**
 * tars chat approves an --out by its real path under workspace/out. A link at workspace or out
 * would move every such path at once, so neither may be one.
 */
export async function refuseLinkedWorkspace(data: string): Promise<void> {
  for (const dir of [join(data, "workspace"), join(data, "workspace", "out")]) {
    const info = await lstat(dir).catch(() => undefined);
    if (info?.isSymbolicLink() === true)
      throw new TarsError(`${dir} must be a directory, not a link`);
  }
}

export async function prepareOutDir(requested: string, rules: OutDirRules): Promise<string> {
  if (rules.outRootOnly) await refuseLinkedWorkspace(rules.data);
  const outRoot = join(rules.data, "workspace", "out");
  const evidenceRoot = join(rules.data, "workspace", ".evidence");
  await Promise.all([outRoot, evidenceRoot].map((d) => mkdir(d, { recursive: true })));
  const target = resolve(rules.cwd, requested);
  const real = realpathOfExistingAncestorPlusRest;
  const [realLaunch, realOutRoot, realEvidence, realData, realHome] = await Promise.all([
    real(rules.launchDir),
    real(outRoot),
    real(evidenceRoot),
    real(rules.data),
    real(rules.realHome),
  ]);
  const workspaceRoots = rules.outRootOnly ? [realOutRoot] : [realOutRoot, realEvidence];
  const allowed = rules.outRootOnly ? workspaceRoots : [realLaunch, ...workspaceRoots];
  const carvedOut = (path: string) => workspaceRoots.some((root) => within(path, root));
  const forbidden = [realData, ...(await Promise.all(rules.bins.map(real)))];
  const check = (path: string) => {
    const roots = allowed.filter((root) => within(path, root));
    if (roots.length === 0)
      throw new TarsError(
        rules.outRootOnly
          ? `--out ${requested} must be under ${outRoot}`
          : `--out ${requested} must be under ${rules.launchDir}, ${outRoot} or ${evidenceRoot}`,
      );
    // Dot directories in the home hold config, keys and autostart entries; refuse them all.
    const [first = ""] = relative(realHome, path).split(sep);
    const hidden = within(path, realHome) && first.startsWith(".") && !carvedOut(path);
    if (hidden || within(realHome, path))
      throw new TarsError(
        `--out ${requested} overlaps ${hidden ? join(realHome, first) : realHome}`,
      );
    for (const f of forbidden) {
      if ((within(path, f) && !(f === realData && carvedOut(path))) || within(f, path))
        throw new TarsError(`--out ${requested} overlaps ${f}`);
    }
    // The root itself holds the user's project, or every script's output: give one subdirectory.
    if (roots.some((root) => path === root))
      throw new TarsError(
        `--out ${requested} must be a subdirectory, for example ${join(requested, "<name>")}`,
      );
    // sandbox-runtime guards .git/hooks, .vscode and the like only below --out, never --out
    // itself, so a dot directory anywhere below the allowed root cannot be the one handed out.
    const dotted = (root: string) =>
      relative(root, path)
        .split(sep)
        .some((s) => s.startsWith("."));
    if (roots.every(dotted)) throw new TarsError(`--out ${requested} is inside a dot directory`);
  };
  const approved = (path: string) => {
    if (rules.outRootOnly && path !== target)
      throw new TarsError(`--out ${requested} now resolves to ${path}, not the approved path`);
  };
  const before = await real(target);
  check(before);
  approved(before);
  await mkdir(target, { recursive: true });
  const final = await realpath(target);
  check(final);
  approved(final);
  return final;
}

export async function realpathOfExistingAncestorPlusRest(path: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...rest.toReversed());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest.push(existing.slice(parent.length).replace(/^\//, ""));
      existing = parent;
    }
  }
}
