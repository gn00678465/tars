import type { Database } from "bun:sqlite";
import { byUpdated } from "./index-file.ts";
import { CATEGORIES, categoryOf, type Category } from "./page.ts";

// What `tars wiki list` and the remote page both read from the pages table.

interface PageRow {
  path: string;
  title: string;
  aliases: string;
  created: string;
  updated: string;
  state: "ok" | "blocked";
}

export interface ListedPage {
  readonly path: string;
  readonly title: string;
  readonly aliases: string[];
  readonly type: Category;
  readonly created: string;
  readonly updated: string;
  readonly state: "ok" | "blocked";
}

const rows = (db: Database | undefined) =>
  (db?.query("SELECT path, title, aliases, created, updated, state FROM pages").all() ??
    []) as PageRow[];

/** The pages in category order, newest first within each; one category when given. */
export function listPages(db: Database | undefined, category?: Category): ListedPage[] {
  const all = rows(db);
  return CATEGORIES.filter((c) => category === undefined || c === category).flatMap((c) =>
    all
      .filter((r) => r.path.startsWith(`${c}/`))
      .map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[], type: c }))
      .toSorted(byUpdated),
  );
}

/** Pages per category, every category listed. */
export function categoryCounts(db: Database | undefined): Record<Category, number> {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const r of rows(db)) {
    const c = categoryOf(r.path);
    if (c in counts) counts[c] += 1;
  }
  return counts;
}
