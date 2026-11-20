import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { matchQuery, querySegments, tokenize } from "../../../src/features/wiki/tokenize.ts";

describe("page_fts in SQLite as this Bun ships it", () => {
  test("two columns: AND across them, a one-character prefix, deleting a row and all rows", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE VIRTUAL TABLE page_fts USING fts5(meta_tokens, body_tokens, content='', contentless_delete=1, tokenize='unicode61')",
    );
    const put = (id: number, meta: string, body: string) =>
      db.run("INSERT INTO page_fts (rowid, meta_tokens, body_tokens) VALUES (?, ?, ?)", [
        id,
        tokenize(meta),
        tokenize(body),
      ]);
    put(1, "王小明｜小明、Ming", "2026-12-14 搬家到台中西屯。");
    put(2, "王小明｜小明、Ming", "");
    put(3, "台積電｜TSMC", "Q3財報的毛利率");
    const hits = (q: string) =>
      (
        db
          .query("SELECT rowid FROM page_fts WHERE page_fts MATCH ? ORDER BY rowid")
          .all(matchQuery(q) as string) as { rowid: number }[]
      ).map((r) => r.rowid);
    expect(hits("小明 搬家")).toEqual([1]);
    expect(hits("王小明")).toEqual([1, 2]);
    expect(hits("電")).toEqual([3]);
    expect(hits("中")).toEqual([1]);
    db.run("DELETE FROM page_fts WHERE rowid = 1");
    expect(hits("搬家")).toEqual([]);
    expect(hits("小明")).toEqual([2]);
    db.run("DELETE FROM page_fts");
    expect(hits("王小明")).toEqual([]);
    db.close();
  });
});

describe("tokenize", () => {
  test("a CJK run is cut in pairs, its last character also alone", () => {
    expect(tokenize("台積電")).toBe("台積 積電 電");
    expect(tokenize("電")).toBe("電");
  });

  test("other letters and digits are one lowercased word; the rest separates", () => {
    expect(tokenize("Q3財報, TSMC!")).toBe("q3 財報 報 tsmc");
  });

  test("full-width letters become half-width", () => {
    expect(tokenize("ＡＢＣ")).toBe("abc");
  });

  test("ー and 々 stay inside the run", () => {
    expect(tokenize("コーヒー")).toBe("コー ーヒ ヒー ー");
    expect(tokenize("人々")).toBe("人々 々");
  });

  test("punctuation alone gives nothing", () => {
    expect(tokenize("，。！?")).toBe("");
  });
});

describe("matchQuery", () => {
  const sentences = [
    "台積電的財報出來了",
    "Q3財報不錯",
    "積電 毛利 上升",
    "我要買股票",
    "王先生住在台中",
    "ABC 公司",
    'x" OR tokens:* 的寫法',
  ];
  function search(q: string): string[] {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(tokens, content='', tokenize='unicode61')");
    sentences.forEach((s, i) =>
      db.run("INSERT INTO t (rowid, tokens) VALUES (?, ?)", [i, tokenize(s)]),
    );
    const rows = db
      .query("SELECT rowid FROM t WHERE t MATCH ? ORDER BY rowid")
      .all(matchQuery(q) as string) as { rowid: number }[];
    db.close();
    return rows.map((r) => sentences[r.rowid] as string);
  }

  test("phrases and words find the sentences the design lists", () => {
    expect(search("台積電")).toEqual(["台積電的財報出來了"]);
    expect(search("財報")).toEqual(["台積電的財報出來了", "Q3財報不錯"]);
    expect(search("Q3財報")).toEqual(["Q3財報不錯"]);
    expect(search("積電 毛利")).toEqual(["積電 毛利 上升"]);
  });

  test("one CJK character finds every sentence holding it", () => {
    expect(search("電")).toEqual(["台積電的財報出來了", "積電 毛利 上升"]);
    expect(search("股")).toEqual(["我要買股票"]);
    expect(search("買")).toEqual(["我要買股票"]);
    expect(search("王")).toEqual(["王先生住在台中"]);
    expect(search("中")).toEqual(["王先生住在台中"]);
  });

  test("full-width text is found by half-width letters", () => {
    expect(search("ａｂｃ")).toEqual(["ABC 公司"]);
  });

  test("quotes and FTS5 operators are only words", () => {
    expect(matchQuery('x" OR tokens:*')).toBe('"x" AND "or" AND "tokens"');
    expect(search('x" OR tokens:*')).toEqual(['x" OR tokens:* 的寫法']);
  });

  test("mixed CJK and Latin; punctuation alone is nothing", () => {
    expect(matchQuery("Q3財報 電")).toBe('"q3" AND "財報" AND "電" *');
    expect(matchQuery("，。！")).toBeUndefined();
  });

  test("querySegments keeps the parts as plain text for snippets", () => {
    expect(querySegments("ＴＳＭＣ 的Q3財報")).toEqual(["tsmc", "的", "q3", "財報"]);
  });
});
