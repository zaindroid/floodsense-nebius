import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import sample from "../../fixtures/run_f16733274f1c.json";
import { adoptReplay } from "../../api/replay";
import { parsePlatformStatus } from "../../api/platform";
import { parseSystem } from "../../lib/system";
import { memoryRecall, readsFromCitations, usageOfRun } from "../../lib/stack";
import { CacheCard } from "./CacheCard";
import { EnginesCard } from "./EnginesCard";
import { ModelsCard } from "./ModelsCard";
import { PoolCard } from "./PoolCard";
import { RateLimitCard } from "./RateLimitCard";
import { StackPage } from "./StackPage";
import { ZetarisCard } from "./ZetarisCard";

const run = adoptReplay(sample, "run_f16733274f1c")!;
const platform = parsePlatformStatus({
  llm_backend: "nebius",
  lanes: { fast: "nvidia/nemotron-3.5-lightning-30b-a3b", deep: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
  latency: { fast: { n: 2, p50_ms: 800, p95_ms: 1500 } },
  cache: { backend: "redis", hits: 3, misses: 1, hit_rate: 0.75 },
  rate_limit: { in_flight: 1, max_concurrent: 2, runs_per_min: 6, rejected_429_recent: 0, rejected_429_total: 2 },
  llm_usage: { lanes: { fast: { calls: 4, total_tokens: 1200, avg_latency_ms: 700 } } },
});
const system = parseSystem({ memory: { ok: true, count: 7 }, engines: { ok: true, wm_events: 12 }, world_model: { hypotheses: 3 }, cache: { keys: { cache: 5 } } });

describe("card render smoke", () => {
  it("models card: data and no data", () => {
    const withData = renderToStaticMarkup(h(ModelsCard, { platform, runUsage: usageOfRun({ lanes: { deep: { calls: 2, total_tokens: 50 } } }), runKind: "replay", platformKind: "live" }));
    expect(withData).toContain("REPLAY");
    expect(withData).toContain("Nemotron 3.5 Super VL");
    const empty = renderToStaticMarkup(h(ModelsCard, { platform: null, runUsage: null, runKind: "none", platformKind: "none" }));
    expect(empty).toContain("NO DATA");
    expect(empty).toContain("No token counters yet");
  });
  it("pool card: sample run, no run, live", () => {
    expect(renderToStaticMarkup(h(PoolCard, { run, kind: "sample", live: null, maxConcurrent: 2, inFlight: 0 }))).toContain("SAMPLE");
    expect(renderToStaticMarkup(h(PoolCard, { run: null, kind: "none", live: null, maxConcurrent: null, inFlight: null }))).toContain("No run with a trace yet");
  });
  it("zetaris card", () => {
    const html = renderToStaticMarkup(h(ZetarisCard, { reads: readsFromCitations(run.claims), kind: "sample", runId: run.runId }));
    expect(html).toContain("only SQL path");
    expect(renderToStaticMarkup(h(ZetarisCard, { reads: [], kind: "none", runId: null }))).toContain("no Zetaris queries");
  });
  it("engines card", () => {
    const html = renderToStaticMarkup(h(EnginesCard, { system, recalled: memoryRecall(sample), recalledKind: "sample" }));
    expect(html).toContain("Approve, then remember");
    expect(renderToStaticMarkup(h(EnginesCard, { system: null, recalled: [], recalledKind: "none" }))).toContain("NO DATA");
  });
  it("cache and rate cards", () => {
    expect(renderToStaticMarkup(h(CacheCard, { platform, system }))).toContain("75%");
    expect(renderToStaticMarkup(h(CacheCard, { platform: null, system: null }))).toContain("not reported");
    expect(renderToStaticMarkup(h(RateLimitCard, { platform }))).toContain("1 of 2");
    expect(renderToStaticMarkup(h(RateLimitCard, { platform: null }))).toContain("not reported");
  });
  it("page renders its seven cards before data arrives", () => {
    const html = renderToStaticMarkup(h(StackPage));
    expect((html.match(/data-card=/g) ?? []).length).toBe(7);
  });
});
