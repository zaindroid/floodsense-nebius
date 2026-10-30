import { describe, expect, it } from "vitest";
import { boxStatuses, feedsMode, zetarisHealth } from "./howItWorks";
import { parseSystem } from "./system";

const config = {
  kind: "ok" as const,
  body: {
    flags: { FF_LIVE_DATA: false, FF_HMEM: true, FF_RAG_DOCS: true, FF_HITL: true },
    lanes: { fast: "nvidia/nemotron-3.5-lightning-30b-a3b", deep: "nvidia/nemotron-3.5-lightning-30b-a3b" },
  },
};

/** The api/app/system.py shape. */
const system = parseSystem({
  memory: { ok: true, count: 3, seeded: 3, latest: [] },
  cache: { backend: "redis", semantic_cache: true, hits: 1, misses: 2 },
  rate_limit: { runs_per_min_per_client: 6, max_concurrent_runs: 2, in_flight: 0 },
  engines: { configured: true, ok: true },
  world_model: { run_id: "r1", hypotheses: 2, by_status: { supported: 2 } },
  models: { ok: true, lanes: { fast: "nvidia/x", deep: "nvidia/y" } },
  rag: { enabled: true, documents: null, passages: null },
});

describe("boxStatuses", () => {
  it("reads the real /system shape", () => {
    const s = boxStatuses(config, system);
    expect(s).toMatchObject({ agents: "ok", nightshift: "ok", memory: "ok", rag: "ok", redis: "ok", human: "ok", feeds: "off" });
  });

  it("shows engines down as memory down, and an in-process cache as off", () => {
    const down = parseSystem({ memory: { ok: false }, engines: { configured: true, ok: false }, cache: { backend: "memory" }, models: { ok: true } });
    const s = boxStatuses(config, down);
    expect(s.memory).toBe("down");
    expect(s.redis).toBe("off");
  });

  it("without /system (404) falls back to /config, never red", () => {
    const s = boxStatuses(config, null);
    expect(s.agents).toBe("ok");
    expect(s.nightshift).toBe("ok");
    expect(s.memory).toBe("ok");
    expect(s.redis).toBe("unknown");
    expect(Object.values(s)).not.toContain("down");
  });

  it("marks the agents unreachable when the API is down", () => {
    const s = boxStatuses({ kind: "down" }, null);
    expect(s.agents).toBe("down");
    expect(s.human).toBe("unknown");
  });

  it("names seed data or live feeds", () => {
    expect(feedsMode(config)).toBe("seed data");
    expect(feedsMode({ kind: "ok", body: { flags: { FF_LIVE_DATA: true } } })).toBe("live feeds");
    expect(feedsMode({ kind: "down" })).toBeNull();
  });
});

describe("zetarisHealth", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const ok = { hits: 5, misses: 1, staleServes: 0, lastError: null, lastOkAt: null };
  const bad = (detail: string, at = "2026-10-27T11:55:00Z") => ({ hits: 0, misses: 2, staleServes: 2, lastError: { at, detail }, lastOkAt: null as string | null });
  it("is running when reads work and none fail", () => {
    expect(zetarisHealth({ gauge_levels: ok }, null, now).state).toBe("ok");
    expect(zetarisHealth({ gauge_levels: { ...ok, lastError: { at: "2026-10-27T11:00:00Z", detail: "429" } } }, null, now).state).toBe("ok");
  });
  it("is running when the view recovered after its last error, and a bad timestamp counts as old", () => {
    const recovered = { ...bad("timeout"), lastOkAt: "2026-10-27T11:58:00Z" };
    expect(zetarisHealth({ eu_watch: recovered, gauge_levels: ok }, null, now).state).toBe("ok");
    expect(zetarisHealth({ eu_watch: { ...recovered, lastOkAt: "2026-10-27T11:50:00Z" }, gauge_levels: ok }, null, now).state).toBe("partial");
    expect(zetarisHealth({ eu_watch: bad("timeout", "not a date"), gauge_levels: ok }, null, now).state).toBe("ok");
  });
  it("is amber when some views fail, and never red for a rate limit", () => {
    const r = zetarisHealth({ gauge_levels: ok, hazard_now: bad("upstream 429 Too Many Requests") }, "rows", now);
    expect(r).toEqual({ state: "partial", note: "feed rate-limited by Open-Meteo" });
    expect(zetarisHealth({ gauge_levels: ok, eu_watch: bad("timeout") }, null, now)).toEqual({ state: "partial", note: "some views are failing: eu_watch" });
    expect(zetarisHealth({ eu_watch: bad("429") }, null, now).state).toBe("partial");
  });
  it("is not reachable only when every read fails for another reason", () => {
    expect(zetarisHealth({ gauge_levels: bad("connection refused"), eu_watch: bad("timeout") }, "unavailable", now).state).toBe("down");
  });
  it("falls back to the gauge read, then to unknown", () => {
    expect(zetarisHealth(null, "rows", now).state).toBe("ok");
    expect(zetarisHealth(null, "unavailable", now).state).toBe("down");
    expect(zetarisHealth(null, null, now).state).toBe("unknown");
    expect(zetarisHealth({}, null, now).state).toBe("unknown");
  });
  it("drives the Zetaris box of boxStatuses", () => {
    const sys = parseSystem({ views_cache: { views: { gauge_levels: { hits: 3, misses: 1 } } }, models: { ok: true } });
    expect(boxStatuses(config, sys, null, now).zetaris).toBe("ok");
    expect(boxStatuses(config, null, null, now).zetaris).toBe("unknown");
  });
});
