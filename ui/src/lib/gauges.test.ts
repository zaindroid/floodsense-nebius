import { describe, expect, it } from "vitest";
import { fetchGaugeLevels } from "../api/gauges";
import { asGaugeRow, escapeHtml, gaugeOrigin, gaugesLabel, isLiveGauge, stationPosition, summariseGauges } from "./gauges";

const row = (station: string, ts: string, level: number) => ({
  station,
  water: "RHEIN",
  ts_utc: ts,
  level_cm: level,
  source: "pegelonline",
});

describe("gauge_levels rows", () => {
  it("parses the view columns and rejects bad rows", () => {
    expect(asGaugeRow(row("BONN", "2026-10-27 10:00:00", 312))?.ts_utc).toBe("2026-10-27T10:00:00Z");
    expect(asGaugeRow({ station: "BONN", ts_utc: "x", level_cm: 1 })).toBeNull();
    expect(asGaugeRow({ station: "", ts_utc: "2026-10-27T10:00:00Z", level_cm: 1 })).toBeNull();
  });

  it("keeps the latest reading per station with a trend, and never invents a threshold", () => {
    const rows = [row("BONN", "2026-10-27T09:00:00Z", 300), row("BONN", "2026-10-27T10:00:00Z", 310), row("KÖLN", "2026-10-27T10:00:00Z", 280)]
      .map(asGaugeRow)
      .filter((r) => r !== null);
    const out = summariseGauges(rows);
    const bonn = out.find((g) => g.station === "BONN");
    expect(bonn?.levelCm).toBe(310);
    expect(bonn?.trend).toBe("rising");
    expect(bonn?.status).toBe("unknown");
    expect(bonn?.warningLevelCm).toBeNull();
    expect(out.find((g) => g.station === "KÖLN")?.trend).toBeNull();
  });

  it("reads the live columns, coercing numbers sent as strings", () => {
    const parsed = asGaugeRow({
      station: "MAINZ",
      water: "RHEIN",
      ts_utc: "2026-10-27 00:00:00.0",
      level_cm: 153.0,
      source: "ds_pegelonline",
      lat: "50.003995",
      lon: "8.275319",
      trend_cm_h: "-1.0",
      mw_cm: "288.0",
      mhw_cm: "547.0",
      band: "near",
      fetched_at: "2026-10-27 00:05:53.0",
      is_stale: "false",
    });
    expect(parsed).not.toBeNull();
    const [g] = summariseGauges([parsed!]);
    expect(g).toMatchObject({ lat: 50.003995, lon: 8.275319, status: "near", trend: "falling", warningLevelCm: 547, meanLevelCm: 288, stale: false });
  });

  it("treats is_stale true or missing as stale", () => {
    expect(asGaugeRow({ ...row("BONN", "2026-10-27T10:00:00Z", 1), is_stale: true })?.is_stale).toBe(true);
    expect(asGaugeRow(row("BONN", "2026-10-27T10:00:00Z", 1))?.is_stale).toBe(true);
  });

  it("is Live only for a live-source, fresh row; seed, fixture and stale rows never are", () => {
    const fresh = { ...row("MAINZ", "2026-10-27T10:00:00Z", 1), source: "ds_pegelonline", is_stale: false };
    const one = (r: Record<string, unknown>) => summariseGauges([asGaugeRow(r)!]);
    expect(isLiveGauge(one(fresh)[0])).toBe(true);
    expect(gaugesLabel(one(fresh))).toBe("Live");
    expect(isLiveGauge(one({ ...fresh, is_stale: true })[0])).toBe(false);
    expect(gaugesLabel(one({ ...fresh, is_stale: true }))).toBe("Stale");
    expect(gaugesLabel(one({ ...fresh, source: "seed:pegelonline" }))).toBe("Seed");
    expect(gaugesLabel(one({ ...fresh, source: "fixture" }))).toBe("Fixture");
    expect(gaugeOrigin("ds_pegelonline_replay")).toBe("seed");
    expect(gaugesLabel([])).toBeNull();
  });

  it("escapes tooltip HTML", () => {
    expect(escapeHtml('<b>"x"&</b>')).toBe("&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;");
  });

  it("places known stations, folding umlauts", () => {
    expect(stationPosition("Köln")).not.toBeNull();
    expect(stationPosition("KOELN")).toEqual(stationPosition("Köln"));
    expect(stationPosition("Nowhere")).toBeNull();
  });
});

describe("fetchGaugeLevels", () => {
  const respond = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reports an empty view as empty, not live", async () => {
    expect((await fetchGaugeLevels(undefined, respond([]))).state).toBe("empty");
  });
  it("reports rows as live", async () => {
    const load = await fetchGaugeLevels(undefined, respond([row("BONN", "2026-10-27T10:00:00Z", 1)]));
    expect(load.state).toBe("rows");
    expect(load.rows).toHaveLength(1);
  });
  it("reports errors and bad shapes as unavailable", async () => {
    expect((await fetchGaugeLevels(undefined, respond([], 500))).state).toBe("unavailable");
    expect((await fetchGaugeLevels(undefined, respond({ rows: [] }))).state).toBe("unavailable");
  });
});
