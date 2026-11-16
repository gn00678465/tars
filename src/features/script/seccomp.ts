import { createHash } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { TarsError } from "../../core/exit.ts";
import { uniqueTemp } from "../../core/fs.ts";

const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const VENDOR = `vendor/seccomp/${ARCH}/apply-seccomp`;

/**
 * sandbox-runtime's seccomp helper, at a path the sandbox can exec. Without it sandbox-runtime
 * only warns and runs the command with Unix sockets unfiltered, so a missing helper is fatal.
 * The name carries the content hash, so two tars versions never overwrite each other's helper.
 */
export async function seccompHelper(
  dataDir: string,
  embedded: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<string> {
  const blob = embedded.find((b) => b.name?.replace(/\.$/, "").endsWith(VENDOR));
  const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : await fromSource();
  const hash = sha256(bytes);
  const path = join(dataDir, "lib", `apply-seccomp-${hash.slice(0, 16)}`);
  const existing = await readFile(path).catch(() => undefined);
  if (existing !== undefined && sha256(existing) === hash) return path;
  await mkdir(dirname(path), { recursive: true });
  const tmp = uniqueTemp(path);
  try {
    await writeFile(tmp, bytes, { mode: 0o755 });
    // A wrong file at path (truncated, edited) is replaced; link() alone would keep it.
    if (existing !== undefined) await rm(path, { force: true });
    await link(tmp, path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  } finally {
    await rm(tmp, { force: true });
  }
  if (sha256(await readFile(path)) !== hash)
    throw new TarsError(`${path} does not match the seccomp helper tars ships; delete it`);
  return path;
}

async function fromSource(): Promise<Uint8Array> {
  const root = dirname(
    createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"),
  );
  return new Uint8Array(await readFile(join(root, VENDOR)));
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
