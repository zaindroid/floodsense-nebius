import { describe, expect, it } from "vitest";
import {
  asGaugeLevelRow,
  asHazardNowRow,
  latestPastStamp,
  parseList,
  relativeTime,
  sparkSeries,
  summariseAll,
  summarisePoint,
  trendOf,
  type HazardNowRow,
} from "./now";

const BASE = Date.UTC(2026, 9, 23, 0);
const HOUR = 3_600_000;

function stamp(hour: number): string {
  return new Date(BASE + hour * HOUR).toISOString().replace("T", " ").replace(".000Z", ".0");
}

function raw(point: string, hour: number, horizon: "past" | "forecast", discharge: number | null, rain: number | null = 0) {
  return { point_id: point, ts_utc: stamp(hour), rain_mm: rain, discharge_m3s: discharge, warning_level: null, horizon };
}

function rows(items: unknown[]): HazardNowRow[] {
  return parseList(items, asHazardNowRow)!.rows;
}

describe("asHazardNowRow", () => {
  it("parses a Zetaris row as UTC", () => {
    const row = asHazardNowRow(raw("VAL01", 0, "past", 65.37));
    expect(row?.ts_utc).toBe("2026-10-23T00:00:00.0Z");
    expect(row?.t).toBe(BASE);
    expect(row?.horizon).toBe("past");
  });

  it("drops bad rows without nulling the set", () => {
    const parsed = parseList(
      [
        raw("VAL01", 0, "past", 1),
        { ...raw("VAL01", 1, "past", 1), horizon: "later" },
        { ...raw("VAL01", 2, "past", 1), ts_utc: "yesterday" },
        { ...raw("VAL01", 3, "past", 1), discharge_m3s: "high" },
        null,
      ],
      asHazardNowRow,
    );
    expect(parsed?.rows).toHaveLength(1);
    expect(parsed?.dropped).toBe(4);
    expect(parseList({ rows: [] }, asHazardNowRow)).toBeNull();
  });

  it("keeps null discharge and rain", () => {
    const row = asHazardNowRow(raw("VAL01", 0, "past", null, null));
    expect(row?.discharge_m3s).toBeNull();
    expect(row?.rain_mm).toBeNull();
  });
});

describe("summarisePoint", () => {
  const items: unknown[] = [];
  for (let h = 0; h <= 72; h += 1) items.push(raw("VAL01", h, "past", 10 + h, h >= 49 ? 1 : 0));
  for (let h = 73; h <= 130; h += 1) items.push(raw("VAL01", h, "forecast", h === 100 ? 500 : 20));
  items.push(raw("VAL02", 5, "past", 3));
  const all = rows(items);

  it("takes the latest past row, last-hour and 24 h rain", () => {
    const s = summarisePoint("VAL01", all);
    expect(s.latest?.t).toBe(BASE + 72 * HOUR);
    expect(s.latest?.discharge_m3s).toBe(82);
    expect(s.rainLastHour).toBe(1);
    expect(s.rain24h).toBe(24);
  });

  it("compares with 24 h ago", () => {
    const s = summarisePoint("VAL01", all);
    expect(s.discharge24hAgo).toBe(58);
    expect(s.trend).toBe("up");
  });

  it("finds the forecast max within 48 h only", () => {
    const s = summarisePoint("VAL01", all);
    expect(s.forecastMax).toEqual({ discharge_m3s: 500, ts_utc: all.find((r) => r.discharge_m3s === 500)!.ts_utc });
    expect(s.forecast).toHaveLength(48);
    expect(s.past).toHaveLength(72);
  });

  it("is unknown without a 24 h comparison", () => {
    const s = summarisePoint("VAL02", all);
    expect(s.trend).toBe("unknown");
    expect(s.forecastMax).toBeNull();
  });

  it("handles empty input", () => {
    expect(summariseAll([])).toEqual([]);
    expect(latestPastStamp([])).toBeNull();
    const s = summarisePoint("VAL01", []);
    expect(s.latest).toBeNull();
    expect(s.rain24h).toBeNull();
    expect(s.forecastMax).toBeNull();
  });

  it("summarises every point and finds the newest past stamp", () => {
    expect(summariseAll(all).map((s) => s.point_id)).toEqual(["VAL01", "VAL02"]);
    expect(latestPastStamp(all)).toBe("2026-10-26T00:00:00.0Z");
  });
});

describe("helpers", () => {
  it("trend tolerates small wobble", () => {
    expect(trendOf(100, 99)).toBe("flat");
    expect(trendOf(80, 100)).toBe("down");
    expect(trendOf(null, 1)).toBe("unknown");
  });

  it("relative time", () => {
    expect(relativeTime(0, 10_000)).toBe("just now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5 min ago");
    expect(relativeTime(0, 3 * HOUR)).toBe("3 h ago");
    expect(relativeTime(0, 59.6 * 60_000)).toBe("1 h ago");
    expect(relativeTime(0, 59.4 * 60_000)).toBe("59 min ago");
  });

  it("sparkline drops null discharge and splits on the last past value", () => {
    const s = summarisePoint(
      "VAL09",
      rows([
        raw("VAL09", 0, "past", 5),
        raw("VAL09", 1, "past", null),
        raw("VAL09", 2, "past", 7),
        raw("VAL09", 3, "forecast", null),
        raw("VAL09", 4, "forecast", 9),
      ]),
    );
    expect(sparkSeries(s)).toEqual({ values: [5, 7, 9], split: 1 });
  });

  it("gauge rows need a station", () => {
    expect(asGaugeLevelRow({ station: "KAUB", water: "RHEIN", ts_utc: "2026-10-26 10:00:00", level_cm: 212, source: "x" })?.level_cm).toBe(212);
    expect(asGaugeLevelRow({ station: "KAUB", level_cm: null })?.level_cm).toBeNull();
    expect(asGaugeLevelRow({ level_cm: 3 })).toBeNull();
  });
});
