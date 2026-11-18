import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TarsError } from "../../core/exit.ts";

export interface OutDirRules {
  readonly cwd: string;
  readonly launchDir: string;
  readonly realHome: string;
  readonly data: string;
  readonly bins: readonly string[];
}

const within = (path: string, root: string) => {
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

export async function prepareOutDir(requested: string, rules: OutDirRules): Promise<string> {
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
  const allowed = [realLaunch, realOutRoot, realEvidence];
  const carvedOut = (path: string) => within(path, realOutRoot) || within(path, realEvidence);
  const forbidden = [realData, ...(await Promise.all(rules.bins.map(real)))];
  const check = (path: string) => {
    const roots = allowed.filter((root) => within(path, root));
    if (roots.length === 0)
      throw new TarsError(
        `--out ${requested} must be under ${rules.launchDir}, ${outRoot} or ${evidenceRoot}`,
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
    // sandbox-runtime guards .git/hooks, .vscode and the like only below --out, never --out
    // itself, so a dot directory anywhere below the allowed root cannot be the one handed out.
    const dotted = (root: string) =>
      relative(root, path)
        .split(sep)
        .some((s) => s.startsWith("."));
    if (roots.every(dotted)) throw new TarsError(`--out ${requested} is inside a dot directory`);
  };
  check(await real(target));
  await mkdir(target, { recursive: true });
  const final = await realpath(target);
  check(final);
  return final;
}

async function realpathOfExistingAncestorPlusRest(path: string): Promise<string> {
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
