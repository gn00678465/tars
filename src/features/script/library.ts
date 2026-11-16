import { randomBytes } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { ensureSymlink, uniqueTemp, writeFileAtomic } from "../../core/fs.ts";
import { sha256 } from "../../core/hash.ts";
import type { PackageName } from "./lock.ts";
import { isRecord, requireScriptMeta, SLUG, type ScriptMeta } from "./metadata.ts";
import { approvePackages, ensureVenv, LOCK_FILE, type Toolchain } from "./supply.ts";

export interface ScriptsLayout {
  readonly library: string;
  readonly retired: string;
  readonly searches: string;
  /** Where approve builds a version before it enters library/; the same filesystem, so rename works. */
  readonly staging: string;
}

export function scriptsLayout(root: string): ScriptsLayout {
  return {
    library: join(root, "library"),
    retired: join(root, "retired"),
    searches: join(root, "searches.jsonl"),
    staging: join(root, "staging"),
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

/** The two fields every run depends on. */
export interface ApprovalHashes {
  readonly script: string;
  readonly lock: string;
}

/** Arguments are stored as a hash, as in runs.jsonl: they may hold private text. */
export interface RunSummary {
  readonly time: string;
  readonly argsSha256: string;
  readonly exit: number;
}

/** approval.json as approve writes it. Code reads only the two hashes; the rest is the record of what the user was shown. */
export interface ApprovalRecord extends ApprovalHashes {
  /** When the user confirmed. */
  readonly time: string;
  readonly gate1: { readonly time: string; readonly packages: number };
  readonly gate2: {
    readonly trials: readonly RunSummary[];
    readonly ignoredTrials: number;
    readonly review: { readonly time: string; readonly report: string } | null;
  };
  readonly gate3: {
    /** Runs with the real secret during this approval. */
    readonly liveRuns: readonly RunSummary[];
    readonly newPackages: readonly string[];
    readonly replaced: string | null;
  };
}

/**
 * The hashes approval.json records when they match `source` (what was read from script.py) and
 * the lock in `versionDir`; otherwise why the version must not run.
 */
export async function checkApproval(
  versionDir: string,
  source: string,
): Promise<ApprovalHashes | string> {
  let approval: unknown;
  try {
    approval = JSON.parse(await readFile(join(versionDir, "approval.json"), "utf8"));
  } catch {
    return "approval.json is missing or unreadable";
  }
  if (!isRecord(approval)) return "approval.json is not an object";
  const lock = await readFile(join(versionDir, LOCK_FILE)).catch(() => undefined);
  if (lock === undefined) return `${LOCK_FILE} is missing`;
  const { script, lock: lockSha } = approval;
  if (script !== sha256(source)) return "script.py changed after approval";
  if (lockSha !== sha256(lock)) return `${LOCK_FILE} changed after approval`;
  return { script, lock: lockSha };
}

/**
 * A version directory built from memory under staging/. Only stageVersion makes one. Gate 3's
 * live run executes it and installVersion renames the same directory into the library, so what
 * the user tried is what gets installed.
 */
export interface StagedVersion {
  readonly [brand]: "StagedVersion";
  readonly name: string;
  readonly version: VersionId;
  readonly dir: string;
}

/** Longer than any approve keeps a staged version; older ones were left by a killed approve. */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

/**
 * The venv is built here from the lock text approve holds, never copied from pending/: nothing
 * hashes a pending venv, while `pip --require-hashes` ties this one to the reviewed lock.
 */
export async function stageVersion(
  layout: ScriptsLayout,
  files: {
    readonly name: string;
    readonly version: VersionId;
    readonly source: string;
    readonly lockText: string;
  },
  toolchain: Toolchain,
  now: Date,
): Promise<StagedVersion> {
  await mkdir(layout.staging, { recursive: true });
  for (const entry of await readdir(layout.staging)) {
    const path = join(layout.staging, entry);
    const age = now.getTime() - ((await lstat(path).catch(() => undefined))?.mtimeMs ?? Infinity);
    if (age > STALE_STAGING_MS) await rm(path, { recursive: true, force: true });
  }
  const dir = join(layout.staging, uniqueStamp(now));
  await mkdir(dir);
  try {
    await writeFile(join(dir, "script.py"), files.source);
    await writeFile(join(dir, LOCK_FILE), files.lockText);
    await ensureVenv(dir, toolchain);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const staged: Omit<StagedVersion, typeof brand> = {
    name: files.name,
    version: files.version,
    dir,
  };
  return staged as StagedVersion;
}

export const discardStaged = (staged: StagedVersion) =>
  rm(staged.dir, { recursive: true, force: true });

/**
 * Puts a staged version into the library. Every step looks at what is on disk, so after a kill
 * at any point the next approve of the same bytes finishes the rest: approval.json is written
 * before the directory gets its final name, the packages are approved before `current` moves,
 * and a valid versions/<id>/ found in place is kept but still gets this approval's record, its
 * packages and the switch of `current`.
 *
 * A run that resolved `current` earlier keeps the version directory it resolved. NOTES.md and
 * runs.jsonl sit beside versions/ and are not touched.
 */
export async function installVersion(
  layout: ScriptsLayout,
  scriptsDir: string,
  staged: StagedVersion,
  approval: ApprovalRecord,
  newPackages: readonly PackageName[],
): Promise<"installed" | "reused"> {
  const home = join(layout.library, staged.name);
  const target = join(home, "versions", staged.version);
  const record = `${JSON.stringify(approval, null, 2)}\n`;
  await writeFileAtomic(join(staged.dir, "approval.json"), record);
  await mkdir(join(home, "versions"), { recursive: true });
  let outcome: "installed" | "reused" = "installed";
  try {
    await rename(staged.dir, target);
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
    if (await holds(target, approval)) {
      await writeFileAtomic(join(target, "approval.json"), record);
      await rm(staged.dir, { recursive: true, force: true });
      outcome = "reused";
    } else {
      const invalid = uniqueTemp(join(layout.staging, staged.version));
      await rename(target, invalid);
      await rm(invalid, { recursive: true, force: true });
      await rename(staged.dir, target);
    }
  }
  await approvePackages(scriptsDir, newPackages);
  await ensureSymlink(join("versions", staged.version), join(home, "current"));
  return outcome;
}

/** Whether `versionDir` is an approved version of exactly these two files. */
async function holds(versionDir: string, hashes: ApprovalHashes): Promise<boolean> {
  const source = await readFile(join(versionDir, "script.py"), "utf8").catch(() => undefined);
  if (source === undefined) return false;
  const approved = await checkApproval(versionDir, source);
  return (
    typeof approved !== "string" &&
    approved.script === hashes.script &&
    approved.lock === hashes.lock
  );
}
