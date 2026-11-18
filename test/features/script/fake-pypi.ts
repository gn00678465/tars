import { createHash } from "node:crypto";

const DAY_MS = 86_400_000;
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

interface Dist {
  readonly bytes: Uint8Array;
  readonly uploaded: Date;
  readonly hashed: boolean;
}

export interface FakePypi {
  /** The simple-API root, the value a Toolchain's index holds. */
  readonly index: string;
  /** Every filename downloaded, in order. */
  readonly downloads: string[];
  /** Serves a pure-Python wheel; `requires` become Requires-Dist lines. */
  wheel(name: string, version: string, opts?: DistOptions & { requires?: readonly string[] }): void;
  sdist(name: string, version: string, opts?: DistOptions): void;
  /** Replaces the bytes behind an already listed file, as a tampered mirror would. */
  tamper(filename: string): void;
  /** Holds downloads of `filename` until `count` of them are waiting, so concurrent builds overlap. */
  hold(filename: string, count: number): void;
  stop(): void;
}

interface DistOptions {
  /** Uploaded this many days ago; default is long before any quarantine. */
  readonly ageDays?: number;
  /** false lists the file without a sha256. */
  readonly hashed?: boolean;
}

/** A PEP 691 JSON index on 127.0.0.1 that serves wheels built in memory. */
export function fakePypi(): FakePypi {
  const files = new Map<string, Map<string, Dist>>();
  const downloads: string[] = [];
  const holds = new Map<string, { count: number; waiting: (() => void)[] }>();
  const add = (name: string, filename: string, bytes: Uint8Array, opts: DistOptions = {}) => {
    const project = normalize(name);
    const listed = files.get(project) ?? new Map<string, Dist>();
    listed.set(filename, {
      bytes,
      uploaded:
        opts.ageDays === undefined ? LONG_AGO : new Date(Date.now() - opts.ageDays * DAY_MS),
      hashed: opts.hashed ?? true,
    });
    files.set(project, listed);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const project = /^\/simple\/([^/]+)\/?$/.exec(path)?.[1];
      if (project !== undefined) {
        const listed = files.get(normalize(project));
        if (!listed) return new Response("not found", { status: 404 });
        return Response.json(
          {
            meta: { "api-version": "1.1" },
            name: normalize(project),
            versions: [],
            files: [...listed].map(([filename, d]) => ({
              filename,
              url: `/files/${filename}`,
              hashes: d.hashed
                ? { sha256: createHash("sha256").update(d.bytes).digest("hex") }
                : {},
              "upload-time": d.uploaded.toISOString(),
            })),
          },
          { headers: { "content-type": "application/vnd.pypi.simple.v1+json" } },
        );
      }
      const filename = /^\/files\/([^/]+)$/.exec(path)?.[1];
      const dist =
        filename === undefined
          ? undefined
          : [...files.values()].find((l) => l.has(filename))?.get(filename);
      if (filename === undefined || dist === undefined)
        return new Response("not found", { status: 404 });
      downloads.push(filename);
      const hold = holds.get(filename);
      if (hold) {
        const released = new Promise<void>((resolve) => hold.waiting.push(resolve));
        if (hold.waiting.length >= hold.count) for (const go of hold.waiting) go();
        await Promise.race([released, Bun.sleep(20_000)]);
      }
      return new Response(dist.bytes);
    },
  });
  return {
    index: `http://127.0.0.1:${server.port}/simple`,
    downloads,
    wheel(name, version, opts = {}) {
      const filename = `${name.replaceAll("-", "_")}-${version}-py3-none-any.whl`;
      add(name, filename, wheelBytes(name, version, opts.requires ?? []), opts);
    },
    sdist(name, version, opts = {}) {
      add(name, `${name}-${version}.tar.gz`, new TextEncoder().encode("not a real sdist"), opts);
    },
    tamper(filename) {
      for (const listed of files.values()) {
        const d = listed.get(filename);
        if (d) listed.set(filename, { ...d, bytes: new Uint8Array([...d.bytes, 0]) });
      }
    },
    hold(filename, count) {
      holds.set(filename, { count, waiting: [] });
    },
    stop: () => void server.stop(true),
  };
}

const normalize = (name: string) => name.toLowerCase().replaceAll(/[-_.]+/g, "-");

function wheelBytes(name: string, version: string, requires: readonly string[]): Uint8Array {
  const pkg = name.replaceAll("-", "_");
  const info = `${pkg}-${version}.dist-info`;
  const entries: [string, string][] = [
    [`${pkg}/__init__.py`, `VERSION = "${version}"\n`],
    [
      `${info}/METADATA`,
      [
        "Metadata-Version: 2.1",
        `Name: ${name}`,
        `Version: ${version}`,
        ...requires.map((r) => `Requires-Dist: ${r}`),
        "",
      ].join("\n"),
    ],
    [
      `${info}/WHEEL`,
      "Wheel-Version: 1.0\nGenerator: tars-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    ],
  ];
  const record = [
    ...entries.map(([path, body]) => {
      const digest = createHash("sha256").update(body).digest("base64url");
      return `${path},sha256=${digest},${Buffer.byteLength(body)}`;
    }),
    `${info}/RECORD,,`,
    "",
  ].join("\n");
  return storedZip([...entries, [`${info}/RECORD`, record]]);
}

/** A zip with every entry stored uncompressed; wheels need nothing more. */
function storedZip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of entries) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const crc = Bun.hash.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, dir, end]));
}
