import { describe, expect, test } from "bun:test";
import {
  applyPatch,
  looksSecret,
  parsePage,
  parsePagePath,
  parsePatch,
  renderPage,
  type ApplyContext,
  type BatchCandidate,
  type Entry,
  type Page,
  type Patch,
} from "../../../src/features/wiki/page.ts";

const A = "a1b2c3d4/9f8e7d6c";
const B = "0e1f2a3b/4c5d6e7f";
const C = "0e1f2a3b/11223344";
const D = "deadbeef/00112233";

const e = (id: number, text: string, sources: string[], assistant = false): Entry => ({
  id,
  text,
  sources,
  assistant,
  temp: false,
});

const BASE: Page = {
  path: "people/wang-xiaoming",
  type: "people",
  title: "王小明",
  aliases: ["小明", "Ming"],
  created: "2026-11-20",
  updated: "2026-12-02",
  summary: `在台積電做製程整合。 [[source:${A}]]`,
  facts: [e(1, "2026-12-14 搬家到台中西屯。", [A]), e(2, "生日是 3 月 9 日。", [B])],
  open: [e(3, "可能在 2027 年換工作。", [C], true)],
  related: ["projects/moving"],
  changeLog: ["2026-11-20 建立。"],
  nextItem: 4,
};

const CANDS: BatchCandidate[] = [
  { key: "c41", speaker: "owner", source: D },
  { key: "c42", speaker: "assistant", source: D },
];

const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
  candidates: CANDS,
  today: "2026-12-05",
  turnExists: () => true,
  pageKnown: (p) => p === "projects/moving" || p === "topics/tsmc",
  externalChange: false,
  isNew: false,
  ...over,
});

const keep = { keep: true } as const;
const patch = (p: Partial<Patch>): Patch => ({
  summary: keep,
  facts: [],
  open: [],
  dropped: [],
  ...p,
});
/** Both candidates placed: c41 as a fact, c42 in open. */
const BOTH: Patch = patch({
  facts: [{ op: "add", text: "在新竹上班。", from: ["c41"] }],
  open: [{ op: "add", text: "可能升職。", from: ["c42"] }],
});

function rejects(p: Patch, reason: string, over: Partial<ApplyContext> = {}) {
  const before = structuredClone(BASE);
  const r = applyPatch(BASE, p, ctx(over));
  expect(r).toEqual({ ok: false, reason } as never);
  expect(BASE).toEqual(before);
}

function applies(p: Patch, over: Partial<ApplyContext> = {}, page = BASE) {
  const r = applyPatch(page, p, ctx(over));
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r;
}

const reparse = (page: Page) => {
  const r = parsePage(renderPage(page), page.path, page.nextItem);
  if (!r.ok) throw new Error(r.error);
  return r.page;
};

describe("parsePage and renderPage", () => {
  test("a page sync wrote reads back the same, and renders the same bytes", () => {
    const text = renderPage(BASE);
    expect(reparse(BASE)).toEqual(BASE);
    expect(renderPage(reparse(BASE))).toBe(text);
    expect(text).toContain(`- [i3] 可能在 2027 年換工作。（助理的說法） [[source:${C}]]`);
  });

  const front = `---\ntitle: "王小明"\ntype: people\ncreated: 2026-11-20\nupdated: 2026-12-02\n---\n`;
  const parse = (body: string, head = front, nextItem = 1) =>
    parsePage(head + body, "people/wang-xiaoming", nextItem);

  test("missing sections are empty", () => {
    const r = parse("## 事實\n- [i1] 一件事。\n");
    expect(r.ok && r.page.summary).toBe("");
    expect(r.ok && r.page.open).toEqual([]);
    expect(r.ok && r.page.facts.map((f) => f.id)).toEqual([1]);
  });

  test("an unknown ## section is a failure that names it", () => {
    expect(parse("## 摘要\n## 筆記\n- x\n")).toEqual({
      ok: false,
      error: "多出不認得的區段「筆記」",
    });
  });

  test("lines without a number get temporary numbers from next_item up, in order", () => {
    const r = parse(
      "## 事實\n- [i1] 第一。\n- 手加的事實。\n## 未決\n- [i2] 第二。\n- 手加的未決。\n",
      front,
      7,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.page.facts.map((f) => [f.id, f.temp])).toEqual([
      [1, false],
      [7, true],
    ]);
    expect(r.page.open.map((f) => [f.id, f.temp])).toEqual([
      [2, false],
      [8, true],
    ]);
    expect(r.page.nextItem).toBe(9);
    expect(renderPage(r.page)).toContain("- [i7] 手加的事實。");
  });

  test("frontmatter: a missing key, or a type other than the directory, fails", () => {
    expect(parse("", front.replace("created: 2026-11-20\n", ""))).toMatchObject({ ok: false });
    expect(parse("", front.replace("type: people", "type: topics"))).toMatchObject({
      ok: false,
    });
  });

  test("dates quoted or not are YYYY-MM-DD strings; anything else fails", () => {
    const r = parse("", front.replace("created: 2026-11-20", 'created: "2026-11-20"'));
    expect(r.ok && r.page.created).toBe("2026-11-20");
    expect(parse("", front.replace("created: 2026-11-20", "created: 20261120"))).toMatchObject({
      ok: false,
    });
  });

  test("aliases missing, null or [] are empty; a string fails", () => {
    for (const line of ["", "aliases:\n", "aliases: []\n"]) {
      const r = parse("", front.replace("type: people\n", `type: people\n${line}`));
      expect(r.ok && r.page.aliases).toEqual([]);
    }
    expect(
      parse("", front.replace("type: people\n", 'type: people\naliases: "小明"\n')),
    ).toMatchObject({ ok: false });
  });

  test("a title with a colon, quotes or # is written so it reads back as itself", () => {
    const title = 'A: "B" #c';
    expect(reparse({ ...BASE, title }).title).toBe(title);
  });

  test("a title with a control character or ｜ fails", () => {
    for (const title of ["a\u0007b", "a｜b"])
      expect(parsePage(renderPage({ ...BASE, title }), BASE.path, BASE.nextItem)).toMatchObject({
        ok: false,
      });
  });
});

describe("parsePagePath", () => {
  test("lowercases the slug's ASCII letters", () => {
    expect(parsePagePath("topics/TSMC")).toBe("topics/tsmc");
  });

  test("refuses non-ASCII, dots, a leading hyphen, 65 characters and unknown categories", () => {
    for (const p of [
      "people/王小明",
      "people/a.b",
      "people/-a",
      `people/${"a".repeat(65)}`,
      "notes/a",
      "people",
    ])
      expect(parsePagePath(p)).toBeUndefined();
    expect(parsePagePath(`people/${"a".repeat(64)}`)).toBe(`people/${"a".repeat(64)}`);
  });
});

describe("parsePatch", () => {
  test("an unknown key or operation is not a patch", () => {
    expect(parsePatch({ ...BOTH })).toBeDefined();
    expect(parsePatch({ ...BOTH, notes: "x" })).toBeUndefined();
    expect(parsePatch({ ...BOTH, facts: [{ op: "delete", id: "i1" }] })).toBeUndefined();
    expect(
      parsePatch({ ...BOTH, facts: [{ op: "add", text: "x", from: ["c41"], id: "i1" }] }),
    ).toBeUndefined();
    expect(parsePatch({ facts: [], open: [] })).toBeUndefined();
  });
});

describe("applyPatch: each check refuses and leaves the page as it was", () => {
  test("2 bad_id: an entry that is not there, or one used twice", () => {
    rejects(
      patch({
        ...BOTH,
        facts: [...BOTH.facts, { op: "update", id: "i9", text: "x", from: ["c41"] }],
      }),
      "bad_id",
    );
    rejects(
      patch({
        open: BOTH.open,
        facts: [
          { op: "update", id: "i1", text: "x", from: ["c41"] },
          { op: "retract", id: "i1", reason: "r", from: ["c41"] },
        ],
      }),
      "bad_id",
    );
  });

  test("3 bad_from: a candidate with no destination, in two operations, or dropped and used", () => {
    rejects(patch({ facts: BOTH.facts }), "bad_from");
    rejects(
      patch({ facts: BOTH.facts, open: [{ op: "add", text: "x", from: ["c41", "c42"] }] }),
      "bad_from",
    );
    rejects(patch({ ...BOTH, dropped: [{ candidate: "c42", reason: "dup" }] }), "bad_from");
    rejects(
      patch({ ...BOTH, facts: [{ op: "add", text: "x", from: ["c41", "c99"] }] }),
      "bad_from",
    );
  });

  test("4 assistant_only: facts add, update, retract and a summary rewrite need the owner", () => {
    const only = { dropped: [{ candidate: "c41", reason: "dup" }] };
    rejects(patch({ ...only, facts: [{ op: "add", text: "x", from: ["c42"] }] }), "assistant_only");
    rejects(
      patch({ ...only, facts: [{ op: "update", id: "i1", text: "x", from: ["c42"] }] }),
      "assistant_only",
    );
    rejects(
      patch({ ...only, facts: [{ op: "retract", id: "i1", reason: "r", from: ["c42"] }] }),
      "assistant_only",
    );
    rejects(
      patch({
        ...BOTH,
        summary: {
          keep: false,
          text: `新摘要。 [[source:${A}]] [[source:${D}]]`,
          reason: "r",
          from: ["c41", "c42"],
        },
      }),
      "assistant_only",
    );
  });

  test("5 no_from: an add with nothing behind it", () => {
    rejects(
      patch({ ...BOTH, open: [...BOTH.open, { op: "add", text: "x", from: [] }] }),
      "no_from",
    );
  });

  test("6 source_lost: an update removes a source its entry never had, or gives no reason", () => {
    const upd = (source: string, reason: string) =>
      patch({
        open: BOTH.open,
        facts: [
          {
            op: "update",
            id: "i1",
            text: "x",
            from: ["c41"],
            removed_sources: [{ source, reason }],
          },
        ],
      });
    rejects(upd(B, "wrong"), "source_lost");
    rejects(upd(A, " "), "source_lost");
  });

  test("7 bad_merge: not the lowest-numbered entries, or only one", () => {
    rejects(
      patch({ ...BOTH, facts: [...BOTH.facts, { op: "merge", ids: ["i2"], text: "x" }] }),
      "bad_merge",
    );
    const three = { ...BASE, facts: [...BASE.facts, e(4, "第三。", [D])], nextItem: 5 };
    const r = applyPatch(
      three,
      patch({ ...BOTH, facts: [...BOTH.facts, { op: "merge", ids: ["i2", "i4"], text: "x" }] }),
      ctx(),
    );
    expect(r).toEqual({ ok: false, reason: "bad_merge" } as never);
  });

  test("8 source_lost: a rewritten summary drops an old source, or cites one it may not", () => {
    const rewrite = (text: string, extra: object = {}) =>
      patch({
        ...BOTH,
        summary: { keep: false, text, reason: "新的工作", from: ["c41"], ...extra },
      });
    rejects(rewrite(`在新竹上班。 [[source:${D}]]`), "source_lost");
    rejects(rewrite(`在新竹上班。 [[source:${A}]] [[source:${B}]]`), "source_lost");
    rejects(rewrite(`在新竹上班。 [[source:${A}]] [[source:nothere]]`), "source_lost");
    rejects(
      rewrite(`在新竹上班。 [[source:${D}]]`, { removed_sources: [{ source: A, reason: "" }] }),
      "source_lost",
    );
  });

  test("9 no_such_turn: a source the patch brings in names no turn", () => {
    rejects(BOTH, "no_such_turn", { turnExists: (r) => r !== D });
  });

  test("10 too_long: more than 20 entries, or an entry over 300 characters", () => {
    const full = {
      ...BASE,
      facts: Array.from({ length: 20 }, (_, i) => e(i + 10, `事${i}。`, [A])),
      nextItem: 30,
    };
    const r = applyPatch(full, BOTH, ctx());
    expect(r).toEqual({ ok: false, reason: "too_long" } as never);
    rejects(
      patch({ ...BOTH, facts: [{ op: "add", text: "長".repeat(301), from: ["c41"] }] }),
      "too_long",
    );
  });

  test("11 secret: text the model wrote that looks like a key", () => {
    rejects(
      patch({
        ...BOTH,
        facts: [{ op: "add", text: `金鑰是 ${"sk-" + "a".repeat(20)}`, from: ["c41"] }],
      }),
      "secret",
    );
  });
});

describe("applyPatch: changes that pass", () => {
  test("add takes the next number and its sources from the candidates", () => {
    const r = applies(BOTH);
    expect(r.page.facts.at(-1)).toEqual(e(4, "在新竹上班。", [D]));
    expect(r.page.open.at(-1)).toEqual(e(5, "可能升職。", [D], true));
    expect(r.page.nextItem).toBe(6);
    expect(r.applied).toEqual(["c41", "c42"]);
    expect([r.added, r.updated]).toEqual([2, 0]);
  });

  test("update keeps the sources it does not remove, and removes one with a reason", () => {
    const r = applies(
      patch({
        open: BOTH.open,
        facts: [
          {
            op: "update",
            id: "i2",
            text: "生日是 3 月 10 日。",
            from: ["c41"],
            removed_sources: [{ source: B, reason: "記錯" }],
          },
        ],
      }),
    );
    expect(r.page.facts[1]).toEqual(e(2, "生日是 3 月 10 日。", [D]));
    const kept = applies(
      patch({ open: BOTH.open, facts: [{ op: "update", id: "i2", text: "y", from: ["c41"] }] }),
    );
    expect(kept.page.facts[1]?.sources).toEqual([B, D]);
  });

  test("retract removes the entry and logs its reason", () => {
    const r = applies(
      patch({
        open: BOTH.open,
        facts: [{ op: "retract", id: "i1", reason: "搬家取消", from: ["c41"] }],
      }),
    );
    expect(r.page.facts.map((f) => f.id)).toEqual([2]);
    expect(r.page.changeLog[0]).toBe("2026-12-05 事實：撤回 i1（搬家取消）。未決：新增 i4。");
  });

  test("merge takes the lowest numbers even with a gap, and keeps every source", () => {
    const gap = {
      ...BASE,
      facts: [e(2, "二。", [A]), e(5, "五。", [B]), e(6, "六。", [C])],
      nextItem: 7,
    };
    const r = applies(
      patch({
        ...BOTH,
        facts: [{ op: "merge", ids: ["i2", "i5"], text: "二與五。" }, ...BOTH.facts],
      }),
      {},
      gap,
    );
    expect(r.page.facts).toEqual([
      e(7, "二與五。", [A, B]),
      e(6, "六。", [C]),
      e(8, "在新竹上班。", [D]),
    ]);
  });

  test("a candidate may back both an add and the summary rewrite", () => {
    const r = applies(
      patch({
        ...BOTH,
        summary: {
          keep: false,
          text: `在新竹上班。 [[source:${A}]] [[source:${D}]]`,
          reason: "換工作",
          from: ["c41"],
        },
      }),
    );
    expect(r.page.summary).toBe(`在新竹上班。 [[source:${A}]] [[source:${D}]]`);
    expect(r.page.changeLog[0]).toContain("摘要：改寫（換工作）。");
  });

  test("a rewrite may drop an old source when it says why", () => {
    const r = applies(
      patch({
        ...BOTH,
        summary: {
          keep: false,
          text: `在新竹上班。 [[source:${D}]]`,
          reason: "換工作",
          from: ["c41"],
          removed_sources: [{ source: A, reason: "已離職" }],
        },
      }),
    );
    expect(r.page.summary).toBe(`在新竹上班。 [[source:${D}]]`);
  });

  test("everything dropped and the summary kept: nothing to write", () => {
    const r = applies(
      patch({
        dropped: [
          { candidate: "c41", reason: "duplicate" },
          { candidate: "c42", reason: "too vague" },
        ],
      }),
    );
    expect(r.write).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.page.changeLog).toEqual(BASE.changeLog);
  });
});

describe("the assistant mark", () => {
  test("an assistant-only open entry has it; an owner update removes it; the model's own copy is dropped", () => {
    const first = applies(
      patch({
        facts: BOTH.facts,
        open: [{ op: "add", text: "可能升職（助理的說法）", from: ["c42"] }],
      }),
    );
    const added = first.page.open.at(-1) as Entry;
    expect(added.assistant).toBe(true);
    expect(added.text).toBe("可能升職");
    expect(renderPage(first.page).match(/（助理的說法）/g)?.length).toBe(2);
    const owner: BatchCandidate[] = [{ key: "c50", speaker: "owner", source: B }];
    const second = applies(
      patch({ open: [{ op: "update", id: `i${added.id}`, text: "確定升職", from: ["c50"] }] }),
      { candidates: owner },
      first.page,
    );
    expect(second.page.open.at(-1)?.assistant).toBe(false);
  });
});

describe("related and aliases only grow", () => {
  test("valid additions are kept, the rest dropped without failing the patch", () => {
    const r = applies({
      ...BOTH,
      related: [
        "topics/TSMC",
        "topics/nowhere",
        "people/wang-xiaoming",
        "projects/moving",
        "bad path",
      ],
      aliases: ["小明", "王先生", "a｜b", ""],
    });
    expect(r.page.related).toEqual(["projects/moving", "topics/tsmc"]);
    expect(r.page.aliases).toEqual(["小明", "Ming", "王先生"]);
  });
});

describe("numbers and the Change Log", () => {
  test("a retracted top number is not given out again", () => {
    const r = applies(
      patch({
        open: [
          { op: "retract", id: "i3", reason: "不會換", from: ["c42"] },
          { op: "add", text: "新的未決。", from: ["c41"] },
        ],
      }),
    );
    expect(r.page.open.map((x) => x.id)).toEqual([4]);
  });

  test("the line's format, the external-change line, and 50 lines at most", () => {
    const long = { ...BASE, changeLog: Array.from({ length: 50 }, (_, i) => `old ${i}`) };
    const r = applies(BOTH, { externalChange: true }, long);
    expect(r.page.changeLog.slice(0, 2)).toEqual([
      "2026-12-05 事實：新增 i4。未決：新增 i5。",
      "2026-12-05 檔案在同步之外有變動，以檔案為準。",
    ]);
    expect(r.page.changeLog).toHaveLength(50);
    expect(r.page.updated).toBe("2026-12-05");
  });

  test("a new page's first line says it was made", () => {
    const r = applies(BOTH, { isNew: true });
    expect(r.page.changeLog[0]).toBe("2026-12-05 建立。事實：新增 i4。未決：新增 i5。");
  });

  test("with an external change and nothing else, the page is still written for the numbers", () => {
    const r = applies(
      patch({
        dropped: [
          { candidate: "c41", reason: "d" },
          { candidate: "c42", reason: "d" },
        ],
      }),
      {
        externalChange: true,
      },
    );
    expect(r.write).toBe(true);
    expect(r.page.changeLog[0]).toBe("2026-12-05 檔案在同步之外有變動，以檔案為準。");
  });
});

describe("looksSecret", () => {
  test("each pattern", () => {
    expect(looksSecret("-----BEGIN PRIVATE KEY-----")).toBe(true);
    for (const prefix of ["sk-", "ghp_", "AKIA", "AIza", "xoxb-", "xoxp-"])
      expect(looksSecret(`key ${prefix}${"A1b2".repeat(4)}`)).toBe(true);
    expect(looksSecret(`token ${"ab12".repeat(8)}`)).toBe(true);
    expect(looksSecret(`b64 ${"abcd".repeat(8)}+`)).toBe(true);
  });

  test("a 40-letter identifier without digits or + / = is not a secret", () => {
    expect(looksSecret("x".repeat(20) + "_" + "y".repeat(19))).toBe(false);
    expect(looksSecret("生日是 3 月 9 日")).toBe(false);
  });
});
