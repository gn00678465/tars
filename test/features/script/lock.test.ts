import { describe, expect, test } from "bun:test";
import { parseLock, type LockProblem } from "../../../src/features/script/lock.ts";

const INDEX = "https://pypi.org/simple";
const HASH = `sha256:${"a".repeat(64)}`;

const HEADER = `version = 1
revision = 5
requires-python = ">=3.12"

[options]
exclude-newer = "0001-01-01T00:00:00Z"
exclude-newer-span = "P7D"
`;

function pkg(name: string, fields: Partial<Record<"source" | "wheels" | "sdist", string>> = {}) {
  return `
[[package]]
name = "${name}"
version = "1.0"
source = ${fields.source ?? `{ registry = "${INDEX}" }`}
${fields.sdist === undefined ? "" : `sdist = ${fields.sdist}\n`}wheels = ${fields.wheels ?? `[{ url = "https://files.example/${name}-1.0-py3-none-any.whl", hash = "${HASH}" }]`}
`;
}

const problems = (text: string): readonly LockProblem[] => {
  const parsed = parseLock(text, INDEX);
  return parsed.ok ? [] : parsed.problems;
};

describe("parseLock", () => {
  test("accepts a lock from the index, with names normalized and sorted", () => {
    const text =
      HEADER + pkg("Zeta_Pkg") + pkg("alpha", { sdist: `{ url = "x", hash = "${HASH}" }` });
    const parsed = parseLock(text, INDEX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lock.text).toBe(text);
    expect(parsed.lock.pins).toEqual([
      { name: "alpha", version: "1.0" },
      { name: "zeta-pkg", version: "1.0" },
    ] as never);
  });

  test("accepts the lock of a script without dependencies", () => {
    const parsed = parseLock(HEADER, INDEX);
    expect(parsed.ok && parsed.lock.pins).toEqual([]);
  });

  test.each([
    ["url", `{ url = "https://example.com/a.whl" }`],
    ["git", `{ git = "https://example.com/a.git" }`],
    ["path", `{ path = "a.whl" }`],
    ["directory", `{ directory = "a" }`],
    ["editable", `{ editable = "a" }`],
    ["virtual", `{ virtual = "." }`],
    ["another registry", `{ registry = "https://mirror.example/simple" }`],
    ["the index plus another key", `{ registry = "${INDEX}", url = "x" }`],
  ])("refuses a %s source", (_, source) => {
    expect(problems(HEADER + pkg("alpha", { source }))).toEqual([
      { kind: "foreign-source", name: "alpha", source: expect.any(String) },
    ] as never);
  });

  test("refuses a wheel or an sdist without a sha256", () => {
    expect(problems(HEADER + pkg("alpha", { wheels: `[{ url = "w.whl" }]` }))).toEqual([
      { kind: "no-hash", name: "alpha", file: "w.whl" },
    ] as never);
    expect(
      problems(HEADER + pkg("alpha", { sdist: `{ url = "s.tar.gz", hash = "md5:00" }` })),
    ).toEqual([{ kind: "no-hash", name: "alpha", file: "s.tar.gz" }] as never);
  });

  test("refuses a package without a wheel", () => {
    const sdistOnly = `
[[package]]
name = "gamma"
version = "1.0"
source = { registry = "${INDEX}" }
sdist = { url = "g.tar.gz", hash = "${HASH}" }
`;
    expect(problems(HEADER + sdistOnly)).toEqual([{ kind: "no-wheel", name: "gamma" }] as never);
    expect(problems(HEADER + pkg("alpha", { wheels: "[]" }))).toEqual([
      { kind: "no-wheel", name: "alpha" },
    ] as never);
  });

  test.each([
    ["missing", 'version = 1\nrequires-python = ">=3.12"\n'],
    ["another span", HEADER.replace('"P7D"', '"P1D"')],
    ["only at the top level", 'version = 1\nexclude-newer-span = "P7D"\n'],
  ])("refuses a lock whose exclude-newer-span is %s", (_, text) => {
    expect(problems(text)).toEqual([{ kind: "no-age-rule" }]);
  });

  test("reports every problem together", () => {
    const text =
      "version = 1\n" +
      pkg("alpha", { source: `{ git = "https://example.com/a.git" }` }) +
      pkg("beta", { wheels: `[{ url = "b.whl" }]` }) +
      pkg("gamma", { wheels: "[]" });
    expect(problems(text).map((p) => p.kind)).toEqual([
      "no-age-rule",
      "foreign-source",
      "no-hash",
      "no-wheel",
    ]);
  });

  test.each([
    ["not TOML", "version = = 1"],
    ["a package name that is not a name", HEADER + pkg("../evil")],
    ["a package without a version", `${HEADER}\n[[package]]\nname = "a"\n`],
    ["wheels that are not an array", HEADER + pkg("alpha", { wheels: '"x"' })],
  ])("reports %s as malformed", (_, text) => {
    expect(problems(text)).toEqual([{ kind: "malformed", detail: expect.any(String) }] as never);
  });
});
