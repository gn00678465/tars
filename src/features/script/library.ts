import { randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename } from "node:fs/promises";
import { join, sep } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { sha256 } from "../../core/hash.ts";
import { requireScriptMeta, SLUG, type ScriptMeta } from "./metadata.ts";

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
  readonly versionDir: string;
  readonly version: string;
  readonly source: string;
  readonly meta: ScriptMeta;
}

declare const brand: unique symbol;

/** Names versions/<id>/. Only versionId makes one, from the hashes of the two files in it. */
export type VersionId = string & { readonly [brand]: "VersionId" };

// Hashing the two digests, not the joined bytes, so moving bytes between the script and the lock
// cannot produce the same id.
export const versionId = (scriptSha: string, lockSha: string): VersionId =>
  sha256(`${scriptSha}\n${lockSha}\n`).slice(0, 16) as VersionId;

/** What a submission of `name` would replace. */
export type LibraryBase =
  | { readonly kind: "none" }
  | { readonly kind: "current"; readonly script: LibraryScript }
  | { readonly kind: "broken"; readonly reason: string };

export interface BrokenScript {
  readonly name: string;
  readonly reason: string;
}

export interface RunRecord {
  readonly time: string;
  readonly version: string;
  readonly argsSha256: string;
  readonly exit: number;
  readonly ms: number;
}

export async function loadScript(layout: ScriptsLayout, name: string): Promise<LibraryScript> {
  if (!SLUG.test(name)) throw new TarsError(`invalid script name ${JSON.stringify(name)}`);
  const dir = join(layout.library, name);
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
  const meta = requireScriptMeta(source, `${name}: `);
  if (meta.name !== name) throw new TarsError(`${name}: script.py declares name ${meta.name}`);
  return { name, dir, versionDir, version: versionDir.slice(versions.length), source, meta };
}

export async function libraryBase(layout: ScriptsLayout, name: string): Promise<LibraryBase> {
  if ((await lstat(join(layout.library, name)).catch(() => undefined)) === undefined)
    return { kind: "none" };
  try {
    return { kind: "current", script: await loadScript(layout, name) };
  } catch (err) {
    if (!(err instanceof TarsError)) throw err;
    return { kind: "broken", reason: err.message };
  }
}

const gone = (name: string) =>
  new TarsError(`no script named ${name}. Find one with: tars script search <words>`);

async function noScriptOnEnoent<T>(script: LibraryScript, write: () => Promise<T>): Promise<T> {
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
  await noScriptOnEnoent(script, () => appendFile(join(script.dir, "NOTES.md"), line));
}

export async function retireScript(
  layout: ScriptsLayout,
  script: LibraryScript,
  now: Date,
): Promise<string> {
  await mkdir(layout.retired, { recursive: true });
  const target = join(layout.retired, `${script.name}-${uniqueStamp(now)}`);
  await noScriptOnEnoent(script, () => rename(script.dir, target));
  return target;
}

export const uniqueStamp = (now: Date) =>
  `${now.toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}
