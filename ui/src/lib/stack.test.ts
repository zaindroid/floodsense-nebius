import { describe, expect, it } from "vitest";
import sample from "../fixtures/run_f16733274f1c.json";
import { adoptReplay } from "../api/replay";
import { initialLiveState, liveReducer } from "./liveRun";
import {
  countStart,
  easeCount,
  judgeChips,
  nextPollMs,
  hitRateOf,
  loopsAt,
  memoryRecall,
  nodeStatesAt,
  nodesFromLive,
  readsFromCitations,
  ringDash,
  slotLights,
  sourceOfView,
  traceFrames,
  usageOfRun,
  viewReads,
} from "./stack";

const run = adoptReplay(sample, "run_f16733274f1c")!;

describe("trace to node states", () => {
  const frames = traceFrames(run.trace);
  it("keeps only the 8 core agents, in order", () => {
    expect(frames.length).toBeGreaterThan(8);
    expect(frames.some((f) => (f.node as string) === "world_model")).toBe(false);
    expect(frames[0].node).toBe("scope");
  });
  it("lights the played frame, finishes earlier ones, leaves the rest idle", () => {
    const at = nodeStatesAt(frames, 2);
    expect(at.find((n) => n.id === "scope")?.state).toBe("done");
    expect(at.find((n) => n.id === "watchers")?.state).toBe("active");
    expect(at.find((n) => n.id === "judge")?.state).toBe("idle");
  });
  it("sums latency and counts repeated runs", () => {
    const end = nodeStatesAt(frames, frames.length);
    const sk = end.find((n) => n.id === "skeptic")!;
    expect(sk.runs).toBeGreaterThan(1);
    expect(sk.latencyMs).toBeGreaterThan(0);
    expect(sk.modelId).toContain("nemotron");
  });
  it("counts revise and repair loops only up to the played frame", () => {
    expect(loopsAt(frames, 1)).toEqual({ revise: 0, repair: 0 });
    expect(loopsAt(frames, frames.length).revise).toBe(1);
  });
  it("handles null or empty traces", () => {
    expect(traceFrames(null)).toEqual([]);
    expect(nodeStatesAt([], 3).every((n) => n.state === "idle")).toBe(true);
  });
  it("maps a live SSE state to the same node shape", () => {
    let s = initialLiveState("r1");
    s = liveReducer(s, { type: "started", data: { node: "scope" } });
    expect(nodesFromLive(s).find((n) => n.id === "scope")?.state).toBe("active");
    s = liveReducer(s, { type: "trace", data: { seq: 1, node: "scope", summary: "ok", latency_ms: 5 } });
    const scope = nodesFromLive(s).find((n) => n.id === "scope")!;
    expect(scope.state).toBe("done");
    expect(scope.latencyMs).toBe(5);
  });
});

describe("usage to counters", () => {
  it("reads lanes, models and cost from a run body", () => {
    const u = usageOfRun({
      lanes: { fast: { calls: 3, total_tokens: 900, avg_latency_ms: 400 }, deep: { calls: 1, total_tokens: 2000, avg_latency_ms: null } },
      models: [{ lane: "fast", model_id: "nvidia/nemotron-3.5-lightning-30b-a3b" }],
      cost_usd: null,
    })!;
    expect(u.totalCalls).toBe(4);
    expect(u.totalTokens).toBe(2900);
    expect(u.lanes[0].modelIds).toEqual(["nvidia/nemotron-3.5-lightning-30b-a3b"]);
    expect(u.lanes[1].avgLatencyMs).toBeNull();
    expect(u.costUsd).toBeNull();
  });
  it("returns null for missing, null or empty usage", () => {
    expect(usageOfRun(undefined)).toBeNull();
    expect(usageOfRun(null)).toBeNull();
    expect(usageOfRun({ lanes: {} })).toBeNull();
  });
  it("eases a count between two values", () => {
    expect(easeCount(0, 100, 0)).toBe(0);
    expect(easeCount(0, 100, 1)).toBe(100);
    expect(easeCount(0, 100, 5)).toBe(100);
    expect(easeCount(10, 20, 0.5)).toBeGreaterThan(15);
  });
});

describe("zetaris, memory, cache, limits", () => {
  it("lists one read per query with its upstream", () => {
    const r = viewReads({ q1: { query_id: "q1", view: "floodsense.gauge_levels", row_count: 12 }, q2: { view: "floodsense.hazard_now", error: "boom" } });
    expect(r[0]).toMatchObject({ queryId: "q1", rows: 12, source: "PEGELONLINE", failed: false });
    expect(r[1]).toMatchObject({ queryId: "q2", rows: null, failed: true, source: "Open-Meteo" });
    expect(viewReads(null)).toEqual([]);
    expect(sourceOfView("floodsense_seed.gauge_levels")).toBe("Seed CSVs");
  });
  it("falls back to layer a citations with unknown row counts", () => {
    const reads = readsFromCitations(run.claims);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((x) => x.rows === null)).toBe(true);
  });
  it("recalls memory text from memory_used or memories", () => {
    expect(memoryRecall(sample).length).toBeGreaterThan(0);
    expect(memoryRecall({ memory_used: [{ memory_id: "m", text: "x".repeat(300) }] })[0].text.length).toBeLessThan(150);
    expect(memoryRecall({})).toEqual([]);
  });
  it("hit rate is null with no lookups", () => {
    expect(hitRateOf(0, 0)).toBeNull();
    expect(hitRateOf(3, 1)).toBe(0.75);
    expect(ringDash(null, 10)).toMatch(/^0\.00 /);
  });
  it("lights as many slots as in flight, capped", () => {
    expect(slotLights(1, 2)).toEqual([true, false]);
    expect(slotLights(5, 2)).toEqual([true, true]);
    expect(slotLights(0, 999)).toHaveLength(12);
  });
  it("count-up starts at the value for static data", () => {
    expect(countStart(null, 42)).toBe(42);
    expect(countStart(10, 42)).toBe(10);
  });
  it("judge chips never show a previous run's scores while another streams", () => {
    const prev = { runId: "old", judgeOverall: 0.9, judgePasses: true, judgeClaims: [{ score: 1 }] };
    expect(judgeChips(prev, true, true)).toBeNull();
    expect(judgeChips(prev, false, false)).toBeNull();
    expect(judgeChips(prev, false, true)).toMatchObject({ runId: "old", overall: 0.9, scores: [1] });
    expect(judgeChips(null, false, true)).toBeNull();
  });
  it("polling backs off on failures and waits while hidden", () => {
    expect(nextPollMs(5000, 0, false)).toBe(5000);
    expect(nextPollMs(5000, 2, false)).toBe(20000);
    expect(nextPollMs(5000, 9, false)).toBe(60000);
    expect(nextPollMs(5000, 0, true)).toBe(30000);
  });
});
