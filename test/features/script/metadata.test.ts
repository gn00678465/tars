import { describe, expect, test } from "bun:test";
import { parseScriptMeta, ScriptMetaError } from "../../../src/features/script/metadata.ts";
import { sampleScript } from "./sample.ts";

const TARS = [
  'name = "dl"',
  'summary = "下載檔案"',
  'effects = "local-write"',
  'args = "<網址>"',
  'outputs = "存檔路徑"',
  'exit = { 0 = "ok" }',
];

function problems(source: string): string {
  try {
    parseScriptMeta(source);
  } catch (err) {
    if (err instanceof ScriptMetaError) return err.message;
    throw err;
  }
  throw new Error("expected the metadata to be rejected");
}

describe("parseScriptMeta", () => {
  test("reads a valid block, extras included", () => {
    const meta = parseScriptMeta(sampleScript());
    expect(meta.name).toBe("bark-push");
    expect(meta.secret).toBe("bark");
    expect(meta.domains).toEqual([{ kind: "secret-url" }]);
    expect(meta.dependencies).toEqual(["httpx[http2]==0.28.1"]);
    expect([...meta.exit.keys()]).toEqual([0, 1, 3]);
  });

  test("hosts carry their port", () => {
    const meta = parseScriptMeta(
      sampleScript({ tarsLines: [...TARS, 'domains = ["api.example.com", "127.0.0.1:5000"]'] }),
    );
    expect(meta.domains).toEqual([
      { kind: "host", host: "api.example.com" },
      { kind: "host", host: "127.0.0.1", port: 5000 },
    ]);
  });

  test("two script blocks are rejected so tars and uv cannot read different ones", () => {
    expect(problems(sampleScript() + sampleScript())).toContain("2 `# /// script` blocks");
  });

  test("a missing block is rejected", () => {
    expect(problems("print('hi')\n")).toContain("no `# /// script`");
  });

  test("[tool.uv] is rejected because it can point uv at another index", () => {
    const source = sampleScript().replace(
      "# [tool.tars]",
      '# [tool.uv]\n# index-url = "x"\n#\n# [tool.tars]',
    );
    expect(problems(source)).toContain("[tool.uv] is not allowed");
  });

  test("other top-level keys are rejected", () => {
    expect(problems(sampleScript({ extraTop: 'index-url = "https://evil"' }))).toContain(
      "`index-url` is not allowed",
    );
  });

  test.each([
    "pkg @ https://example.com/pkg.whl",
    "git+https://example.com/pkg",
    "./local/pkg",
    'pkg==1.0; python_version < "3.13"',
  ])("dependency %p is rejected", (dep) => {
    const source = sampleScript().replace('"httpx[http2]==0.28.1"', JSON.stringify(dep));
    expect(problems(source)).toContain("must be a PyPI name");
  });

  test.each(["../etc", "Bark", "-x"])("name %p is rejected", (name) => {
    expect(problems(sampleScript({ name }))).toContain(`name "${name}" must match`);
  });

  test("a secret name with a slash is rejected", () => {
    const source = sampleScript().replace('secret = "bark"', 'secret = "../claude-oauth-token"');
    expect(problems(source)).toContain('secret "../claude-oauth-token" must match');
  });

  test.each([
    ["124", "tars uses 124 and up"],
    ["-1", "must be 0 to 123"],
  ])("exit code %p is rejected", (code, message) => {
    const source = sampleScript().replace('3 = "金鑰被拒"', `${code} = "x"`);
    expect(problems(source)).toContain(message);
  });

  test("exit must describe code 0", () => {
    expect(problems(sampleScript().replace('0 = "送出", ', ""))).toContain("describe code 0");
  });

  test('"*" with a secret is rejected (r49)', () => {
    expect(problems(sampleScript().replace('["secret:url"]', '["*"]'))).toContain(
      "only for scripts without a secret",
    );
  });

  test('"secret:url" without a secret is rejected', () => {
    expect(problems(sampleScript({ tarsLines: [...TARS, 'domains = ["secret:url"]'] }))).toContain(
      "needs a secret",
    );
  });

  test("localhost is rejected with the IP literal to use instead", () => {
    expect(
      problems(sampleScript({ tarsLines: [...TARS, 'domains = ["localhost:3000"]'] })),
    ).toContain("write 127.0.0.1:<port>");
  });

  test("unknown [tool.tars] keys and a missing effects are all reported at once", () => {
    const lines = TARS.filter((l) => !l.startsWith("effects")).concat('efects = "read-only"');
    const message = problems(sampleScript({ tarsLines: lines }));
    expect(message).toContain("unknown key `efects`");
    expect(message).toContain("effects must be one of");
  });

  test("CRLF line endings read the same block as LF", () => {
    expect(parseScriptMeta(sampleScript().replaceAll("\n", "\r\n")).name).toBe("bark-push");
  });

  test("a second block hidden behind CRLF is still counted", () => {
    const hidden = sampleScript({ extraTop: "[tool.uv]" }).replaceAll("\n", "\r\n");
    expect(problems(sampleScript() + hidden)).toContain("2 `# /// script` blocks");
  });

  test("U+2028 is rejected because JS and Python split lines on it differently", () => {
    expect(problems(sampleScript().replace("import sys", "x = 1\u2028"))).toContain("U+2028");
  });

  test.each([
    ["999.999.999.999", "not a lowercase host name or IPv4"],
    ["127.1", "not a lowercase host name or IPv4"],
    ["api.example.com:0", "port must be 1 to 65535"],
    ["api.example.com:65536", "port must be 1 to 65535"],
    ["::1", "IPv6 is not supported"],
  ])("domain %p is rejected", (domain, message) => {
    expect(problems(sampleScript({ tarsLines: [...TARS, `domains = ["${domain}"]`] }))).toContain(
      message,
    );
  });

  test('"*" next to another domain is rejected', () => {
    expect(
      problems(sampleScript({ tarsLines: [...TARS, 'domains = ["*", "example.com"]'] })),
    ).toContain('"*" must be the only entry');
  });
});
