import { describe, expect, it } from "vitest";
import { adoptRunBody, type RecordedRun } from "../api/replay";
import { buildTechTrace, modelDisplay, NO_MEMORY_MATCH, pickRunRow, RECALL_FAILED, RECALL_NOT_ACTIVE, RECORDED_NOTE, routerLine, watchTile, zetarisUse } from "./techTrace";

const step = (seq: number, node: string, lane: string, model_id: string | null, latency_ms: number, summary: string) => ({
  seq,
  node,
  lane,
  model_id,
  latency_ms,
  summary,
  evidence_ids: [],
});

const cite = (layer: string, title: string, query_id: string | null, extra: Record<string, unknown> = {}) => ({
  citation_id: `${layer}-${title}-${query_id}`,
  layer,
  title,
  query_id,
  ...extra,
});

function body(over: Record<string, unknown>): RecordedRun {
  const run = adoptRunBody(
    {
      run_id: "r1",
      served_from: "live",
      status: "answered",
      summary: "s",
      claims: [],
      trace: [],
      model_ids: [],
      memory_used: [],
      ...over,
    },
    "r1",
  );
  if (!run) throw new Error("fixture not adopted");
  return run;
}

const QUICK = body({
  lane: "quick",
  router_reason: "chose quick: live level question about KÖLN",
  judge_summary: { overall: 1.0, passes: true },
  claims: [
    { claim_id: "C1", text: "Köln is below MHW", citations: [cite("a", "floodsense.gauge_levels", "q-1"), cite("b", "PEGELONLINE Rhine water levels", null, { publisher: "WSV" })] },
  ],
  trace: [
    step(1, "router", "none", null, 0, "chose quick: live level question about KÖLN"),
    step(2, "live_watch", "sql", null, 900, "KÖLN: floodsense.gauge_levels 1 row"),
    step(3, "quick_answer", "none", "deterministic", 0, "1 template claims"),
    step(4, "judge", "none", "deterministic", 0, "PASS overall=1.00"),
  ],
});

const FULL = body({
  lane: "full",
  status: "awaiting_approval",
  router_reason: "chose full: asks 'insured', which needs the full investigation",
  model_ids: ["nvidia/nemotron-3.5-super-vl-120b-a12b"],
  judge_summary: { overall: 1.0, passes: true },
  claims: [
    {
      claim_id: "C1",
      text: "t",
      citations: [
        cite("a", "floodsense.eu_watch", "q-a"),
        cite("a", "floodsense.exposure_join", "q-b"),
        cite("a", "floodsense.eu_watch", "q-a"),
        cite("b", "Open-Meteo Flood API", null, { source_url: "https://open-meteo.com/en/docs/flood-api" }),
        cite("c", "2013 European floods", "q-rag", { chunk_id: "k1" }),
        cite("c", "2016 European floods", "q-rag", { chunk_id: "k2" }),
      ],
    },
  ],
  memory_used: [
    { memory_id: "mem-1", run_id: "demo-seed-history-rhine", claim_id: "H1", text: "x", reviewer: "demo-seed", seeded: true },
    { memory_id: "mem-2", run_id: "abc123", claim_id: "H2", text: "y", reviewer: "analyst", seeded: false },
  ],
  trace: [
    step(1, "router", "none", null, 0, "chose full"),
    step(2, "investigator", "sql", "deterministic", 1500, "built chain"),
    step(3, "world_model", "none", null, 60, "board after investigator: H1 proposed"),
    step(4, "skeptic", "deep", "nvidia/nemotron-3.5-super-vl-120b-a12b", 12000, "checked"),
    step(5, "world_model", "none", null, 80, "board after skeptic: H1 supported, H2 not_supported"),
    step(6, "playbook", "fast", "nvidia/nemotron-3.5-lightning-30b-a3b", 8000, "playbook"),
    step(7, "judge", "deep", "deterministic,nvidia/nemotron-3.5-super-vl-120b-a12b", 4000, "PASS"),
  ],
});

const FORECAST = body({
  lane: "forecast",
  router_reason: "chose forecast: forecast question ('next 48 hours') about KÖLN",
  judge_summary: { overall: 1.0, passes: true },
  claims: [
    {
      claim_id: "C1",
      text: "t",
      citations: [
        cite("a", "floodsense.weather_forecast", "q-1"),
        cite("a", "floodsense.gauge_levels", "q-2"),
        cite("a", "floodsense_seed.hazard_timeline", "q-3"),
        cite("b", "Open-Meteo forecast API", null),
      ],
    },
  ],
  trace: [
    step(1, "router", "none", null, 0, "chose forecast"),
    step(2, "forecast_data", "sql", null, 1000, "weather"),
    step(3, "history", "sql", null, 900, "EMSR517 seed AHR01: 1 row; PEG07 H-MEM: 0 approved memories"),
    step(4, "forecast_answer", "none", "deterministic", 0, "4 claims"),
    step(5, "judge", "none", "deterministic", 2, "PASS"),
  ],
});

const tile = (run: RecordedRun, id: string) => {
  const t = buildTechTrace(run).tiles.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
};

describe("techTrace: quick lane (no model call)", () => {
  const m = buildTechTrace(QUICK);
  it("states the router choice and the judge result", () => {
    expect(m.routerLine).toBe("Router → quick lane (live level question about KÖLN)");
    expect(m.judgeLine).toBe("Checked 1.00");
  });
  it("never claims Nightshift without a model call", () => {
    const n = tile(QUICK, "nightshift");
    expect(n.used).toBe(false);
    expect(n.headline).toBe("No model call");
    expect(n.details[0].value).toContain("No model call: answered deterministically from Zetaris data");
    expect(n.details[0].value).toContain("the router chose the cheapest safe path in 900 ms");
  });
  it("counts one Zetaris query and the upstream source", () => {
    expect(tile(QUICK, "zetaris").headline).toBe("1 cited query across gauge_levels");
    expect(zetarisUse(QUICK).upstream.map((u) => u.title)).toEqual(["PEGELONLINE Rhine water levels"]);
  });
  it("says no memory matched and no World Model", () => {
    expect(tile(QUICK, "hmem").headline).toBe(RECALL_NOT_ACTIVE);
    expect(tile(QUICK, "world").headline).toBe("Not used by this lane");
  });
});

describe("techTrace: full lane (models, memory, world model)", () => {
  it("counts distinct query ids over layers a and c, lists views and RAG via JDBC", () => {
    const z = zetarisUse(FULL);
    expect(z.queryIds).toEqual(["q-a", "q-b", "q-rag"]);
    expect(z.views).toEqual(["floodsense.eu_watch", "floodsense.exposure_join"]);
    expect(z.ragChunks).toBe(2);
    expect(tile(FULL, "zetaris").headline).toBe("3 cited queries across eu_watch, exposure_join, document chunks");
    expect(tile(FULL, "zetaris").details.some((d) => d.value.includes("Zetaris JDBC"))).toBe(true);
  });
  it("lists the models with lane, calls and total model time", () => {
    const n = tile(FULL, "nightshift");
    expect(n.used).toBe(true);
    expect(n.headline).toBe("Super VL 120B + Lightning 30B · 3 model-assisted steps");
    expect(n.details.find((d) => d.label === "Nemotron 3.5 Super VL 120B")?.value).toBe("deep lane · 2 model-assisted steps · 16.0 s");
    expect(n.details.find((d) => d.label === "Nemotron 3.5 Lightning 30B")?.value).toBe("fast lane · 1 model-assisted step · 8.0 s");
    expect(n.details.at(-1)?.value).toBe("24.0 s over 3 steps");
  });
  it("shows recalled memories, the seed label and the write on approval", () => {
    const h = tile(FULL, "hmem");
    expect(h.headline).toBe("2 recalled · 1 demo seed · + writes on approval");
    expect(h.details[0].value).toBe("demo seed · demo-seed-history-rhine");
    expect(h.details[1].value).toBe("approved run abc123");
  });
  it("reads the last World Model board", () => {
    const w = tile(FULL, "world");
    expect(w.used).toBe(true);
    expect(w.headline).toBe("H1 supported, H2 not supported");
  });
  it("names the three Nightshift models", () => {
    expect(modelDisplay("nvidia/nemotron-3.5-ultra-550b-a55b")).toBe("Nemotron 3.5 Ultra 550B");
    expect(modelDisplay("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("Nemotron 3.5 Lightning 30B");
  });
});

describe("techTrace: forecast lane", () => {
  it("answers deterministically over several views, no World Model", () => {
    const m = buildTechTrace(FORECAST);
    expect(m.routerLine).toBe("Router → forecast lane (forecast question ('next 48 hours') about KÖLN)");
    expect(tile(FORECAST, "zetaris").headline).toBe("3 cited queries across weather_forecast, gauge_levels, hazard_timeline");
    expect(tile(FORECAST, "nightshift").used).toBe(false);
    expect(tile(FORECAST, "nightshift").details[0].value).toContain("in 1.9 s");
    expect(tile(FORECAST, "world").headline).toBe("Not used by this lane");
    expect(tile(FORECAST, "hmem").headline).toBe(NO_MEMORY_MATCH);
  });
  it("adds + writes on approval only to an awaiting run whose recall ran", () => {
    const ran = body({ status: "awaiting_approval", lane: "full", trace: [step(1, "memory", "none", null, 5, "recalled 0 past approved finding(s) for the Investigator")] });
    expect(tile(ran, "hmem").headline).toBe(`${NO_MEMORY_MATCH} · + writes on approval`);
  });
});

describe("techTrace: H-MEM recall not active", () => {
  it("separates engines-off from no match, and makes no write promise without recall", () => {
    const off = body({ status: "awaiting_approval", lane: "full", trace: [step(1, "scope", "none", null, 0, "in scope")] });
    expect(tile(off, "hmem").headline).toBe(RECALL_NOT_ACTIVE);
    const failed = body({ lane: "full", trace: [step(1, "memory", "none", null, 5, "recall failed: boom; the Investigator runs without it")] });
    expect(tile(failed, "hmem").headline).toBe(RECALL_FAILED);
  });
});

describe("techTrace: cached and replayed answers", () => {
  it("notes on the first line and the Nightshift tile that the run is recorded", () => {
    for (const served_from of ["cache", "replay"]) {
      const r = body({
        served_from,
        lane: "quick",
        router_reason: "chose quick: live level question about KÖLN",
        trace: [step(1, "router", "none", null, 0, "chose quick"), step(2, "live_watch", "sql", null, 900, "x")],
      });
      expect(buildTechTrace(r).routerLine).toContain(RECORDED_NOTE);
      expect(tile(r, "nightshift").details[0]).toEqual({ label: "Served from", value: RECORDED_NOTE });
    }
    expect(routerLine(QUICK)).not.toContain("Recorded run");
    expect(tile(QUICK, "nightshift").details[0].label).toBe("Why");
  });
});

describe("techTrace: router-LLM quick run and non-Nemotron models", () => {
  const llmQuick = body({
    lane: "quick",
    router_reason: "chose quick: live level question",
    trace: [
      step(1, "router", "fast", "nvidia/nemotron-3.5-lightning-30b-a3b", 700, "chose quick"),
      step(2, "live_watch", "sql", null, 900, "gauge_levels 1 row"),
      step(3, "quick_answer", "none", "deterministic", 0, "1 template claims"),
    ],
  });
  it("counts the router step as a model-assisted step, not a call", () => {
    const n = tile(llmQuick, "nightshift");
    expect(n.used).toBe(true);
    expect(n.headline).toBe("Lightning 30B · 1 model-assisted step");
    expect(n.details.at(-1)?.label).toBe("Time in model-assisted steps (includes data queries)");
  });
  it("never labels a non-Nemotron model as Nightshift", () => {
    const test = body({ lane: "full", trace: [step(1, "skeptic", "deep", "acme/model-x", 3000, "checked")] });
    const n = tile(test, "nightshift");
    expect(n.used).toBe(false);
    expect(n.headline).toBe("Test provider · model-x");
    expect(n.details.some((d) => d.value.includes("not to Nightshift"))).toBe(true);
  });
});

describe("techTrace: watchTile", () => {
  it("maps the loop to a dot and a line, unknown without a status", () => {
    const s = (enabled: boolean, alive: boolean) => ({ loop: { enabled, alive, interval_s: 300 }, counts: { sources: 45, awaiting_approval: 2 } });
    expect(watchTile(s(true, true))).toEqual({ state: "ok", line: "Watch loop every 300 s · 45 sources · 2 awaiting approval" });
    expect(watchTile(s(false, false)).state).toBe("off");
    expect(watchTile(s(true, false)).state).toBe("down");
    expect(watchTile(null).state).toBe("unknown");
  });
});

describe("techTrace: pickRunRow (insurer Review)", () => {
  const rows = [
    { runId: "a", status: "running", eventId: "EMSR517" },
    { runId: "b", status: "answered", eventId: "EMSR773" },
    { runId: "c", status: "awaiting_approval", eventId: "EMSR517" },
  ];
  it("live takes the newest finished run; past the newest for the chosen event, or none", () => {
    expect(pickRunRow(rows, "live", null)?.runId).toBe("b");
    expect(pickRunRow(rows, "past", "EMSR517")?.runId).toBe("c");
    expect(pickRunRow(rows, "past", "EMSR999")).toBeNull();
  });
});

describe("techTrace: Tavily tile", () => {
  it("is off without a tavily trace step", () => {
    expect(tile(QUICK, "tavily").headline).toContain("Off");
    expect(tile(QUICK, "tavily").used).toBe(false);
  });
  it("shows the call and the Skeptic web check", () => {
    const run = body({
      trace: [
        step(1, "tavily", "none", null, 300, "tavily query 'Koeln flood warning current'; 3 results; 300 ms; cached no"),
        step(2, "skeptic", "sql", null, 5, "1 supported; web_check supports C-1 https://example.org/a"),
      ],
    });
    const t = tile(run, "tavily");
    expect(t.headline).toBe("On · 1 call");
    expect(t.details.map((d) => d.value).join("|")).toContain("supports C-1, https://example.org/a");
  });
  it("says unavailable when the call failed", () => {
    const run = body({ trace: [step(1, "tavily", "none", null, 1, "tavily unavailable (HTTP 429); query -")] });
    expect(tile(run, "tavily").headline).toBe("Unavailable");
  });
});
