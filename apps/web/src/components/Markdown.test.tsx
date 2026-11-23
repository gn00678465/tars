// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import { Markdown, sortOrder } from "./Markdown.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const md = async (text: string) => render(<Markdown text={text} />);

test("a paragraph keeps its line breaks; a fenced block is code without its language name", async () => {
  const { root } = await md(
    '分三行：\n一\n二\n三\n```beancount\n2026-11-22 * "午餐"\n  Expenses:Food  120 TWD\n```\n完成',
  );
  const ps = [...root.querySelectorAll("p")].map((p) => p.textContent);
  expect(ps).toEqual(["分三行：\n一\n二\n三", "完成"]);
  expect(root.querySelector("pre.tool-code-box code")?.textContent).toBe(
    '2026-11-22 * "午餐"\n  Expenses:Food  120 TWD',
  );
});

test("a fence still open while streaming is code to the end", async () => {
  const { root } = await md("預覽：\n```\nline 1\nline 2");
  expect(root.querySelector("pre")?.textContent).toBe("line 1\nline 2");
});

test("headings sit below the page's own, emphasis, code spans and strike", async () => {
  const { root } = await md("# 標題\n## 小節\n**粗** *斜* _也斜_ `a*b*` ~~刪~~ snake_case_name");
  expect(root.querySelector("h3")?.textContent).toBe("標題");
  expect(root.querySelector("h4")?.textContent).toBe("小節");
  expect(root.querySelector("strong")?.textContent).toBe("粗");
  expect([...root.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["斜", "也斜"]);
  // Inside a code span nothing is emphasis.
  expect(root.querySelector("p code")?.textContent).toBe("a*b*");
  expect(root.querySelector("del")?.textContent).toBe("刪");
  expect(root.querySelector("p")?.textContent).toContain("snake_case_name");
});

test("lists, nested and ordered, and a quote", async () => {
  const { root } = await md("- 一\n- 二\n  - 二之一\n\n3. 三\n4. 四\n\n> 引用\n> 第二行");
  const ul = root.querySelector("ul") as HTMLElement;
  expect([...ul.children].map((li) => li.firstChild?.textContent)).toEqual(["一", "二"]);
  expect(ul.querySelector(":scope li ul li")?.textContent).toBe("二之一");
  const ol = root.querySelector("ol") as HTMLOListElement;
  expect(ol.start).toBe(3);
  expect([...ol.children].map((li) => li.textContent)).toEqual(["三", "四"]);
  expect(root.querySelector("blockquote p")?.textContent).toBe("引用\n第二行");
});

test("a simple table", async () => {
  const { root } = await md("| 帳戶 | 金額 |\n|---|---:|\n| Cash | -120 |\n| Food | 120 |");
  expect([...root.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["帳戶", "金額"]);
  expect([...root.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual([
    "Cash-120",
    "Food120",
  ]);
});

/** The column's cells after sorting by it. */
const sorted = (cells: string[], dir: 1 | -1) =>
  sortOrder(
    cells.map((c) => [c]),
    { col: 0, dir },
  ).map((k) => cells[k]);

test("a column of numbers sorts by value: thousands commas, percents and negatives", () => {
  expect(sorted(["1,200", "-3", "15%", "9", "-0.5"], 1)).toEqual([
    "-3",
    "-0.5",
    "9",
    "15%",
    "1,200",
  ]);
  expect(sorted(["1,200", "-3", "15%", "9"], -1)).toEqual(["1,200", "15%", "9", "-3"]);
});

test("a column with any text sorts as zh-Hant text, A9 before A10", () => {
  expect(sorted(["A10", "A9", "B1", "12"], 1)).toEqual(["12", "A9", "A10", "B1"]);
  expect(sorted(["2026-11-03", "2026-01-20", "2025-12-31"], 1)).toEqual([
    "2025-12-31",
    "2026-01-20",
    "2026-11-03",
  ]);
});

test("empty cells go last both ways; equal ones keep their order", () => {
  expect(sorted(["3", "", "-", "1", "—"], 1)).toEqual(["1", "3", "", "-", "—"]);
  expect(sorted(["3", "", "-", "1", "—"], -1)).toEqual(["3", "1", "", "-", "—"]);
  const rows = [
    ["a", "2"],
    ["b", "1"],
    ["c", "2"],
    ["d", "1"],
  ];
  expect(sortOrder(rows, { col: 1, dir: 1 })).toEqual([1, 3, 0, 2]);
  expect(sortOrder(rows, { col: 1, dir: -1 })).toEqual([0, 2, 1, 3]);
});

test("a cell sorts by the text it shows: a link's label, **12** as 12, a_b and 1_2 as written", () => {
  expect(sorted(["**12**", "3", "[9](https://example.com/n)", "`7`"], 1)).toEqual([
    "3",
    "`7`",
    "[9](https://example.com/n)",
    "**12**",
  ]);
  // 1_2 is text, not 12: the column sorts as text, where 1_2 comes before 3.
  expect(sorted(["3", "1_2"], 1)).toEqual(["1_2", "3"]);
  // a_b and ab are two values, not equal ones kept in order.
  expect(sorted(["ab", "a_b"], 1)).toEqual(["a_b", "ab"]);
});

test("only plain decimals are numbers: an exponent or a value past Infinity makes the column text", () => {
  // As numbers these would be 5, 1000; as text 1e3 comes first.
  expect(sorted(["5", "1e3"], 1)).toEqual(["1e3", "5"]);
  const huge = "9".repeat(400);
  // As numbers: 999, 1,000, huge. As text, 1,000 is read as 1.
  expect(sorted([huge, "999", "1,000"], 1)).toEqual(["1,000", "999", huge]);
});

test("a heading sorts its column: ascending first, then it alternates; aria-sort is on that one only", async () => {
  const { root } = await md(
    "| 代號 | 漲跌 |\n|---|---:|\n| 2330 | 1.5% |\n| 0050 | -0.8% |\n| 2317 | 12% |",
  );
  const heads = [...root.querySelectorAll("th")];
  const sortButton = (j: number) => heads[j]?.querySelector("button") as HTMLButtonElement;
  const firsts = () => [...root.querySelectorAll("tbody tr")].map((r) => r.firstChild?.textContent);
  const sorts = () => heads.map((h) => h.getAttribute("aria-sort"));
  for (const h of heads) {
    expect(h.getAttribute("scope")).toBe("col");
    // A native button: Tab reaches it, and Enter and Space press it.
    expect(sortButton(heads.indexOf(h)).type).toBe("button");
    expect(sortButton(heads.indexOf(h)).querySelector("[aria-hidden='true']")).not.toBeNull();
  }
  expect(sorts()).toEqual([null, null]);
  expect(firsts()).toEqual(["2330", "0050", "2317"]);
  await act(async () => sortButton(1).click());
  expect(sorts()).toEqual([null, "ascending"]);
  expect(firsts()).toEqual(["0050", "2330", "2317"]);
  await act(async () => sortButton(1).click());
  expect(sorts()).toEqual([null, "descending"]);
  expect(firsts()).toEqual(["2317", "2330", "0050"]);
  await act(async () => sortButton(0).click());
  expect(sorts()).toEqual(["ascending", null]);
  expect(firsts()).toEqual(["0050", "2317", "2330"]);
  expect(root.querySelector("[style], style")).toBeNull();
});

test("a heading with a link: the link is outside the button, and pressing it does not sort", async () => {
  const { root } = await md(
    "| [代號](https://example.com/c) | 價 |\n|---|---|\n| 2330 | 2 |\n| 0050 | 1 |",
  );
  const th = root.querySelector("th") as HTMLElement;
  const link = th.querySelector("a") as HTMLAnchorElement;
  const sortButton = th.querySelector("button") as HTMLButtonElement;
  expect(link.textContent).toBe("代號");
  expect(link.closest("button")).toBeNull();
  expect(sortButton.querySelector("a")).toBeNull();
  expect(sortButton.getAttribute("aria-label")).toBe("代號");
  link.addEventListener("click", (e) => e.preventDefault());
  await act(async () => link.click());
  expect(th.getAttribute("aria-sort")).toBeNull();
  await act(async () => sortButton.click());
  expect(th.getAttribute("aria-sort")).toBe("ascending");
});

test("an empty heading beside named ones: its button is named for its column", async () => {
  const { root } = await md("| 名稱 | |\n|---|---|\n| b | 2 |\n| a | 1 |");
  const named = [...root.querySelectorAll("th button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent,
  );
  expect(named).toEqual(["名稱", "第 2 欄"]);
});

test("a table whose heading row is empty has nothing to sort by", async () => {
  const { root } = await md("| | |\n|---|---|\n| b | 2 |\n| a | 1 |");
  expect(root.querySelector("th button")).toBeNull();
  expect(root.querySelector("[aria-sort]")).toBeNull();
});

test("links open only for http and https, in a new tab without opener or referrer", async () => {
  const { root } = await md(
    "[文件](https://example.com/a?b=1) [壞](javascript:alert(1)) [資料](data:text/html,x) 見 https://example.com/x。",
  );
  const links = [...root.querySelectorAll("a")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual([
    "https://example.com/a?b=1",
    "https://example.com/x",
  ]);
  for (const a of links) {
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
  }
  // The refused ones stay the text they were written as.
  expect(root.textContent).toContain("[壞](javascript:alert(1))");
  expect(root.textContent).toContain("[資料](data:text/html,x)");
});

test("markup in the text stays text", async () => {
  const { root } = await md('<img src=x onerror="alert(1)"> **<b>粗</b>** `<script>`');
  expect(root.querySelector("img, b, script")).toBeNull();
  expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(root.querySelector("strong")?.textContent).toBe("<b>粗</b>");
});
