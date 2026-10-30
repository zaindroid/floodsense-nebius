import { describe, expect, it } from "vitest";
import { buildFrames, REPLAY_EVENTS, type ReplayReading } from "./disasterReplay";
import type { WatchSource } from "./euWatch";
import { groupByNearest, haversineKm, NEAR_KM, nearestSource, siteWatchLine } from "./nearest";
import { rehearsalAt, rehearsalQuestion } from "./rehearsal";

const src = (id: string, lat: number, lon: number, status: WatchSource["status"] = "ok"): WatchSource => ({
  id,
  kind: "model",
  name: id,
  river: "Ebro",
  country: "ES",
  lat,
  lon,
  status,
  ratio: null,
  value: "",
  live: true,
  question: "",
  measuredAt: null,
});

describe("nearest watched source per insured site", () => {
  const zaragoza = src("Zaragoza", 41.625, -0.825);
  const near = src("Nearby", 39.47, -0.4, "near");

  it("measures great-circle distance", () => {
    expect(Math.round(haversineKm({ lat: 39.46, lon: -0.43 }, { lat: 41.625, lon: -0.825 }))).toBe(243);
  });

  it("describes a site only from a source within the radius; farther it is only the nearest", () => {
    const site = { lat: 39.464, lon: -0.433 };
    expect(siteWatchLine(nearestSource(site, [zaragoza]))).toMatch(/too far to describe this site/);
    expect(siteWatchLine(nearestSource(site, [zaragoza, near]))).toMatch(/Watch \(model\)$/);
    expect(nearestSource({ lat: Number.NaN, lon: 0 }, [zaragoza])).toBeNull();
    expect(siteWatchLine(null)).toMatch(/No usable lat\/lon/);
  });

  it("groups sites by nearest source and counts unplaced ones", () => {
    const { groups, unplaced } = groupByNearest(
      [
        { lat: 39.46, lon: -0.43 },
        { lat: 39.5, lon: -0.4 },
        { lat: Number.NaN, lon: 1 },
      ],
      [zaragoza],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ sites: 2, near: false });
    expect(groups[0].minKm).toBeGreaterThan(NEAR_KM);
    expect(unplaced).toBe(1);
  });
});

describe("rehearsal timeline", () => {
  const ev = REPLAY_EVENTS[0];
  const rows: ReplayReading[] = [
    ["2021-07-13", 40],
    ["2021-07-14", 180],
    ["2021-07-15", 90],
  ].flatMap(([d, q]) => [0, 12].map((h) => ({ point_id: "AHR01", ts_utc: `${d}T${String(h).padStart(2, "0")}:00:00Z`, rain_mm: 0, discharge_m3s: q as number })));
  const frames = buildFrames(rows, ev);
  const points = [{ point_id: "AHR01", name: "Altenahr" }];

  it("offers the crossing only once the shown day reaches it", () => {
    expect(rehearsalAt(rows, frames, 100, 0, points)?.crossed).toBeNull();
    const day2 = rehearsalAt(rows, frames, 100, 2, points);
    expect(day2?.over).toEqual(["AHR01"]);
    expect(day2?.crossed).toMatchObject({ pointId: "AHR01", name: "Altenahr", iso: "2021-07-14T00:00:00Z" });
    // After the peak the crossing stays offered as the moment it turned.
    expect(rehearsalAt(rows, frames, 100, 4, points)?.crossed?.iso).toBe("2021-07-14T00:00:00Z");
  });

  it("asks about the day for daily discharge, never a made-up hour", () => {
    expect(rehearsalQuestion("Altenahr", "2021-07-14T00:00:00Z", 100, true)).toBe(
      "Rehearsal of a past flood: Altenahr crossed 100 m³/s on 14 Jul 2021. Which insured sites are exposed, and what should the insurer do?",
    );
  });
});
