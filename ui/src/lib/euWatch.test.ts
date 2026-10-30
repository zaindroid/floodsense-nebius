import { describe, expect, it } from "vitest";
import { fetchEuWatch } from "../api/euWatch";
import { asEuWatchRow, buildSources, fromGauge, questionFor, riverName, sortSources, stationName } from "./euWatch";
import type { GaugeSummary } from "./gauges";

const BUDAPEST = {
  point_id: "EU08",
  name: "Budapest",
  country: "HU",
  river: "Danube",
  lat: 47.475,
  lon: 19.025,
  discharge_m3s: 1347.96,
  forecast_max_m3s: 1414.79,
  past30_median_m3s: 1136.63,
  band: "below",
  basis: "model, not an official warning",
  source: "Open-Meteo Flood API (GloFAS)",
  as_of_date: "2026-10-27",
};

function gauge(over: Partial<GaugeSummary> = {}): GaugeSummary {
  return {
    station: "DRESDEN",
    water: "ELBE",
    levelCm: 66,
    measuredAt: "2026-10-27T08:00:00Z",
    trend: null,
    history: [66],
    source: "ds_pegelonline",
    status: "ok",
    warningLevelCm: 458,
    meanLevelCm: 156,
    stale: false,
    origin: "live",
    lat: 51.05446,
    lon: 13.738832,
    ...over,
  };
}

describe("eu_watch rows", () => {
  it("parses a view row and maps the band to the marker colours", () => {
    const row = asEuWatchRow({ ...BUDAPEST, band: "above", lat: "47.475" });
    expect(row?.band).toBe("over");
    expect(row?.lat).toBe(47.475);
    expect(asEuWatchRow({ ...BUDAPEST, band: "weird" })?.band).toBe("unknown");
    expect(asEuWatchRow({ ...BUDAPEST, lat: null })).toBeNull();
  });

  it("keeps a seed row but marks it not live", () => {
    const seed = asEuWatchRow({ ...BUDAPEST, discharge_m3s: null, forecast_max_m3s: null, source: "seed:openmeteo_flood", band: "unknown" });
    const [s] = buildSources([], seed ? [seed] : []);
    expect(s.live).toBe(false);
    expect(s.value).toBe("no model reading");
  });
});

describe("watch sources", () => {
  it("builds one source per gauge and point, with an Ask question naming river and place", () => {
    const row = asEuWatchRow(BUDAPEST);
    const list = buildSources([gauge(), gauge({ station: "NOWHERE", lat: null })], row ? [row] : []);
    expect(list.map((s) => s.kind)).toEqual(["gauge", "model"]);
    expect(list[0].question).toBe("Is the Elbe at Dresden at risk right now?");
    expect(list[1].question).toBe(questionFor("Danube", "Budapest"));
    expect(list[1].value).toContain("1.2× 30-day median");
  });

  it("sorts raised sources first, then by ratio", () => {
    const row = asEuWatchRow(BUDAPEST);
    const list = buildSources(
      [gauge(), gauge({ station: "PASSAU DONAU", water: "DONAU", status: "near", levelCm: 800, warningLevelCm: 841 })],
      row ? [row] : [],
    );
    expect(sortSources(list, "status").map((s) => s.name)).toEqual(["Passau Donau", "Budapest", "Dresden"]);
    expect(sortSources(list, "river").map((s) => s.river)).toEqual(["Danube", "Danube", "Elbe"]);
    expect(sortSources(list, "country")[0].country).toBe("DE");
  });

  it("names rivers and stations for people", () => {
    expect(riverName("DONAU")).toBe("Danube");
    expect(stationName("FRANKFURT1 (ODER)")).toBe("Frankfurt1 (Oder)");
    expect(stationName("MAGDEBURG-STROMBRÜCKE")).toBe("Magdeburg-Strombrücke");
    expect(fromGauge(gauge({ lon: null }))).toBeNull();
  });
});

describe("fetchEuWatch", () => {
  it("reads the view through the API and keeps the Zetaris query id", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify([BUDAPEST]), { status: 200, headers: { "x-query-id": "abc12345-q" } })) as typeof fetch;
    const load = await fetchEuWatch(undefined, fetcher);
    expect(load.state).toBe("rows");
    expect(load.queryId).toBe("abc12345-q");
    expect(load.rows[0].point_id).toBe("EU08");
  });

  it("reports an unavailable view instead of inventing rows", async () => {
    const fetcher = (async () => new Response("no", { status: 502 })) as typeof fetch;
    const load = await fetchEuWatch(undefined, fetcher);
    expect(load.state).toBe("unavailable");
    expect(load.rows).toEqual([]);
  });
});
