// One writer for the concurrency test. Args: <memory path> <writer name> <count>.
import { runMemoryCli } from "./cli.ts";

const [memoryPath = "", writer = "", count = "0"] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  const id = `${writer}-${i}`;
  const argv = [
    "remember",
    "--id",
    id,
    "--section",
    "決定",
    "--text",
    `寫入 ${id}`,
    "--source",
    "user",
  ];
  const code = await runMemoryCli(memoryPath, argv);
  if (code !== 0) process.exit(code);
}
