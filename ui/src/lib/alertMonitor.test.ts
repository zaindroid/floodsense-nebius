import { describe, expect, it } from "vitest";
import { assessContext, assessQuestion, elevatedSources, monitorView, watchedCount } from "./alertMonitor";
import type { EuWatchRow } from "./euWatch";
import type { GaugeStatus, GaugeSummary } from "./gauges";

function gauge(station: string, status: GaugeStatus, over: Partial<GaugeSummary> = {}): GaugeSummary {
  return {
    station,
    water: "RHEIN",
    levelCm: 400,
    measuredAt: "2026-10-27T10:15:00Z",
    trend: "steady",
    history: [],
    source: "pegelonline",
    status,
    warningLevelCm: 500,
    meanLevelCm: 300,
    stale: false,
    origin: "live",
    lat: 50.9,
    lon: 6.9,
    ...over,
  };
}

function model(point_id: string, band: GaugeStatus, over: Partial<EuWatchRow> = {}): EuWatchRow {
  return {
    point_id,
    name: point_id === "EU08" ? "Budapest" : "Vienna",
    country: "HU",
    river: "Danube",
    lat: 47.5,
    lon: 19,
    discharge_m3s: 2000,
    forecast_max_m3s: 4000,
    past30_median_m3s: 1500,
    band,
    basis: "forecast max vs 2x median",
    source: "open-meteo-flood-glofas",
    as_of_date: "2026-10-27",
    ...over,
  };
}

const NOW = Date.UTC(2026, 9, 27, 11, 42);

describe("live alert monitor filtering", () => {
  it("lists only raised bands, worst first, in the shared status words (never Warning)", () => {
    const { rows } = elevatedSources({
      gauges: [gauge("KÖLN", "near"), gauge("BONN", "ok"), gauge("KAUB", "over"), gauge("MAINZ", "unknown")],
      points: [model("EU08", "near"), model("EU07", "ok")],
      gaugeQueryId: "q-gauge",
      modelQueryId: "q-model",
    });
    expect(rows.map((r) => [r.source.name, r.status.word, r.status.tone])).toEqual([
      ["Kaub", "Above mean high water", "elevated"],
      ["Köln", "Close to mean high water", "watch"],
      ["Budapest", "Watch (model)", "watch"],
    ]);
    expect(JSON.stringify(rows.map((r) => r.status))).not.toMatch(/Warning|warning/);
    expect(rows.find((r) => r.source.kind === "model")?.basis).toMatch(/model.*not an official warning/i);
    expect(rows[0].evidence).toMatchObject({ view: "floodsense.gauge_levels", queryId: "q-gauge" });
    expect(rows[0].evidence.link?.href).toBe("https://www.pegelonline.wsv.de/");
    expect(rows[2].evidence).toMatchObject({ view: "floodsense.eu_watch", queryId: "q-model" });
  });

  it("never raises a stale, seed or position-less reading", () => {
    const { rows, notLive } = elevatedSources({
      gauges: [gauge("KÖLN", "over", { stale: true }), gauge("BONN", "near", { origin: "seed" }), gauge("TRIER", "over", { lat: null, lon: null })],
      points: [model("EU08", "over", { source: "seed:open-meteo" })],
    });
    expect(rows).toEqual([]);
    expect(notLive).toBe(3);
  });

  it("says calm with the count and time when nothing is elevated", () => {
    const input = { gauges: [gauge("BONN", "ok"), gauge("KAUB", "ok")], points: [model("EU07", "ok")] };
    expect(watchedCount(input)).toBe(3);
    const view = monitorView({ ...input, state: "rows", checkedAt: NOW });
    expect(view.kind).toBe("calm");
    expect(view.text).toBe("All 3 live sources are below watch level · checked 11:42 UTC");
  });

  it("does not call a source without a threshold 'below'", () => {
    const view = monitorView({ gauges: [gauge("BONN", "ok"), gauge("MAINZ", "unknown")], points: [], state: "rows", checkedAt: NOW });
    expect(view.text).toBe("No watched source is at watch level: 1 of 2 below, 1 without a threshold · checked 11:42 UTC");
  });

  it("headlines the alert count and reports an unreadable view as unavailable, not calm", () => {
    const alerts = monitorView({ gauges: [gauge("KAUB", "over"), gauge("BONN", "ok")], points: [model("EU08", "near")], state: "rows", checkedAt: NOW });
    expect(alerts).toMatchObject({ kind: "alerts", text: "1 Above mean high water, 1 Watch (model) of 3 live sources · checked 11:42 UTC" });
    expect(monitorView({ gauges: [], points: [], state: "unavailable", checkedAt: NOW }).kind).toBe("unavailable");
    expect(monitorView({ gauges: [], points: [], state: "loading", checkedAt: null }).kind).toBe("loading");
    expect(monitorView({ gauges: [gauge("BONN", "ok")], points: [], missing: ["GloFAS points"], state: "rows", checkedAt: NOW }).text).toBe(
      "None of the 1 live sources read is at watch level · checked 11:42 UTC · GloFAS points could not be read",
    );
  });

  it("builds an insurer run request context the agents' RunContext accepts", () => {
    const [kaub] = elevatedSources({ gauges: [gauge("KAUB", "over")], points: [] }).rows;
    expect(assessContext(kaub)).toEqual({ role: "insurer", page: "alerts", place: "Kaub", station: "KAUB" });
    expect(assessQuestion(kaub)).toMatch(/insured sites near Kaub on the Rhine/);
    const [frankfurt] = elevatedSources({ gauges: [gauge("FRANKFURT1 (ODER)", "over")], points: [] }).rows;
    // Digits and brackets break the agents' station pattern: the station is left out, the place stays.
    expect(assessContext(frankfurt)).toEqual({ role: "insurer", page: "alerts", place: "Frankfurt1 (Oder)" });
  });
});

describe("Valencia demo points in the monitor", () => {
  const val = (id: string, status: GaugeStatus) => ({
    id: `valencia:${id}`,
    kind: "valencia" as const,
    name: "Paiporta centre",
    river: "",
    country: "ES",
    lat: 39.43,
    lon: -0.42,
    status,
    ratio: 1.2,
    value: "up to 95.0 m³/s (now and next 48 h)",
    live: true,
    question: "",
    measuredAt: "2026-10-27T10:00:00Z",
  });

  it("raises them through statusView, labelled as a demo line, and counts live + demo separately", () => {
    const input = { gauges: [gauge("BONN", "ok")], points: [model("EU07", "ok")], valencia: [val("VAL01", "over"), val("VAL02", "ok")] };
    const { rows } = elevatedSources(input);
    expect(rows).toHaveLength(1);
    expect(rows[0].status.word).toBe("Far above its recent normal (model)");
    expect(rows[0].basis).toMatch(/own past three days, not official/);
    expect(assessContext(rows[0])).toMatchObject({ point_id: "VAL01", place: "Paiporta centre" });
    expect(assessQuestion(rows[0])).not.toMatch(/on the  /);
    const view = monitorView({ ...input, state: "rows", checkedAt: NOW });
    expect(view.text).toBe("1 Far above its recent normal (model) of 2 live sources + 2 Valencia demo points · checked 11:42 UTC");
    const calm = monitorView({ gauges: [gauge("BONN", "ok")], points: [], valencia: [val("VAL02", "ok")], state: "rows", checkedAt: NOW });
    expect(calm.text).toBe("All 1 live sources + 1 Valencia demo points are below watch level · checked 11:42 UTC");
  });
});
