import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { headersPlugin } from "./headers.ts";

// P3 (research/frontend-stack-a2ui.md §10): type checks only run with both lint options on, and
// the plugin writes .wrangler/ during a build, which check must not read.
const generated = ["dist/**", ".wrangler/**", "worker/worker-configuration.d.ts"];

export default defineConfig({
  plugins: [react(), cloudflare(), headersPlugin(process.env.APP_HOST)],
  fmt: { ignorePatterns: generated },
  lint: { ignorePatterns: generated, options: { typeAware: true, typeCheck: true } },
});
