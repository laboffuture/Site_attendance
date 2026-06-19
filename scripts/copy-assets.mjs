/* Copies runtime assets that tsc does not handle into dist/, so the compiled
   server (npm start) can find them. Currently: EJS views (src/views ->
   dist/views). public/ and models/ live at the repo root and are resolved
   relative to dist/ at runtime, so they don't need copying. */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const from = join(root, "src", "views");
const to = join(root, "dist", "views");

if (!existsSync(from)) {
  console.error(`copy-assets: source not found: ${from}`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });
console.log(`copy-assets: ${from} -> ${to}`);
