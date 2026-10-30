import { describe, expect, it } from "vitest";
import { adoptRunBody } from "../api/replay";
import { WARNING_LINKS } from "./safety";
import {
  ENGLISH_NOTE,
  isNonEnglish,
  adoptPlain,
  calmApplies,
  calmChip,
  calmOrder,
  detailClaims,
  horizonWord,
  officialLinks,
  type PlainAnswer,
} from "./calmAnswer";

const PLAIN = {
  headline: "Nothing alarming expected at Budapest.",
  one_line: "The Danube at Budapest is expected to stay within its normal range this week.",
  horizon: "7d",
  status: "normal",
  basis: "model",
  places: ["Budapest"],
  country: "HU",
  countries: ["HU"],
  service: "HungaroMet and the water directorate (OVF, vizugy.hu)",
  context: "For context, from the past: Danube at Budapest, 21 September 2024: the river reached its highest level in around a decade. (history, from Wikipedia: 2024 Central European Floods, demo seed; not today's conditions)",
  next_step: "Ask me about another place or open the official warnings.",
  disclaimer: "Model-based check, not an official warning. Follow HungaroMet and the water directorate (OVF, vizugy.hu).",
  details: ["F2", "F1"],
};

const citation = (queryId: string, title = "floodsense.eu_watch") => ({
  layer: "a",
  title,
  query_id: queryId,
  citation_id: `c-${queryId}`,
});

const body = (over: Record<string, unknown> = {}) => ({
  run_id: "r1",
  served_from: "live",
  summary: "Status: Normal for Budapest.",
  lane: "forecast",
  claims: [
    { claim_id: "F1", text: "rain claim", citations: [citation("q1", "floodsense.weather_forecast")] },
    { claim_id: "F2", text: "river claim", citations: [citation("q2"), citation("q1", "floodsense.weather_forecast")] },
    { claim_id: "F3", text: "not in details", citations: [] },
  ],
  plain: PLAIN,
  ...over,
});

describe("adoptPlain", () => {
  it("adopts the agents' plain object word for word", () => {
    const p = adoptPlain(PLAIN) as PlainAnswer;
    expect(p.headline).toBe(PLAIN.headline);
    expect(p.oneLine).toBe(PLAIN.one_line);
    expect(p.disclaimer).toBe(PLAIN.disclaimer);
    expect(p.horizon).toBe("7d");
    expect(p.details).toEqual(["F2", "F1"]);
  });

  it("refuses an object without a headline, sentence, disclaimer or known status", () => {
    expect(adoptPlain(null)).toBeNull();
    expect(adoptPlain({})).toBeNull();
    expect(adoptPlain({ ...PLAIN, headline: "" })).toBeNull();
    expect(adoptPlain({ ...PLAIN, one_line: undefined })).toBeNull();
    expect(adoptPlain({ ...PLAIN, disclaimer: " " })).toBeNull();
    expect(adoptPlain({ ...PLAIN, status: "calm" })).toBeNull();
  });

  it("defaults an unknown horizon to 48h and a missing basis to model", () => {
    const p = adoptPlain({ ...PLAIN, horizon: "30d", basis: undefined }) as PlainAnswer;
    expect(p.horizon).toBe("48h");
    expect(p.basis).toBe("model");
  });
});

describe("calmApplies", () => {
  it("is for quick and forecast runs that carry a plain object, and nothing else", () => {
    expect(calmApplies(adoptRunBody(body(), "r1")!)).toBe(true);
    expect(calmApplies(adoptRunBody(body({ lane: "quick" }), "r1")!)).toBe(true);
    expect(calmApplies(adoptRunBody(body({ lane: "full" }), "r1")!)).toBe(false);
    expect(calmApplies(adoptRunBody(body({ lane: undefined }), "r1")!)).toBe(false);
    expect(calmApplies(adoptRunBody(body({ plain: undefined }), "r1")!)).toBe(false);
    expect(calmApplies(adoptRunBody(body({ plain: {} }), "r1")!)).toBe(false);
  });
});

describe("calmChip", () => {
  it("uses the statusView words and tones; no red for model bands or mean high water", () => {
    expect(calmChip({ status: "normal", basis: "model" })).toEqual({ word: "Normal", tone: "normal" });
    expect(calmChip({ status: "watch", basis: "model" })).toEqual({ word: "Watch (model)", tone: "watch" });
    expect(calmChip({ status: "elevated", basis: "model" })).toEqual({ word: "Elevated (model)", tone: "elevated" });
    expect(calmChip({ status: "elevated", basis: "gauge" })).toEqual({ word: "Above mean high water", tone: "elevated" });
    expect(calmChip({ status: "watch", basis: "gauge" })).toEqual({ word: "Close to mean high water", tone: "watch" });
    for (const status of ["normal", "watch", "elevated", "unknown"] as const) {
      for (const basis of ["gauge", "model"] as const) expect(calmChip({ status, basis }).tone).not.toBe("warning");
    }
  });

  it("does not call an unchecked place a normal one", () => {
    const chip = calmChip({ status: "unknown", basis: "model" });
    expect(chip.word).toBe("Not fully checked");
    expect(chip.tone).toBe("unknown");
  });
});

describe("horizonWord, calmOrder", () => {
  it("names the horizon", () => {
    expect(horizonWord({ horizon: "7d" })).toBe("This week");
    expect(horizonWord({ horizon: "48h" })).toBe("Next two days");
  });

  it("the insurer reads the claims first; everyone else the plain answer first", () => {
    expect(calmOrder("insurer")).toBe("details-first");
    expect(calmOrder("citizen")).toBe("plain-first");
    expect(calmOrder(undefined)).toBe("plain-first");
  });
});

describe("officialLinks", () => {
  it("takes the links from the safety allowlist only", () => {
    expect(officialLinks({ country: "DE" })).toEqual([WARNING_LINKS.de]);
    expect(officialLinks({ country: "ES" })).toEqual([WARNING_LINKS.es]);
    expect(officialLinks({ country: "HU" })).toEqual([WARNING_LINKS.eu]);
    const allowed = new Set(Object.values(WARNING_LINKS).flatMap((g) => g.links.map((l) => l.url)));
    for (const country of ["DE", "ES", "HU", "FR", null]) {
      for (const group of officialLinks({ country })) for (const link of group.links) expect(allowed.has(link.url)).toBe(true);
    }
  });
});

describe("officialLinks across countries", () => {
  it("shows each country's links once", () => {
    expect(officialLinks({ country: "DE", countries: ["DE", "ES", "DE"] })).toEqual([WARNING_LINKS.de, WARNING_LINKS.es]);
    expect(officialLinks({ country: "DE", countries: ["DE", "HU", "FR"] })).toEqual([WARNING_LINKS.de, WARNING_LINKS.eu]);
  });
});

describe("isNonEnglish", () => {
  it("flags German and Spanish questions, not English ones", () => {
    expect(isNonEnglish("Wie wird der Rhein in Bonn nächste Woche?")).toBe(true);
    expect(isNonEnglish("¿Subirá el Danubio esta semana?")).toBe(true);
    expect(isNonEnglish("Will the Danube at Budapest rise this week?")).toBe(false);
    expect(isNonEnglish("Do the next 48 hours look safe at Köln?")).toBe(false);
    expect(isNonEnglish(null)).toBe(false);
    expect(ENGLISH_NOTE).toBe("Answers are currently in English.");
  });
});

describe("detailClaims", () => {
  it("lists only the claims the plain object names, in the claims' own order, with one [n] per distinct source", () => {
    const run = adoptRunBody(body(), "r1")!;
    const rows = detailClaims(run);
    expect(rows.map((r) => r.claim.id)).toEqual(["F1", "F2"]);
    expect(rows[0].badges.map((b) => b.n)).toEqual([1]);
    expect(rows[1].badges.map((b) => b.n)).toEqual([2, 1]);
  });

  it("falls back to every claim when details name none of them", () => {
    const run = adoptRunBody(body({ plain: { ...PLAIN, details: ["X9"] } }), "r1")!;
    expect(detailClaims(run).map((r) => r.claim.id)).toEqual(["F1", "F2", "F3"]);
  });

  it("marks a claim the Judge flagged", () => {
    const run = adoptRunBody(body({ judge_summary: { flagged_claim_ids: ["F2"] } }), "r1")!;
    expect(detailClaims(run).map((r) => r.flagged)).toEqual([false, true]);
  });
});
