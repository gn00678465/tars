import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SLUG } from "./metadata.ts";

/** A flow a tars session wrote for the user's scripts; search finds it by name and summary. */
export interface UserPlaybook {
  readonly name: string;
  readonly summary: string;
  readonly path: string;
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;
const FORMAT = "---\nsummary: <one line naming the requests it is for>\n---";

export async function listPlaybooks(dir: string): Promise<{
  playbooks: UserPlaybook[];
  broken: { name: string; reason: string }[];
}> {
  const files = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const playbooks: UserPlaybook[] = [];
  const broken: { name: string; reason: string }[] = [];
  for (const file of files.filter((f) => f.endsWith(".md")).toSorted()) {
    const name = file.slice(0, -".md".length);
    const path = join(dir, file);
    if (!SLUG.test(name)) {
      broken.push({ name: file, reason: `${path}: name it with lowercase letters, digits and -` });
      continue;
    }
    const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => err);
    if (text instanceof Error) {
      broken.push({ name, reason: `${path}: ${text.code ?? text.message}` });
      continue;
    }
    const summary = frontSummary(text);
    if (summary === undefined)
      broken.push({ name, reason: `${path} must start with front matter:\n${FORMAT}` });
    else playbooks.push({ name, summary, path });
  }
  return { playbooks, broken };
}

function frontSummary(text: string): string | undefined {
  const block = FRONT_MATTER.exec(text.replaceAll("\r\n", "\n"))?.[1];
  const value = block
    ?.split("\n")
    .find((line) => line.startsWith("summary:"))
    ?.slice("summary:".length)
    .trim();
  return value === "" ? undefined : value;
}
