import { describe, expect, it } from "vitest";
import { parsePlatformStatus } from "./platform";

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
