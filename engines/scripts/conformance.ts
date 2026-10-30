// Runs both Meterless conformance suites against the engines this sidecar uses.
// Exit 0 only when both pass.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const suites = [
  { name: "H-MEM", runner: path.join(root, "vendor", "hmem", "conformance", "runner.ts") },
  { name: "World Model", runner: path.join(root, "vendor", "world-model", "conformance", "runner.ts") },
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite.name} conformance`);
  const result = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", suite.runner], {
    stdio: "inherit",
    cwd: path.dirname(suite.runner),
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`${suite.name} conformance failed (exit ${result.status})`);
  }
}
process.exit(failed === 0 ? 0 : 1);
