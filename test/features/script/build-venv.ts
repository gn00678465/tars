// A separate process for the cross-process race in supply.test.ts: bun build-venv.ts <dir> <toolchain json>
import { ensureVenv } from "../../../src/features/script/supply.ts";

const [dir, toolchain] = process.argv.slice(2);
console.log((await ensureVenv(dir ?? "", JSON.parse(toolchain ?? "{}"))).dir);
