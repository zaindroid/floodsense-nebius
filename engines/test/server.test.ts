import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { FloodsenseEngines } from "../src/floodsense.ts";
import { createServer } from "../src/server.ts";

const server = createServer(new FloodsenseEngines({ clock: () => Date.parse("2024-10-29T17:25:00Z") }));
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const run = {
  run_id: "run-1",
  question: "Why Paiporta?",
  approval: { status: "edited", reviewer: "analyst" },
  claims: [{ claim_id: "C1", text: "Paiporta sits on the Poyo ravine outflow.", citations: [{ query_id: "q-1" }] }],
};

describe("engines HTTP", () => {
  it("health reports both engines", async () => {
    const { status, json } = await call("GET", "/health");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok("hmem" in json && "world_model" in json);
  });

  it("store, retry, recall, ledger round trip", async () => {
    const stored = await call("POST", "/hmem/store", run);
    assert.equal(stored.status, 200);
    const id = stored.json.stored[0].memory_id;
    const retry = await call("POST", "/hmem/store", run);
    assert.deepEqual(retry.json.stored, []);
    assert.equal(retry.json.already_stored[0].memory_id, id);
    const recalled = await call("POST", "/hmem/recall", { query: "Paiporta Poyo ravine", threshold: 0 });
    assert.equal(recalled.json.memories[0].memory_id, id);
    assert.deepEqual(recalled.json.memories[0].query_ids, ["q-1"]);
    const ledger = await call("GET", `/hmem/ledger?memory_id=${id}`);
    assert.equal(ledger.json.entries[0].action, "create");
    const fb = await call("POST", "/hmem/feedback", { memory_id: id, kind: "helpful" });
    assert.equal(fb.status, 200);
  });

  it("lists the newest memories without recalling", async () => {
    await call("POST", "/hmem/store", { ...run, run_id: "run-list" });
    const before = await call("GET", "/health");
    const { status, json } = await call("GET", "/hmem/memories?limit=1");
    assert.equal(status, 200);
    assert.ok(json.total >= 1);
    assert.equal(json.memories.length, 1);
    assert.ok(typeof json.memories[0].provenance.label === "string");
    const after = await call("GET", "/health");
    assert.deepEqual(after.json.hmem, before.json.hmem);
    assert.equal((await call("GET", "/hmem/memories?limit=abc")).status, 400);
  });

  it("hypotheses, anomalies, board and timeline", async () => {
    const res = await call("POST", "/wm/hypotheses", {
      run_id: "run-1",
      at: "2024-10-29T17:25:00Z",
      hypotheses: [{ id: "H1", link: "rain->catchment", statement: "Upstream rain", status: "proposed" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.board[0].status, "proposed");
    const obs = await call("POST", "/wm/observations", {
      anomalies: [
        { id: "A1", kind: "rain", point_id: "p1", ts_utc: "2024-10-29T16:00:00Z", value: 42, unit: "mm/h", why: "rain >= 30 mm/h", query_id: "q-2" },
      ],
    });
    assert.equal(obs.status, 200);
    assert.equal(obs.json.changed, true);
    const board = await call("GET", "/wm/board?run_id=run-1");
    assert.equal(board.json.board.length, 1);
    const timeline = await call("GET", "/wm/timeline?limit=5");
    assert.ok(timeline.json.events.length > 0);
  });

  it("bad input is a 400 and unknown routes are a 404", async () => {
    const bad: [string, string, unknown][] = [
      ["POST", "/hmem/recall", "{not json"],
      ["POST", "/hmem/recall", [1, 2]],
      ["POST", "/hmem/recall", { query: "x", top_n: 0 }],
      ["POST", "/hmem/recall", { query: "x", threshold: 3 }],
      ["POST", "/hmem/store", { run_id: "x" }],
      ["POST", "/hmem/store", { ...run, claims: [{ ...run.claims[0], confidence: -1 }] }],
      ["POST", "/wm/hypotheses", { run_id: "r", at: "2024-10-29T17:25:00Z", hypotheses: [{ id: "H1", text: "x", status: "refuted" }] }],
      ["GET", "/wm/timeline?limit=-3", undefined],
      ["GET", "/wm/timeline?limit=abc", undefined],
    ];
    for (const [method, path, body] of bad) {
      const { status, json } = await call(method, path, body);
      assert.equal(status, 400, `${method} ${path} ${JSON.stringify(body)}`);
      assert.equal(typeof json.error, "string");
    }
    assert.equal((await call("GET", "/nope")).status, 404);
  });

  it("an oversized body is a 413, the connection closes, and the server keeps serving", async () => {
    const res = await fetch(base + "/hmem/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(1_200_000) }),
    });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("connection"), "close");
    assert.match((await res.json()).error, /larger than 1 MB/);
    assert.equal((await call("GET", "/health")).status, 200);
  });
});
