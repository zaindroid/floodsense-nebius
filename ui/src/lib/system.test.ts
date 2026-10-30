import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SystemCards } from "../components/SystemPanel";
import { countText, hitRate, laneLabel, liveSummary, modelName, parseSystem, shortUtc } from "./system";

const body = {
  counters_since_utc: "2026-10-27T08:00:00Z",
  cache: {
    backend: "redis",
    semantic_cache: true,
    keys: { cache: 2, replay: 2, demo: 1 },
    hits: 3,
    misses: 1,
    replays_served: 0,
    seeded_runs: ["r1"],
  },
  rate_limit: {
    runs_per_min_per_client: 10,
    max_concurrent_runs: 2,
    in_flight: 1,
    rejected_429_recent: 2,
    rejected_429_total: 2,
  },
  engines: { configured: true, ok: true, error: null, wm_events: 9 },
  memory: {
    ok: true,
    count: 5,
    seeded: 1,
    latest: [
      {
        id: "m1",
        run_id: "demo-seed-ahr-altenahr",
        approved_at: "2026-10-27T09:12:00.000Z",
        text: "Daily discharge for Altenahr (AHR01) was 249.61 m3/s on 2021-07-14.",
        seeded: true,
      },
      { id: "m2", run_id: "r1", approved_at: null, text: "Paiporta finding", seeded: false },
    ],
  },
  world_model: { run_id: "r1", hypotheses: 2, by_status: { supported: 1, challenged: 1 } },
  models: {
    ok: true,
    lanes: { fast: "meterless/fast", deep: "meterless/deep" },
    latest_model_ids: ["nvidia/nemotron-3.5-lightning-30b-a3b"],
  },
  rag: { enabled: true, documents: null, passages: null },
};

describe("parseSystem", () => {
  it("reads every section", () => {
    const s = parseSystem(body)!;
    expect(s.cache.backend).toBe("redis");
    expect(s.cache.keys.replay).toBe(2);
    expect(s.rateLimit).toEqual({ perMin: 10, maxConcurrent: 2, inFlight: 1, recent429: 2, total429: 2 });
    expect(s.memory.latest[0].seeded).toBe(true);
    expect(s.memory.latest[1].seeded).toBe(false);
    expect(s.world.byStatus).toEqual({ supported: 1, challenged: 1 });
  });

  it("survives an empty or broken body", () => {
    expect(parseSystem(null)).toBeNull();
    expect(parseSystem([])).toBeNull();
    const s = parseSystem({ memory: { latest: "nope" }, cache: { hits: "3" } })!;
    expect(s.memory.latest).toEqual([]);
    expect(s.memory.count).toBeNull();
    expect(s.cache.hits).toBe(0);
    expect(s.cache.backend).toBe("unknown");
  });
});

describe("helpers", () => {
  it("formats", () => {
    expect(hitRate(0, 0)).toBe("no lookups yet");
    expect(hitRate(3, 1)).toBe("3 of 4 (75%)");
    expect(laneLabel("fast", "meterless/fast")).toBe("Fast lane: meterless/fast");
    expect(modelName("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("Nemotron 3.5 Lightning 30B A3B");
    expect(modelName("acme/model")).toBe("acme/model");
    expect(countText(null)).toBe("–");
    expect(shortUtc("2026-10-27T09:12:00.000Z")).toBe("27 Oct 09:12 UTC");
    expect(shortUtc(null)).toBe("–");
  });

  it("keeps the live summary free of the clock", () => {
    const s = parseSystem(body)!;
    const text = liveSummary(s, null);
    expect(text).toBe("5 remembered findings, 1 of 2 live runs in flight, 2 refused in the last 5 minutes, engines up.");
    expect(liveSummary(s, null)).toBe(text);
    expect(liveSummary(null, null)).toBe("");
    expect(liveSummary(null, "API not reached")).toContain("unavailable");
  });
});

describe("SystemCards", () => {
  const html = (status: ReturnType<typeof parseSystem>, error: string | null = null) =>
    renderToStaticMarkup(createElement(SystemCards, { status, error, checkedAt: null }));

  it("renders the four cards with plain captions and the seeded chip", () => {
    const out = html(parseSystem(body));
    for (const label of ['aria-label="Memory"', 'aria-label="Cache"', 'aria-label="Rate limits"', 'aria-label="Models and engines"']) {
      expect(out).toContain(label);
    }
    expect(out).toContain("Approved findings the agents can recall next time");
    expect(out).toContain("5 remembered findings");
    expect(out).toContain('class="chip chip--sample">seeded</span>');
    expect(out).toContain("Hits 3 of 4 (75%)");
    expect(out).toContain("1 of 2 live runs in flight");
    expect(out).toContain("Nemotron 3.5 Lightning 30B A3B");
    expect(out).toContain("engines up");
    expect(out).toContain("<h2>Nightshift</h2>");
    expect(out).not.toContain("Nightshift · nightshift");
    expect(out).toContain("1 of the latest 2 are");
    // Only the summary is live; the "Last checked" line is not.
    expect(out.match(/aria-live/g)?.length).toBe(1);
    expect(out).toMatch(/aria-live="polite"[^>]*>5 remembered findings/);
    expect(out).toContain("counts not exposed");
  });

  it("shows an error and no numbers before the first answer", () => {
    const out = html(null, "API not reached at http://localhost:18000/system");
    expect(out).toContain("API not reached");
    expect(out).not.toContain("seeded</span>");
  });
});
