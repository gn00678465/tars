import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TarsError } from "../../core/exit.ts";

export interface OutDirRules {
  /** Where tars resolves a relative --out; the session's working directory. */
  readonly cwd: string;
  /** The directory the session was started from (TARS_LAUNCH_DIR); the user's own files. */
  readonly launchDir: string;
  /** From the account database, not HOME: `tars agy` points HOME at a directory of its own. */
  readonly realHome: string;
  readonly data: string;
  readonly bins: readonly string[];
}

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * Creates the directory a script may write and returns its real path. It must sit under the
 * launch dir or <data>/workspace/out, and it may neither sit inside nor contain the data dir,
 * a bin dir, ~/.config or ~/.ssh: a parent such as ~ would expose them to the script.
 */
export async function prepareOutDir(requested: string, rules: OutDirRules): Promise<string> {
  const outRoot = join(rules.data, "workspace", "out");
  await mkdir(outRoot, { recursive: true });
  const allowed = await Promise.all([rules.launchDir, outRoot].map(real));
  const realOutRoot = allowed[1] ?? outRoot;
  const realData = await real(rules.data);
  const forbidden = await Promise.all(
    [rules.data, ...rules.bins, join(rules.realHome, ".config"), join(rules.realHome, ".ssh")].map(
      real,
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
  // Check before creating anything, then again on the real path: a symlink on the way could
  // land the directory somewhere the lexical check never saw.
  check(await real(resolve(rules.cwd, requested)));
  const target = resolve(rules.cwd, requested);
  await mkdir(target, { recursive: true });
  const final = await realpath(target);
  check(final);
  return final;
}

/** The real path of the deepest existing ancestor, with the rest appended. */
async function real(path: string): Promise<string> {
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
