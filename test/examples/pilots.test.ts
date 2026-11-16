import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../helpers.ts";

// What the sandbox never lets happen, run against the pilot scripts directly on /usr/bin/python3.
const PYTHON = "/usr/bin/python3";
const EXAMPLES = join(import.meta.dir, "..", "..", "examples", "scripts");
const FILE = new Uint8Array(300_000).fill(7);
const userNamespaces =
  existsSync(PYTHON) && Bun.spawnSync(["unshare", "-rm", "true"]).exitCode === 0;

async function python(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(args, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tempHome(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("bark-push", () => {
  test.skipIf(!existsSync(PYTHON)).each(["", "ftp://127.0.0.1:9/", "not a url", "http://[::1"])(
    "a secret url %p that is not http or https ends with the declared 3 and no traceback",
    async (url) => {
      const run = await python(
        [PYTHON, "-I", join(EXAMPLES, "bark-push", "script.py"), "--body", "b"],
        { TARS_SECRET: JSON.stringify({ url, key: "k" }) },
      );
      expect(run.exitCode).toBe(3);
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
      expect(run.stderr).not.toContain("Traceback");
    },
  );
});

describe("download", () => {
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(FILE) });
  afterAll(() => void site.stop(true));

  /** Downloads FILE into a fresh tmpfs of `size` used as --out, and lists what is left there. */
  const intoTmpfs = (size: string) =>
    python(
      [
        "unshare",
        "-rm",
        "sh",
        "-c",
        'mount -t tmpfs -o size="$1" none "$2" && TARS_OUT="$2" "$3" -I "$4" "$5"; code=$?; echo "left: $(ls -A "$2")"; exit $code',
        "sh",
        size,
        tempHome(),
        PYTHON,
        join(EXAMPLES, "download", "script.py"),
        `http://127.0.0.1:${site.port}/file.bin`,
      ],
      {},
    );

  test.skipIf(!userNamespaces)("saves the file when --out has room", async () => {
    const run = await intoTmpfs("1m");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("left: file.bin");
  });

  test.skipIf(!userNamespaces)(
    "a disk that fills while saving ends with the declared 1 and leaves nothing in --out",
    async () => {
      const run = await intoTmpfs("64k");
      expect(run.exitCode).toBe(1);
      expect(run.stdout.trim()).toBe("left:");
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
      expect(run.stderr).not.toContain("Traceback");
    },
  );
});
