import { isRecord } from "./metadata.ts";

declare const brand: unique symbol;

/** PEP 503 normalized: lowercase letters, digits and single hyphens, so it is also a safe file name. */
export type PackageName = string & { readonly [brand]: "PackageName" };

export interface Pin {
  readonly name: PackageName;
  readonly version: string;
}

/** A script.py.lock that passed the source, hash and age policy. Only parseLock makes one. */
export interface Lock {
  readonly [brand]: "Lock";
  /** The bytes parsed; approval hashes these, never a second read of the file. */
  readonly text: string;
  /** Direct and indirect dependencies, sorted by name. */
  readonly pins: readonly Pin[];
}

export type LockProblem =
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "foreign-source"; readonly name: PackageName; readonly source: string }
  | { readonly kind: "no-wheel"; readonly name: PackageName }
  | { readonly kind: "no-hash"; readonly name: PackageName; readonly file: string }
  | { readonly kind: "no-age-rule" };

export type ParsedLock =
  | { readonly ok: true; readonly lock: Lock }
  | { readonly ok: false; readonly problems: readonly LockProblem[] };

/** uv skips versions uploaded within this span. Lock and export must both pass it or `--locked` fails. */
export const QUARANTINE = "P7D";

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Reports every problem, not the first, so the author fixes them in one round. Pure. */
export function parseLock(text: string, index: string): ParsedLock {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (err) {
    return malformed(`not TOML: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) return malformed("not a table");
  const problems: LockProblem[] = [];
  // uv 0.13.8 writes the relative exclude-newer under [options].
  if (!isRecord(doc.options) || doc.options["exclude-newer-span"] !== QUARANTINE)
    problems.push({ kind: "no-age-rule" });
  const packages = doc.package ?? [];
  if (!Array.isArray(packages)) return malformed("[[package]] is not an array");
  const pins: Pin[] = [];
  for (const entry of packages) {
    if (!isRecord(entry)) return malformed("a [[package]] is not a table");
    const { name: raw, version, source, wheels = [], sdist } = entry;
    if (typeof raw !== "string" || !NAME.test(raw))
      return malformed(`package name ${JSON.stringify(raw)} is not valid`);
    const name = normalizeName(raw);
    if (typeof version !== "string" || version === "") return malformed(`${name} has no version`);
    if (!Array.isArray(wheels)) return malformed(`${name}: wheels is not an array`);
    pins.push({ name, version });
    if (!isRecord(source) || Object.keys(source).length !== 1 || source.registry !== index)
      problems.push({ kind: "foreign-source", name, source: JSON.stringify(source) });
    if (wheels.length === 0) problems.push({ kind: "no-wheel", name });
    for (const file of sdist === undefined ? wheels : [...wheels, sdist]) {
      const hashed =
        isRecord(file) && typeof file.hash === "string" && /^sha256:[0-9a-f]{64}$/.test(file.hash);
      if (!hashed)
        problems.push({
          kind: "no-hash",
          name,
          file: isRecord(file) && typeof file.url === "string" ? file.url : JSON.stringify(file),
        });
    }
  }
  pins.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, lock: { text, pins } as unknown as Lock };
}

export function normalizeName(raw: string): PackageName {
  return raw.toLowerCase().replaceAll(/[-_.]+/g, "-") as PackageName;
}

function malformed(detail: string): ParsedLock {
  return { ok: false, problems: [{ kind: "malformed", detail }] };
}
