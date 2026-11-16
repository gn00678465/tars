import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SampleMeta {
  readonly name?: string;
  readonly extraTop?: string;
  readonly tarsLines?: readonly string[];
}

/** A PEP 723 script whose [tool.tars] table is valid unless a test overrides its lines. */
export function sampleScript(opts: SampleMeta = {}): string {
  const tars = opts.tarsLines ?? [
    `name = "${opts.name ?? "bark-push"}"`,
    'summary = "推播一則通知到手機"',
    'secret = "bark"',
    'domains = ["secret:url"]',
    'effects = "external-write"',
    'args = "--title <文字> --body <文字>"',
    'outputs = "一行 JSON"',
    'exit = { 0 = "送出", 1 = "失敗", 3 = "金鑰被拒" }',
  ];
  return [
    "# /// script",
    '# requires-python = ">=3.12"',
    '# dependencies = ["httpx[http2]==0.28.1"]',
    ...(opts.extraTop ? [`# ${opts.extraTop}`] : []),
    "#",
    "# [tool.tars]",
    ...tars.map((l) => `# ${l}`),
    "# ///",
    "import sys",
    "sys.exit(0)",
    "",
  ].join("\n");
}

/** Lays out library/<name>/versions/<version>/script.py with current pointing at it. */
export function installSample(
  scriptsDir: string,
  name: string,
  source = sampleScript({ name }),
  version = "0123456789abcdef",
): string {
  const dir = join(scriptsDir, "library", name);
  mkdirSync(join(dir, "versions", version), { recursive: true });
  writeFileSync(join(dir, "versions", version, "script.py"), source);
  symlinkSync(join("versions", version), join(dir, "current"));
  return dir;
}
