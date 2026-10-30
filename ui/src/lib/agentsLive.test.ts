import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import sample from "../fixtures/run_f16733274f1c.json";
import { parsePlatformStatus } from "../api/platform";
import { adoptReplay } from "../api/replay";
import { AgentsLive } from "../components/agents/AgentsLive";
import type { StackData } from "../hooks/useStackData";
import {
  cacheLine,
  handoffAt,
  handoffLive,
  laneRows,
  rateView,
  replayDelayMs,
  replayNext,
  retryDeadline,
  secondsLeft,
  servedBadge,
  sourceKind,
  startReplay,
  toolChips,
  wireOn,
} from "./agentsLive";
import { initialLiveState, liveReducer } from "./liveRun";
import { nodeStatesAt, nodesFromLive, traceFrames, type Frame } from "./stack";

const f = (node: Frame["node"], latencyMs: number | null = null): Frame => ({ node, latencyMs, modelId: null, summary: "" });
const platform = parsePlatformStatus({
  llm_backend: "nebius",
  lanes: { fast: "nvidia/nemotron-3.5-lightning-30b-a3b" },
  latency: { fast: { n: 2, p50_ms: 800, p95_ms: 1500 } },
  cache: { backend: "redis", hits: 3, misses: 1, hit_rate: 0.75 },
  rate_limit: { in_flight: 1, max_concurrent: 2, runs_per_min: 6, rejected_429_recent: 0, rejected_429_total: 2 },
  llm_usage: { lanes: { fast: { calls: 4, total_tokens: 1200, avg_latency_ms: 700 } } },
});

describe("source badge", () => {
  it("live only while a run streams; a finished streamed run is a replay", () => {
    expect(sourceKind(initialLiveState("r1"), null)).toBe("live");
    expect(sourceKind(null, { kind: "live" })).toBe("replay");
    expect(sourceKind(null, { kind: "replay" })).toBe("replay");
    expect(sourceKind(null, { kind: "sample" })).toBe("sample");
    expect(sourceKind(null, null)).toBe("none");
  });
});

describe("replay timer", () => {
  it("clamps the delay and loops after the hold", () => {
    expect(replayDelayMs(f("scope", 50))).toBe(500);
    expect(replayDelayMs(f("scope", 10_000))).toBe(1000);
    expect(replayDelayMs(f("scope", 999_999))).toBe(1600);
    expect(replayDelayMs(f("scope"))).toBe(800);
    expect(replayDelayMs(undefined)).toBe(800);
    expect(replayNext(0, 3)).toBe(1);
    expect(replayNext(3, 3)).toBe(0);
  });
});

describe("handoff", () => {
  const frames = [f("scope"), f("watchers"), f("investigator"), f("skeptic"), f("investigator")];
  it("replay: previous step to the one just played, loops included", () => {
    expect(handoffAt(frames, 1)).toBeNull();
    expect(handoffAt(frames, 2)).toEqual({ from: "scope", to: "watchers" });
    expect(handoffAt(frames, 5)).toEqual({ from: "skeptic", to: "investigator" });
    expect(handoffAt([f("judge"), f("judge")], 2)).toBeNull();
  });
  it("wire lights only between adjacent agents", () => {
    expect(wireOn({ from: "scope", to: "watchers" }, 0)).toBe(true);
    expect(wireOn({ from: "skeptic", to: "investigator" }, 3)).toBe(false);
    expect(wireOn(null, 0)).toBe(false);
  });
  it("live: from the nearest finished agent before the running one", () => {
    let s = initialLiveState("r1");
    s = liveReducer(s, { type: "trace", data: { seq: 1, node: "scope", summary: "ok", duration_ms: 40 } });
    s = liveReducer(s, { type: "started", data: { node: "investigator" } });
    expect(handoffLive(nodesFromLive(s))).toEqual({ from: "scope", to: "investigator" });
    expect(handoffLive(nodesFromLive(initialLiveState("r2")))).toBeNull();
  });
});

describe("tool chips", () => {
  const ctx = {
    reads: [
      { queryId: "q1", view: "floodsense.gauge_levels", rows: 3, failed: false, source: "PEGELONLINE" },
      { queryId: "q2", view: "floodsense.exposure_join", rows: 9, failed: false, source: "Copernicus EMS" },
      { queryId: "q3", view: "floodsense.discharge_daily", rows: 9, failed: false, source: "Open-Meteo" },
    ],
    recalled: 2,
    worldModelSteps: 3,
  };
  it("attach only evidenced tools to the agent that used them", () => {
    expect(toolChips("memory", ctx)).toEqual(["H-MEM recall x2"]);
    expect(toolChips("watchers", ctx)).toEqual(["Zetaris SQL: gauge_levels"]);
    expect(toolChips("exposure", ctx)).toEqual(["Zetaris SQL: exposure_join"]);
    expect(toolChips("investigator", ctx)).toEqual(["Zetaris SQL x1 view reads"]);
    expect(toolChips("skeptic", ctx)).toEqual(["World Model x3"]);
    expect(toolChips("judge", ctx)).toEqual([]);
    expect(toolChips("memory", { reads: [], recalled: 0, worldModelSteps: 0 })).toEqual([]);
  });
});

describe("cache, rate limit, lanes", () => {
  it("badges and counters come from the response, none when absent", () => {
    expect(servedBadge("cache").text).toBe("Cache hit");
    expect(servedBadge(null).tone).toBe("none");
    expect(cacheLine(platform)).toBe("3 hits · 1 miss · 75% hit rate");
    expect(cacheLine(null)).toBeNull();
    expect(cacheLine(parsePlatformStatus({}))).toContain("no lookups yet");
  });
  it("rate view and Retry-After countdown", () => {
    const r = rateView(platform)!;
    expect(r.lights).toEqual([true, false]);
    expect(r.runsPerMin).toBe(6);
    expect(rateView(null)).toBeNull();
    const until = retryDeadline(30, 1_000);
    expect(until).toBe(31_000);
    expect(secondsLeft(until, 1_000)).toBe(30);
    expect(secondsLeft(until, 30_500)).toBe(1);
    expect(secondsLeft(until, 31_000)).toBeNull();
    expect(secondsLeft(null, 5)).toBeNull();
    expect(retryDeadline(null, 5)).toBeNull();
  });
  it("lane rows join model, usage and latency", () => {
    expect(laneRows(platform)).toEqual([{ lane: "fast", model: "nvidia/nemotron-3.5-lightning-30b-a3b", calls: 4, tokens: 1200, avgMs: 700, p50Ms: 800 }]);
    expect(laneRows(null)).toEqual([]);
  });
});

describe("<AgentsLive/> render", () => {
  const run = adoptReplay(sample, "run_f16733274f1c")!;
  const stack = (over: Partial<StackData>): StackData => ({
    platform: { data: platform, error: null, loading: false },
    system: { data: null, error: null, loading: false },
    stackRun: null,
    live: null,
    runsError: null,
    ...over,
  });
  it("a recorded run is badged REPLAY or SAMPLE, never LIVE", () => {
    const html = renderToStaticMarkup(h(AgentsLive, { stack: stack({ stackRun: { raw: sample, run, kind: "replay" } }) }));
    expect(html).toContain("REPLAY");
    expect(html).not.toContain(">LIVE<");
    expect(renderToStaticMarkup(h(AgentsLive, { stack: stack({ stackRun: { raw: sample, run, kind: "sample" } }) }))).toContain("SAMPLE");
  });
  it("a streaming run is LIVE; compact drops the lanes; no data says so", () => {
    const live = renderToStaticMarkup(h(AgentsLive, { stack: stack({ live: initialLiveState("r9") }) }));
    expect(live).toContain("LIVE");
    expect(live).toContain("Model lanes");
    const compact = renderToStaticMarkup(h(AgentsLive, { compact: true, stack: stack({ live: initialLiveState("r9") }) }));
    expect(compact).not.toContain("Model lanes");
    expect(renderToStaticMarkup(h(AgentsLive, { stack: stack({ platform: { data: null, error: "x", loading: false } }) }))).toContain("NO DATA");
  });
  it("first replay frame has every later agent idle", () => {
    expect(traceFrames(run.trace).length).toBeGreaterThan(0);
    expect(nodeStatesAt(traceFrames(run.trace), 0).every((n) => n.state === "idle")).toBe(true);
  });
});

describe("review fixes", () => {
  it("a stream that ended is not LIVE even while `live` is still held", () => {
    const ended = liveReducer(initialLiveState("r1"), { type: "status", data: { status: "answered" } });
    expect(sourceKind(ended, { kind: "live" })).toBe("replay");
    expect(sourceKind(ended, null)).toBe("none");
  });
  it("recorded badge reads as a fact about a past run", () => {
    expect(servedBadge("cache", true).text).toBe("Recorded run: cache hit");
    expect(servedBadge("cache").text).toBe("Cache hit");
  });
  it("startReplay steps, holds, loops and cleanup stops it", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const stop = startReplay([f("scope", 5000), f("judge", 5000)], (n) => seen.push(n));
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([0, 1, 2, 0]);
    stop();
    vi.advanceTimersByTime(60000);
    expect(seen).toEqual([0, 1, 2, 0]);
    vi.useRealTimers();
  });
});
