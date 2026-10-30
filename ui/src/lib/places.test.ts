import { describe, expect, it } from "vitest";
import { fromGauge, fromModel, fromValencia, type WatchSource } from "./euWatch";
import type { GaugeSummary } from "./gauges";
import {
  basisLabel,
  buildPlaces,
  calmSentence,
  headlineCounts,
  headlineText,
  oldestFetch,
  questionForPlace,
  quickPlaces,
  replayEventOfPlace,
  searchPlaces,
  statusView,
  timeWord,
  worstFirst,
} from "./places";
import { humanBox } from "./howItWorks";

const gauge = (station: string, water: string, status: GaugeSummary["status"], level = 300, mhw = 500): GaugeSummary => ({
  station,
  water,
  levelCm: level,
  measuredAt: "2026-10-27T10:00:00Z",
  trend: "steady",
  history: [],
  source: "pegelonline",
  status,
  warningLevelCm: mhw,
  meanLevelCm: 200,
  stale: false,
  origin: "live",
  lat: 50.9,
  lon: 6.9,
});

const model = (point_id: string, name: string, river: string, country: string, band: "ok" | "near" | "over") =>
  fromModel({
    point_id,
    name,
    country,
    river,
    lat: 47.5,
    lon: 19,
    discharge_m3s: 2000,
    forecast_max_m3s: 2500,
    past30_median_m3s: 1000,
    band,
    basis: "",
    source: "open-meteo-flood-glofas",
    as_of_date: "2026-10-27",
  });

const sources: WatchSource[] = [
  fromGauge(gauge("KÖLN", "RHEIN", "near", 420))!,
  fromGauge(gauge("DRESDEN", "ELBE", "ok"))!,
  fromGauge(gauge("PASSAU DONAU", "DONAU", "over", 700))!,
  model("EU05", "Budapest", "Danube", "HU", "ok"),
  model("EU01", "Paris", "Seine", "FR", "near"),
  fromValencia({ point_id: "VAL01", name: "Paiporta centre", lat: 39.4, lon: -0.4 }, { latest: { discharge_m3s: 2, ts_utc: "2026-10-27T09:00:00Z" }, forecastMax: { discharge_m3s: 3 } }, { watch: 20, warning: 80 }),
];

const places = buildPlaces(
  sources,
  [{ point_id: "VAL01", name: "Paiporta centre", municipality: "Paiporta" }],
  [{ point_id: "AHR01", name: "Altenahr" }],
);

describe("plain status mapping", () => {
  it("says Above / Close to mean high water for gauges, never red", () => {
    expect(statusView("gauge", "ok")).toMatchObject({ word: "Normal", tone: "normal" });
    expect(statusView("gauge", "near")).toMatchObject({ word: "Close to mean high water", tone: "watch", rank: 2 });
    expect(statusView("gauge", "over")).toMatchObject({ word: "Above mean high water", tone: "elevated", rank: 0 });
    for (const kind of ["gauge", "model", "valencia"] as const)
      for (const st of ["ok", "near", "over", "unknown"] as const) expect(statusView(kind, st).tone).not.toBe("warning");
    expect(statusView("gauge", "unknown")).toMatchObject({ word: "No reading", tone: "unknown" });
  });
  it("never says Warning or uses red for a model band", () => {
    expect(statusView("model", "near")).toMatchObject({ word: "Watch (model)", tone: "watch" });
    expect(statusView("model", "over")).toMatchObject({ word: "Elevated (model)", tone: "elevated" });
    expect(statusView("valencia", "near")).toMatchObject({ word: "Above its recent normal (model)", tone: "neutral" });
    expect(statusView("valencia", "over").tone).toBe("elevated");
    for (const kind of ["model", "valencia"] as const)
      for (const st of ["ok", "near", "over", "unknown"] as const) {
        expect(statusView(kind, st).word).not.toMatch(/warning/i);
        expect(statusView(kind, st).tone).not.toBe("warning");
      }
  });
  it("describes MHW as a long-term mean, not a warning level", () => {
    expect(basisLabel("gauge")).toMatch(/long-term mean high water \(not a warning level\)/);
    expect(basisLabel("gauge")).not.toMatch(/official/);
    expect(basisLabel("model")).toMatch(/model, not an official warning/);
    expect(basisLabel("valencia")).toMatch(/not official/);
    expect(timeWord("gauge")).toBe("Measured");
    expect(timeWord("model")).toBe("Modelled");
    expect(timeWord("valencia")).toBe("Modelled");
  });
  it("uses one calm sentence, keeping the place name's casing", () => {
    const s = calmSentence("gauge", "near", "Rhine", "Köln");
    expect(s).toMatch(/^The Rhine at Köln is close to its long-term mean high water \(not a warning level\)/);
    expect(s).not.toMatch(/\d/);
    expect(calmSentence("model", "ok", "Danube", "Budapest")).toBe("Our model shows normal river flow for the Danube at Budapest over the next 7 days.");
    expect(calmSentence("gauge", "unknown", "Rhine", "Köln")).toMatch(/no current reading/);
    const v = calmSentence("valencia", "near", "", "Alfafar centre");
    expect(v).toBe("Our model shows river flow at Alfafar centre at least twice its own recent normal (the past three days; not official).");
    expect(v).not.toMatch(/usual/);
  });
  it("keeps the elevated model sentence free of a seasonal remark", () => {
    const s = calmSentence("model", "over", "Loire", "Orleans");
    expect(s).not.toMatch(/seasonal/i);
    expect(s).toMatch(/Model, not an official warning\.$/);
  });
  it("sorts worst first and separates gauges from model points in the counts", () => {
    const order = worstFirst(sources).map((s) => s.name);
    expect(order[0]).toBe("Passau Donau");
    expect(order[1]).toBe("Köln");
    expect(order[2]).toBe("Paris");
    const c = headlineCounts(sources);
    expect(c).toMatchObject({ gaugesAbove: 1, gaugesNear: 1, modelElevated: 0, modelWatch: 1, normal: 3, unknown: 0, total: 6 });
    expect(headlineText(c)).toBe(
      "1 gauge above mean high water · 1 gauge close to mean high water · 1 model point slightly up · 3 normal",
    );
    expect(headlineText(headlineCounts([model("EU09", "Orleans", "Loire", "FR", "over")]))).toBe("1 model point elevated · 0 normal");
  });
  it("shows the oldest fetch time as Updated", () => {
    expect(oldestFetch([3000, null, 1000, undefined])).toBe(1000);
    expect(oldestFetch([null])).toBeNull();
  });
  it("bands Valencia points by the demo lines", () => {
    const v = (q: number) =>
      fromValencia({ point_id: "VAL02", name: "x", lat: 0, lon: 0 }, { latest: { discharge_m3s: q, ts_utc: "t" }, forecastMax: null }, { watch: 20, warning: 80 }).status;
    expect([v(5), v(25), v(90)]).toEqual(["ok", "near", "over"]);
  });
});

describe("place search", () => {
  it("covers gauges, EU points and replay places", () => {
    expect(places).toHaveLength(sources.length + 2);
    expect(searchPlaces(places, "koln").map((p) => p.name)).toEqual(["Köln"]);
    expect(searchPlaces(places, "danube").map((p) => p.name).sort()).toEqual(["Budapest", "Passau Donau"]);
    expect(searchPlaces(places, "hungary").map((p) => p.name)).toEqual(["Budapest"]);
    expect(searchPlaces(places, "paiporta").map((p) => p.id)).toEqual(["valencia:VAL01", "replay:VAL01"]);
    expect(searchPlaces(places, "ahr").map((p) => p.id)).toEqual(["replay:AHR01"]);
    expect(searchPlaces(places, "")).toHaveLength(places.length);
    expect(searchPlaces(places, "atlantis")).toEqual([]);
  });
  it("knows the replay event and the Ask question of a place", () => {
    expect(replayEventOfPlace("replay:VAL01")).toBe("EMSR773");
    expect(replayEventOfPlace("replay:AHR01")).toBe("EMSR517");
    expect(replayEventOfPlace("gauge:KÖLN")).toBeNull();
    expect(replayEventOfPlace(null)).toBeNull();
    expect(questionForPlace(places.find((p) => p.name === "Köln")!)).toBe("Is the Rhine at Köln at risk right now?");
    expect(questionForPlace(places.find((p) => p.id === "replay:AHR01")!)).toMatch(/Ahr flood of July 2021/);
  });
  it("always shows the chosen place in the picker's short list", () => {
    const ids = (chosen: string | null) => quickPlaces(places, sources, chosen).map((p) => p.id);
    expect(ids(null)).toEqual(["gauge:PASSAU DONAU", "gauge:KÖLN", "model:EU01", "replay:VAL01", "replay:AHR01"]);
    expect(ids("model:EU05")[0]).toBe("model:EU05");
    expect(ids("gauge:KÖLN").filter((id) => id === "gauge:KÖLN")).toHaveLength(1);
  });
  it("gives each place its country", () => {
    expect(places.find((p) => p.name === "Köln")!.country).toBe("DE");
    expect(places.find((p) => p.name === "Paris")!.country).toBe("FR");
    expect(places.find((p) => p.id === "replay:VAL01")!.country).toBe("ES");
  });
});

describe("How it works human box", () => {
  it("is reworded for citizens and kept for insurers", () => {
    expect(humanBox("citizen").line).toBe("Insurer alerts are checked by a person before they're sent. Your answers aren't held back.");
    expect(humanBox("insurer").title).toBe("Human approval");
  });
});
