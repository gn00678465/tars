import { mkdir, realpath } from "node:fs/promises";
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

export async function prepareOutDir(requested: string, rules: OutDirRules): Promise<string> {
  const outRoot = join(rules.data, "workspace", "out");
  await mkdir(outRoot, { recursive: true });
  const allowed = await Promise.all(
    [rules.launchDir, outRoot].map(realpathOfExistingAncestorPlusRest),
  );
  const realOutRoot = allowed[1] ?? outRoot;
  const realData = await realpathOfExistingAncestorPlusRest(rules.data);
  const forbidden = await Promise.all(
    [rules.data, ...rules.bins, join(rules.realHome, ".config"), join(rules.realHome, ".ssh")].map(
      realpathOfExistingAncestorPlusRest,
    ),
  );
  const check = (path: string) => {
    if (!allowed.some((root) => within(path, root)))
      throw new TarsError(`--out ${requested} must be under ${rules.launchDir} or ${outRoot}`);
    for (const f of forbidden) {
      const carvedOut = f === realData && within(path, realOutRoot);
      if ((within(path, f) && !carvedOut) || within(f, path))
        throw new TarsError(`--out ${requested} overlaps ${f}`);
    }
  };
  check(await realpathOfExistingAncestorPlusRest(resolve(rules.cwd, requested)));
  const target = resolve(rules.cwd, requested);
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
