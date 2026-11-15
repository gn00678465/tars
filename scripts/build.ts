import { Glob } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const skills = Array.from(
  new Glob("tars-skills/**/*").scanSync({ cwd: root, dot: true, onlyFiles: true }),
).sort();

const proc = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--loader",
    ".md:file",
    "--loader",
    ".json:file",
    "--asset-naming",
    "[dir]/[name].[ext]",
    "src/main.ts",
    ...skills,
    "--outfile",
    "dist/tars",
  ],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
process.exitCode = proc.exitCode;
