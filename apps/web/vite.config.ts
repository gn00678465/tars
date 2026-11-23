import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { headersPlugin } from "./headers.ts";

// P3 (research/frontend-stack-a2ui.md §10): type checks only run with both lint options on, and
// the plugin writes .wrangler/ during a build, which check must not read.
const generated = ["dist/**", ".wrangler/**", ".visual/**", "worker/worker-configuration.d.ts"];

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), headersPlugin(process.env.APP_HOST)],
  // shadcn's components import from @/; the phases after P0 add them.
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  // vendor/ is upstream's text as is, so it compares byte for byte with the version it names.
  fmt: { ignorePatterns: [...generated, "src/vendor/**"] },
  lint: { ignorePatterns: generated, options: { typeAware: true, typeCheck: true } },
  // .visual/ holds the base tree that tools/visual extracts, tests and all.
  test: { exclude: ["**/node_modules/**", ".visual/**"] },
});
