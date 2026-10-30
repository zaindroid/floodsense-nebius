import { describe, expect, it } from "vitest";
import { fromGauge, fromModel } from "./euWatch";
import { evidenceForMemories, evidenceForReplay, evidenceForSource } from "./liveEvidence";
import { storyMoments, shortWhen } from "./story";
import { REPLAY_EVENTS, buildFrames, type ReplayReading } from "./disasterReplay";

const gauge = fromGauge({
  station: "KÖLN",
  water: "RHEIN",
  levelCm: 300,
  measuredAt: "2026-10-27T10:00:00Z",
  trend: null,
  history: [],
  source: "pegelonline",
  status: "ok",
  warningLevelCm: 620,
  meanLevelCm: 290,
  stale: false,
  origin: "live",
  lat: 50.9,
  lon: 6.9,
})!;
const model = fromModel({
  point_id: "EU05",
  name: "Budapest",
  country: "HU",
  river: "Danube",
  lat: 47.5,
  lon: 19,
  discharge_m3s: 1500,
  forecast_max_m3s: 1600,
  past30_median_m3s: 1400,
  band: "ok",
  basis: "",
  source: "open-meteo-flood-glofas",
  as_of_date: "2026-10-27",
});

describe("source drawer content", () => {
  it("explains a gauge reading", () => {
    const e = evidenceForSource(gauge, { queryId: "q-123", executedAt: "2026-10-27T10:05:00Z" });
    expect(e.pipeline.join(" → ")).toBe(
      "PEGELONLINE REST (WSV) → FloodSense poller every 10 min → Zetaris file store → view floodsense.gauge_levels",
    );
    expect(e.queryId).toBe("q-123");
    expect(e.measuredAt).toBe("2026-10-27T10:00:00Z");
    expect(e.fetchedAt).toBe("2026-10-27T10:05:00Z");
    expect(e.licence).toMatch(/DL-DE-Zero-2.0/);
    expect(e.link?.href).toBe("https://www.pegelonline.wsv.de/");
    expect(e.notes.join(" ")).toMatch(/Not an official warning/);
    // Same rule as ingestion/feeds/pegel_poll.py: near = level >= MHW - 0.25 * (MHW - MW).
    expect(e.notes.join(" ")).toMatch(/within 25 % of the MW\.\.MHW span below MHW/);
    expect(e.notes.join(" ")).toMatch(/long-term mean high water .*not a warning level/);
    expect(e.notes.join(" ")).not.toMatch(/80 %|official characteristic/);
    expect(e.timeLabel).toBe("Measured");
    expect(e.freshness).toBe("Live");
  });
  it("explains a GloFAS model point", () => {
    const e = evidenceForSource(model, { queryId: null, fetchedAt: Date.UTC(2026, 9, 27, 10, 0, 0) });
    expect(e.pipeline.join(" → ")).toBe("Open-Meteo Flood API → Zetaris REST table → view floodsense.eu_watch");
    expect(e.view).toBe("floodsense.eu_watch");
    expect(e.fetchedAt).toBe("2026-10-27T10:00:00Z");
    expect(e.licence).toMatch(/CC BY 4.0/);
    expect(e.link?.href).toBe("https://open-meteo.com/en/docs/flood-api");
    expect(e.notes.join(" ")).toMatch(/Model.*not an official warning|Not an official warning/);
    expect(e.timeLabel).toBe("Modelled");
  });
  it("lists an agent answer's memories", () => {
    const e = evidenceForMemories([
      { memoryId: "m1", runId: "r1", claimId: null, approvedAt: null, text: "Paiporta flooded", relevance: null, reviewer: null, seeded: false },
      { memoryId: "m2", runId: null, claimId: null, approvedAt: null, text: "Seeded", relevance: null, reviewer: "demo-seed", seeded: true },
    ]);
    expect(e.memories).toEqual([
      { label: "H-MEM · approved run r1", text: "Paiporta flooded" },
      { label: "H-MEM · Demo seed", text: "Seeded" },
    ]);
  });
  it("labels a replay moment as a replay", () => {
    const e = evidenceForReplay("Ahr", "2021-07-14T00:00:00Z", { fromZetaris: false, badge: "Bundled" }, "rain", 120);
    expect(e.freshness).toBe("Replay");
    expect(e.notes.join(" ")).toMatch(/The 120 m³\/s line/);
    expect(e.timeLabel).toBe("Modelled");
    expect(e.pipeline.join(" ")).toMatch(/not from Zetaris/);
  });
});

describe("replay story moments", () => {
  const event = REPLAY_EVENTS[0];
  const points = [
    { point_id: "AHR01", name: "Altenahr" },
    { point_id: "AHR02", name: "Bad Neuenahr" },
  ];
  const rows: ReplayReading[] = [];
  for (let h = 0; h < 72; h++) {
    const ts = new Date(Date.UTC(2021, 6, 13, h)).toISOString();
    const day = Math.floor(h / 24);
    rows.push({ point_id: "AHR01", ts_utc: ts, rain_mm: h === 30 ? 12.5 : 1, discharge_m3s: [40, 150, 300][day] });
    rows.push({ point_id: "AHR02", ts_utc: ts, rain_mm: 0.5, discharge_m3s: [30, 60, 420][day] });
  }
  const frames = buildFrames(rows, event);

  it("derives 3-5 sentences in time order, daily values by end of the day, and always the peak", () => {
    const m = storyMoments(rows, points, frames, event, true);
    expect(m.length).toBeGreaterThanOrEqual(3);
    expect(m.length).toBeLessThanOrEqual(5);
    expect(m.map((x) => x.text)).toEqual([
      "14 Jul, 06:00 — the heaviest rain fell at Altenahr: 12.5 mm in one hour.",
      "By end of 14 Jul — river flow at Altenahr crossed the 100 m³/s alert line (daily value).",
      "By end of 15 Jul — river flow at Bad Neuenahr crossed the 100 m³/s alert line and peaked at about 420 m³/s (daily value).",
    ]);
    expect([...m].sort((a, b) => a.sortKey.localeCompare(b.sortKey))).toEqual(m);
    // A daily value never carries an hour.
    expect(m.filter((x) => x.daily).every((x) => x.iso.length === 10 && !/\d\d:\d\d/.test(x.text))).toBe(true);
  });
  it("keeps a separate peak sentence when the peak is not on a crossing day", () => {
    const more = rows.map((r) => (r.point_id === "AHR01" && r.ts_utc.startsWith("2021-07-15") ? { ...r, discharge_m3s: 500 } : r));
    const m = storyMoments(more, points, frames, event, true);
    expect(m.map((x) => x.text)).toContain("By end of 15 Jul — river flow peaked at Altenahr, about 500 m³/s (daily value).");
  });
  it("keeps a daily crossing after an hourly rain moment later the same day", () => {
    const late = rows.map((r) => (r.point_id === "AHR01" && r.ts_utc === "2021-07-14T18:00:00.000Z" ? { ...r, rain_mm: 20 } : r));
    const m = storyMoments(late, points, frames, event, true);
    expect(m[0].text).toMatch(/^14 Jul, 18:00 — the heaviest rain/);
    expect(m[1].text).toMatch(/^By end of 14 Jul — river flow at Altenahr crossed/);
  });
  it("is empty without frames, and dates by hour for hourly data", () => {
    expect(storyMoments(rows, points, [], event, true)).toEqual([]);
    expect(shortWhen("2021-07-14T18:00:00Z", false)).toBe("14 Jul, 18:00");
    expect(shortWhen("2021-07-14T18:00:00Z", true)).toBe("14 Jul");
  });
});
