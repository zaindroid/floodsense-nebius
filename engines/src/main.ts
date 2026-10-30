// Entry point: npm start (reads engines/.env when it exists; see .env.example)
//
// ENGINES_HOST      bind address (default 127.0.0.1; use 0.0.0.0 inside a container)
// ENGINES_PORT      port (default 8300)
// ENGINES_DATA_DIR  persistence directory (default engines/.data; "memory" keeps nothing on disk)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { FloodsenseEngines } from "./floodsense.ts";
import { createServer } from "./server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.ENGINES_HOST || "127.0.0.1";
const port = Number(process.env.ENGINES_PORT || "8300");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`engines: ENGINES_PORT must be a port number, got ${JSON.stringify(process.env.ENGINES_PORT)}`);
  process.exit(2);
}
const dataSetting = process.env.ENGINES_DATA_DIR || path.join(here, "..", ".data");
const dataDir = dataSetting === "memory" ? undefined : path.resolve(dataSetting);

const engines = new FloodsenseEngines({ dataDir });
const server = createServer(engines);
server.listen(port, host, () => {
  const where = dataDir ? `data in ${dataDir}` : "in memory only";
  console.log(`engines: H-MEM + World Model on http://${host}:${port} (${where})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
