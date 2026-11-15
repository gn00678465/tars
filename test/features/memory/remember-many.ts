// One writer for the concurrency test. Args: <writer name> <count>; the memory file comes from the env.
import { run } from "../../../src/main.ts";

const [writer = "", count = "0"] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  const id = `${writer}-${i}`;
  const argv = [
    "memory",
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
  const code = await run(argv);
  if (code !== 0) process.exit(code);
}
