import { describe, expect, it } from "vitest";
import { platformLines } from "../components/SystemPanel";
import { fetchPlatformStatus, parsePlatformStatus } from "./platform";

describe("parsePlatformStatus", () => {
  it("reads the API shape", () => {
    const s = parsePlatformStatus({
      agents_ok: true, llm_backend: "nebius", lanes: { fast: "a", deep: "b" }, data_backend: "zetaris", tavily: false,
      latency: { quick: { n: 3, p50_ms: 10, p95_ms: 20 } },
      cache: { backend: "redis", hits: 1, misses: 3, hit_rate: 0.25 },
      rate_limit: { in_flight: 0, max_concurrent: 2, runs_per_min: 6, rejected_429_recent: 1, rejected_429_total: 4 },
      live_sources: 7,
    });
    expect(s?.llmBackend).toBe("nebius");
    expect(s?.latency.quick.p95Ms).toBe(20);
    expect(s?.rateLimit.total429).toBe(4);
    expect(s?.liveSources).toBe(7);
  });
  it("survives junk", () => {
    expect(parsePlatformStatus([])).toBeNull();
    expect(parsePlatformStatus({})?.dataBackend).toBe("zetaris");
  });
});

describe("platformLines", () => {
  it("handles a sparse status", () => {
    const s = parsePlatformStatus({ llm_backend: "nebius", lanes: { fast: "m1" }, tavily: false, cache: {}, rate_limit: {} })!;
    const out = platformLines(s).join("\n");
    expect(out).toContain("LLM backend: nebius (fast: m1)");
    expect(out).toContain("Cache hit rate: –");
    expect(out).toContain("LLM check: not run yet");
    expect(out).toContain("LLM usage: not reported");
  });
});

describe("platformLines more", () => {
  it("null backend and cost present", () => {
    const s = parsePlatformStatus({ llm_usage: { lanes: { fast: { calls: 1, total_tokens: 10 } }, cost_usd: 0.0123, price_note: "n" } })!;
    const out = platformLines(s).join("\n");
    expect(out).toContain("LLM backend: unknown");
    expect(out).toContain("cost $0.0123");
  });
  it("parses lane pricing, limits and region", () => {
    const s = parsePlatformStatus({
      llm_usage: {
        lanes: {},
        cost_usd: 0.002,
        cost_per_answer_usd: 0.001,
        answers: 2,
        pricing: { fast: { model_id: "m", price_per_m_input: 0.06, price_per_m_output: 0.24, rpm_limit: 1000, country: "FI", region: "eu-north1" } },
      },
    })!;
    expect(s.llmUsage!.costPerAnswerUsd).toBe(0.001);
    expect(s.llmUsage!.pricing.fast).toMatchObject({ pricePerMInput: 0.06, rpmLimit: 1000, country: "FI", pricePerMCacheRead: null });
  });
  it("absent pricing and answers default safely", () => {
    const s = parsePlatformStatus({ llm_usage: { lanes: {}, cost_usd: null } })!;
    expect(s.llmUsage).toMatchObject({ costUsd: null, costPerAnswerUsd: null, answers: 0, pricing: {} });
  });
  it("fetch failure is an error string", async () => {
    const r = await fetchPlatformStatus("http://127.0.0.1:1");
    expect(r.status).toBeNull();
    expect(r.error).toContain("API not reached");
  });
});
