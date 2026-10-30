import { describe, expect, it } from "vitest";
import { cacheInfoOf, dataTime, staleNote, staleStripText, staleViews } from "./staleness";
import { modeStripText } from "./mode";

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
const NOW = Date.parse("2026-10-27T10:30:00Z");

describe("cacheInfoOf", () => {
  it("reads a stale copy and derives when the good reading was", () => {
    const i = cacheInfoOf("eu_watch", headers({ "x-views-cache": "stale", "x-views-age-s": "720" }), NOW);
    expect(i).toEqual({ view: "eu_watch", cache: "stale", ageS: 720, goodAt: NOW - 720_000 });
  });
  it("treats a missing or odd header as unknown, never stale", () => {
    expect(cacheInfoOf("eu_watch", headers({}), NOW).cache).toBeNull();
    expect(cacheInfoOf("eu_watch", headers({ "x-views-cache": "weird" }), NOW).cache).toBeNull();
    expect(cacheInfoOf("eu_watch", undefined, NOW).goodAt).toBeNull();
    expect(cacheInfoOf("x", headers({ "x-views-cache": "hit", "x-views-age-s": "-3" }), NOW).ageS).toBeNull();
  });
});

describe("data time", () => {
  it("prefers the copy executed-at over the browser fetch time", () => {
    const i = cacheInfoOf("eu_watch", headers({ "x-views-cache": "hit", "x-views-age-s": "540", "x-executed-at": "2026-10-27T10:21:00Z" }), NOW);
    expect(dataTime(i, NOW)).toBe(Date.parse("2026-10-27T10:21:00Z"));
    expect(dataTime(null, NOW)).toBe(NOW);
  });
  it("the strip age ticks with the clock", () => {
    const s = [{ view: "eu_watch", goodAt: NOW - 600_000 }];
    expect(staleStripText(s, NOW)).toBe("view eu_watch is 10 min old");
    expect(staleStripText(s, NOW + 300_000)).toBe("view eu_watch is 15 min old");
  });
});

describe("stale notes", () => {
  const stale = staleViews([
    cacheInfoOf("eu_watch", headers({ "x-views-cache": "stale", "x-views-age-s": "1500" }), NOW),
    cacheInfoOf("gauge_levels", headers({ "x-views-cache": "hit", "x-views-age-s": "20" }), NOW),
    null,
  ]);
  it("keeps only the stale views", () => expect(stale.map((s) => s.view)).toEqual(["eu_watch"]));
  it("says when the last good reading was, in UTC", () => {
    expect(staleNote(stale)).toBe("Last good reading from 10:05 UTC (live source temporarily unavailable)");
    expect(staleNote([])).toBeNull();
  });
  it("labels the strip with the age and never calls it plain live", () => {
    expect(staleStripText(stale, NOW)).toBe("view eu_watch is 25 min old");
    expect(modeStripText({ mode: "live", demo: false, eventId: "ahr2021" } as never, NOW, { loaded: 45, total: 45, failed: [], loading: false, stale }, "now", NOW)).toBe(
      "Live data · view eu_watch is 25 min old",
    );
  });
  it("names several views", () => {
    const two = [...stale, { view: "hazard_now", goodAt: NOW - 60_000 }];
    expect(staleStripText(two, NOW)).toBe("views eu_watch, hazard_now are 25 min old");
  });
});
