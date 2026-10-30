// Builds the embed bundle into ../ui-merged/web/vendor. Vite does not emit the maplibre worker for this
// bundle, so it is copied next to map3d.js, where maplibre looks for it by default.
import { copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

const out = "../ui-merged/web/vendor";
execSync(`npx vite build -c vite.embed.config.ts --outDir ${out}`, { stdio: "inherit" });
copyFileSync("node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", `${out}/maplibre-gl-worker.mjs`);
