import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FloodsenseEngines, InputError } from "../src/floodsense.ts";

const T0 = Date.parse("2024-10-29T17:25:00Z");
const clock = () => T0;

// Shaped like the agents' pydantic models (agents/floodsense_agents/models.py),
// extra fields included, the way Learn would post state as it is.
const claim1 = {
  claim_id: "C1",
  text: "Poyo ravine discharge passed 100 m3/s at 17:25, upstream of Paiporta.",
  kind: "number",
  numbers: [100],
  hypothesis_id: "H2",
  confidence: 0.9,
  entities: ["Barranco del Poyo", "Paiporta"],
  citations: [
    { citation_id: "c1", claim_id: "C1", layer: "a", query_id: "q-discharge-1725", storage: "pointer" },
    { citation_id: "c2", claim_id: "C1", layer: "b", source_url: "https://example.org/emsr773", query_id: null },
  ],
};
const claim2 = { claim_id: "C2", text: "Paiporta sits on the Poyo outflow.", citations: [] };

const approvedRun = {
  run_id: "run-1725",
  question: "Why is Paiporta at risk this evening?",
  event_id: "EMSR773",
  approval: { status: "approved" as const, decision: "approve", reviewer: "analyst@insurer", reviewer_note: null },
  claims: [claim1],
};

describe("H-MEM write-on-approval", () => {
  it("only approved or edited runs are remembered", () => {
    const e = new FloodsenseEngines({ clock });
    for (const status of ["rejected", "not_reached", "awaiting", "auto"] as const) {
      const out = e.storeRun({ ...approvedRun, approval: { status } });
      assert.deepEqual(out.stored, []);
      assert.equal(out.skipped, 1);
      assert.match(out.reason ?? "", new RegExp(status));
    }
    assert.equal(e.hmem.store.all().length, 0);
  });

  it("approved claims become long-term memories with Zetaris provenance and a ledger create", () => {
    const e = new FloodsenseEngines({ clock });
    const out = e.storeRun(approvedRun);
    assert.equal(out.stored.length, 1);
    assert.equal(out.stored[0].claim_id, "C1");
    const memory = e.hmem.store.get(out.stored[0].memory_id)!;
    assert.equal(memory.layer, "long_term");
    assert.equal(memory.confidence, 0.9);
    assert.equal(memory.source, "floodsense:run:run-1725");
    assert.deepEqual(memory.provenance.refs, ["zetaris:query_id:q-discharge-1725"]);
    assert.match(memory.provenance.label, /approved by analyst@insurer/);
    for (const tag of ["run:run-1725", "claim:C1", "event:EMSR773", "hypothesis:H2", "entity:Paiporta"]) {
      assert.ok(memory.tags.includes(tag), tag);
    }
    assert.equal(e.ledger(memory.id)[0].action, "create");
  });

  it("a retry stores nothing twice, and finishes a run that was half stored", () => {
    const e = new FloodsenseEngines({ clock });
    const first = e.storeRun(approvedRun);
    const again = e.storeRun(approvedRun);
    assert.deepEqual(again.stored, []);
    assert.deepEqual(again.already_stored, first.stored);
    const rest = e.storeRun({ ...approvedRun, approval: { status: "edited" }, claims: [claim1, claim2] });
    assert.deepEqual(rest.already_stored, first.stored);
    assert.deepEqual(rest.stored.map((s) => s.claim_id), ["C2"]);
    assert.equal(e.hmem.store.all().length, 2);
  });

  it("one bad claim rejects the whole request before anything is written", () => {
    const e = new FloodsenseEngines({ clock });
    const bad = [
      [claim1, { claim_id: "C2", text: "  " }],
      [claim1, { text: "no id" }],
      [claim1, { ...claim2, claim_id: "C1" }],
      [{ ...claim1, confidence: 1.5 }],
      [{ ...claim1, confidence: "high" }],
      [{ ...claim1, citations: [{ query_id: 42 }] }],
      [{ ...claim1, entities: [""] }],
    ];
    for (const claims of bad) {
      assert.throws(() => e.storeRun({ ...approvedRun, claims } as never), InputError, JSON.stringify(claims));
    }
    assert.throws(() => e.storeRun({ ...approvedRun, approval: { status: "approve" } } as never), InputError);
    assert.throws(() => e.storeRun({ ...approvedRun, question: "" }), InputError);
    assert.equal(e.hmem.store.all().length, 0);
  });

  it("recall answers in snake_case and checks top_n and threshold", () => {
    const e = new FloodsenseEngines({ clock });
    const [{ memory_id }] = e.storeRun(approvedRun).stored;
    const recalled = e.recall("Poyo ravine discharge upstream of Paiporta", { threshold: 0, top_n: 3 });
    const m = recalled.memories[0];
    assert.equal(m.memory_id, memory_id);
    assert.equal(m.run_id, "run-1725");
    assert.equal(m.claim_id, "C1");
    assert.deepEqual(m.query_ids, ["q-discharge-1725"]);
    assert.equal(m.provenance.learned_at, "2024-10-29T17:25:00.000Z");
    assert.ok("retrieval_reason" in recalled.trace);
    for (const top_n of [0, 51, 1.5, "3"]) {
      assert.throws(() => e.recall("Poyo", { top_n: top_n as never }), InputError, String(top_n));
    }
    for (const threshold of [-0.1, 1.2, "0.5", Number.NaN]) {
      assert.throws(() => e.recall("Poyo", { threshold: threshold as never }), InputError, String(threshold));
    }
    assert.throws(() => e.recall(""), InputError);
  });

  it("feedback moves confidence and the ledger explains it", () => {
    const e = new FloodsenseEngines({ clock });
    const [{ memory_id }] = e.storeRun(approvedRun).stored;
    const after = e.feedback(memory_id, "wrong");
    assert.equal(after.memory_id, memory_id);
    assert.ok(after.confidence < 0.9);
    const entries = e.ledger(memory_id);
    assert.deepEqual(entries.map((l) => l.action).filter((a) => a !== "read"), ["create", "feedback"]);
    assert.equal(entries[0].memory_id, memory_id);
    assert.equal(entries[0].at, "2024-10-29T17:25:00.000Z");
    assert.ok(!JSON.stringify(entries).includes("memoryId"));
    assert.throws(() => e.feedback("mem-404", "helpful"), InputError);
    assert.throws(() => e.feedback(memory_id, "great"), InputError);
  });
});

describe("World Model hypothesis board", () => {
  // Shaped like the agents' Hypothesis, plus the optional confidence and concerns.
  const h1 = {
    id: "H1",
    link: "rain->catchment" as const,
    statement: "Rain over the Poyo catchment drives the discharge spike",
    status: "proposed" as const,
    evidence: ["q-rain-1700"],
    citations: ["C1"],
    rounds: 0,
    rationale: "",
    confidence: 0.6,
    concerns: [{ type: "river", name: "Barranco del Poyo" }],
  };
  const base = { run_id: "run-1725", at: "2024-10-29T17:25:00Z", hypotheses: [h1] };

  it("records status changes as facts and keeps the latest on the board", async () => {
    const e = new FloodsenseEngines({ clock });
    let board = await e.upsertHypotheses(base);
    assert.equal(board.length, 1);
    assert.equal(board[0].hypothesis_id, "H1");
    assert.equal(board[0].statement, h1.statement);
    assert.equal(board[0].link, "rain->catchment");
    assert.equal(board[0].status, "proposed");
    assert.deepEqual(board[0].concerns, ["Barranco del Poyo"]);
    board = await e.upsertHypotheses({
      ...base,
      at: "2024-10-29T17:40:00Z",
      hypotheses: [{ ...h1, status: "not_supported", confidence: 0.85, rounds: 1, rationale: "no rain at the gauge" }],
    });
    assert.equal(board[0].status, "not_supported");
    assert.equal(board[0].confidence, 0.85);
    assert.equal(board[0].rounds, 1);
    assert.equal(board[0].rationale, "no rain at the gauge");
    assert.equal(e.board("another-run").length, 0);
  });

  it("sending the same hypotheses again appends nothing", async () => {
    const e = new FloodsenseEngines({ clock });
    await e.upsertHypotheses(base);
    const events = e.world.events().length;
    await e.upsertHypotheses(base);
    await e.upsertHypotheses({ ...base, at: "2024-10-29T17:30:00Z" });
    assert.equal(e.world.events().length, events);
    assert.equal(e.board("run-1725")[0].concerns.length, 1);
  });

  it("checks every hypothesis and concern before writing any", async () => {
    const e = new FloodsenseEngines({ clock });
    const bad = [
      { ...base, at: "not a date" },
      { ...base, hypotheses: [h1, { ...h1, id: "H2", concerns: [{ type: "river" }] }] },
      { ...base, hypotheses: [h1, { ...h1, id: "H2", status: "refuted" }] },
      { ...base, hypotheses: [h1, { ...h1, id: "H2", link: "river->sea" }] },
      { ...base, hypotheses: [h1, { ...h1, id: "H2", confidence: 2 }] },
      { ...base, hypotheses: [h1, { ...h1, text: "old field name", statement: undefined }] },
      { ...base, hypotheses: [h1, h1] },
      { ...base, hypotheses: [] },
    ];
    for (const input of bad) {
      await assert.rejects(e.upsertHypotheses(input as never), InputError, JSON.stringify(input.hypotheses));
    }
    assert.equal(e.world.events().length, 0);
  });

  it("takes the Watchers' anomalies, and the same reading from another run changes nothing", async () => {
    const e = new FloodsenseEngines({ clock });
    const anomaly = {
      id: "A1",
      kind: "discharge",
      point_id: "poyo-riba-roja",
      ts_utc: "2024-10-29T17:00:00Z",
      value: 208,
      unit: "m3/s",
      why: "discharge >= 100 m3/s",
      query_id: "q-discharge-1700",
    };
    const first = await e.observe({ anomalies: [anomaly] as never });
    const replay = await e.observe({ anomalies: [{ ...anomaly, id: "A7" }] as never });
    assert.equal(first.changed, true);
    assert.equal(replay.changed, false);
    assert.ok("skipped_unchanged" in replay);
    await assert.rejects(e.observe({ anomalies: [{ ...anomaly, kind: "wind" }] as never }), InputError);
    await assert.rejects(e.observe({ anomalies: [{ ...anomaly, query_id: "" }] as never }), InputError);
    await assert.rejects(e.observe({}), InputError);
  });

  it("takes other observations in snake_case", async () => {
    const e = new FloodsenseEngines({ clock });
    const obs = {
      external_id: "aemet:warning:valencia:2024-10-29",
      type: "warning",
      title: "AEMET red warning, Valencia",
      at: "2024-10-29T07:36:00Z",
      source: { kind: "api", by: "ingestion" },
      entities: [{ type: "region", name: "Valencia" }],
    };
    assert.equal((await e.observe({ observations: [obs] })).changed, true);
    assert.equal((await e.observe({ observations: [obs] })).changed, false);
    await assert.rejects(e.observe({ observations: [{ ...obs, source: {} }] as never }), InputError);
  });

  it("checks the timeline limit", async () => {
    const e = new FloodsenseEngines({ clock });
    await e.upsertHypotheses(base);
    assert.equal(e.timeline(1).length, 1);
    for (const limit of [0, 1001, 2.5, Number.NaN]) assert.throws(() => e.timeline(limit), InputError);
  });
});

describe("persistence", () => {
  it("memories, ledger and board survive a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-"));
    try {
      const first = new FloodsenseEngines({ dataDir: dir, clock });
      const [{ memory_id }] = first.storeRun(approvedRun).stored;
      // Same timestamp twice: the later write wins, before and after the restart.
      for (const status of ["proposed", "not_supported"] as const) {
        await first.upsertHypotheses({
          run_id: "run-1725",
          at: "2024-10-29T17:25:00Z",
          hypotheses: [{ id: "H1", statement: "Rain drives the spike", status }],
        });
      }
      assert.equal(first.board("run-1725")[0].status, "not_supported");
      const second = new FloodsenseEngines({ dataDir: dir, clock });
      assert.equal(second.hmem.store.get(memory_id)?.content, claim1.text);
      assert.equal(second.ledger(memory_id)[0].action, "create");
      assert.equal(second.board("run-1725")[0].status, "not_supported");
      // A retry after the restart still writes nothing new.
      assert.deepEqual(second.storeRun(approvedRun).stored, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
