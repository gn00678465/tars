import { randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename } from "node:fs/promises";
import { join, sep } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { parseScriptMeta, ScriptMetaError, SLUG, type ScriptMeta } from "./metadata.ts";

/**
 * <scripts>/library/<name>/current -> versions/<hash>; NOTES.md and runs.jsonl sit beside
 * `current` so they survive updates.
 */
export interface ScriptsLayout {
  readonly library: string;
  readonly retired: string;
  readonly searches: string;
}

export function scriptsLayout(root: string): ScriptsLayout {
  return {
    library: join(root, "library"),
    retired: join(root, "retired"),
    searches: join(root, "searches.jsonl"),
  };
}

export interface LibraryScript {
  readonly name: string;
  readonly dir: string;
  /** The resolved versions/<hash> directory; callers use it, never `current`, so an update mid-run cannot mix versions. */
  readonly versionDir: string;
  readonly version: string;
  readonly source: string;
  readonly meta: ScriptMeta;
}

export interface BrokenScript {
  readonly name: string;
  readonly reason: string;
}

export interface RunRecord {
  readonly time: string;
  readonly version: string;
  /** sha256 of the JSON argument list: repeated calls show up without logging what was passed. */
  readonly args: string;
  readonly exit: number;
  readonly ms: number;
}

export async function loadScript(layout: ScriptsLayout, name: string): Promise<LibraryScript> {
  if (!SLUG.test(name)) throw new TarsError(`invalid script name ${JSON.stringify(name)}`);
  const dir = join(layout.library, name);
  // A symlink at library/<name> would move the whole script, versions included, out of the library.
  const entry = await lstat(dir).catch(() => undefined);
  if (entry === undefined) throw gone(name);
  if (!entry.isDirectory()) throw new TarsError(`${name}: ${dir} is not a directory`);
  const versions = (await realpath(dir)) + sep + "versions" + sep;
  const versionDir = await realpath(join(dir, "current")).catch(() => {
    throw new TarsError(`${name}: ${join(dir, "current")} does not resolve`);
  });
  if (!versionDir.startsWith(versions) || versionDir.slice(versions.length).includes(sep))
    throw new TarsError(`${name}: current points outside ${versions}`);
  const source = await readFile(join(versionDir, "script.py"), "utf8").catch(() => {
    throw new TarsError(`${name}: cannot read ${join(versionDir, "script.py")}`);
  });
  let meta: ScriptMeta;
  try {
    meta = parseScriptMeta(source);
  } catch (err) {
    if (err instanceof ScriptMetaError) throw new TarsError(`${name}: ${err.message}`);
    throw err;
  }
  if (meta.name !== name) throw new TarsError(`${name}: script.py declares name ${meta.name}`);
  return { name, dir, versionDir, version: versionDir.slice(versions.length), source, meta };
}

const gone = (name: string) =>
  new TarsError(`no script named ${name}. Find one with: tars script search <words>`);

/** Another session may retire the script between loadScript and this write. */
async function inScript<T>(script: LibraryScript, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw gone(script.name);
    throw err;
  }
}

export async function listScripts(
  layout: ScriptsLayout,
): Promise<{ scripts: LibraryScript[]; broken: BrokenScript[] }> {
  const names = await readdir(layout.library).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const scripts: LibraryScript[] = [];
  const broken: BrokenScript[] = [];
  for (const name of names.toSorted()) {
    try {
      scripts.push(await loadScript(layout, name));
    } catch (err) {
      if (!(err instanceof TarsError)) throw err;
      broken.push({ name, reason: err.message });
    }
  }
  return { scripts, broken };
}

export const readNotes = (script: LibraryScript) =>
  readFile(join(script.dir, "NOTES.md"), "utf8").catch(() => "");

export interface SearchHit {
  readonly script: LibraryScript;
  readonly matched: number;
}

/** Any term matches; more matched terms rank higher. Every search is logged to see what agents look for. */
export async function searchScripts(
  layout: ScriptsLayout,
  terms: readonly string[],
  now: Date,
): Promise<SearchHit[]> {
  const { scripts } = await listScripts(layout);
  const needles = terms.map((t) => t.toLowerCase());
  const hits: SearchHit[] = [];
  for (const script of scripts) {
    const { name, summary, args } = script.meta;
    const haystack = [name, summary, args, await readNotes(script)].join("\n").toLowerCase();
    const matched = needles.filter((n) => haystack.includes(n)).length;
    if (matched > 0) hits.push({ script, matched });
  }
  hits.sort((a, b) => b.matched - a.matched || a.script.name.localeCompare(b.script.name));
  await appendJsonLine(layout.searches, {
    time: now.toISOString(),
    terms,
    hits: hits.map((h) => h.script.name),
  });
  return hits;
}

export async function recentRuns(script: LibraryScript, count: number): Promise<RunRecord[]> {
  const text = await readFile(join(script.dir, "runs.jsonl"), "utf8").catch(() => "");
  // A run killed mid-write can leave a partial last line; skip it rather than hide every run.
  const runs = text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as RunRecord];
    } catch {
      return [];
    }
  });
  return runs.slice(-count);
}

export async function addNote(script: LibraryScript, text: string, now: Date): Promise<void> {
  const line = `- ${now.toISOString().slice(0, 10)} ${text}\n`;
  await inScript(script, () => appendFile(join(script.dir, "NOTES.md"), line));
}

/** Moves the whole script, history included, out of the library. Returns where it went. */
export async function retireScript(
  layout: ScriptsLayout,
  script: LibraryScript,
  now: Date,
): Promise<string> {
  await mkdir(layout.retired, { recursive: true });
  const stamp = now.toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
  const target = join(layout.retired, `${script.name}-${stamp}-${randomBytes(3).toString("hex")}`);
  await inScript(script, () => rename(script.dir, target));
  return target;
}

/** O_APPEND with one short write per line, so concurrent sessions never interleave lines. */
async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}
