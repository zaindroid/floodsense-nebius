import { describe, expect, it } from "vitest";
import { adoptRunBody } from "../api/replay";
import sample from "../fixtures/run_f16733274f1c.json";
import answer from "../fixtures/answer.json";
import type { Answer } from "../types/contract";
import { answerEventId, memoryLabel, sourceFromCitation, sourceFromRun, upstreamFor } from "./sources";
import { providerOf } from "./lanes";
import { modelChip, runModelLine } from "./modelChip";

const run = adoptRunBody(sample as unknown as Record<string, unknown>, "f16733274f1c")!;
const all = run.claims.flatMap((c) => c.citations);

describe("grounded sources", () => {
  it("Zetaris data shows the view, the query id and the upstream feed link", () => {
    const a = all.find((c) => c.layer === "a" && c.title.includes("discharge_daily"))!;
    const d = sourceFromRun(a, "EMSR773");
    expect(d.heading).toBe("Data via Zetaris");
    expect(d.facts).toContain("View floodsense.discharge_daily");
    expect(d.facts.some((f) => f.startsWith("Query id 1223e572"))).toBe(true);
    expect(d.link?.href).toBe("https://open-meteo.com/en/docs/flood-api");
    expect(upstreamFor("floodsense.gauge_levels")?.label).toBe("WSV PEGELONLINE");
  });

  it("a document shows title, publisher, page and paragraph, quote and the source URL", () => {
    const c = all.find((x) => x.layer === "c" && x.chunkId === "hess-29-6715-2025/p3/para1")!;
    const d = sourceFromRun(c, "EMSR773");
    expect(d.kind).toBe("document");
    expect(d.facts).toEqual(["Copernicus Publications", "Page 3, paragraph 1"]);
    expect(d.link?.href).toBe("https://hess.copernicus.org/articles/29/6715/2025/hess-29-6715-2025.pdf");
  });

  it("contract citations on Overview link to their source; seed views say so", () => {
    const first = (answer as unknown as Answer).citations[0];
    const d = sourceFromCitation(first, "EMSR773");
    expect(d.link?.href).toMatch(/^https:\/\/open-meteo\.com/);
    expect(d.facts).toContain("Seed data (recorded rows)");
  });

  it("memory labels name the approving run, or the demo seed", () => {
    expect(memoryLabel({ runId: "r42" })).toBe("H-MEM · approved run r42");
    expect(memoryLabel({ runId: null })).toBe("H-MEM · Demo seed");
  });
});

describe("model chip", () => {
  it("names the model and the Nightshift lane", () => {
    expect(modelChip("nvidia/nemotron-3.5-lightning-30b-a3b", "fast")).toBe("Nemotron 3.5 Lightning 30B · Nightshift fast lane");
    expect(modelChip("deterministic,nvidia/nemotron-3.5-lightning-30b-a3b", "deep")).toBe(
      "Nemotron 3.5 Lightning 30B · Nightshift deep lane",
    );
    expect(modelChip(null, "sql")).toBe("SQL · Zetaris");
    expect(modelChip("deterministic", "none")).toBe("rules");
    expect(modelChip("other-model-x", "fast")).toBe("other-model-x");
    expect(runModelLine(run.trace.map((s) => s.modelId ?? ""))).toBe("Nemotron 3.5 Lightning 30B via Nightshift");
  });
});

describe("upstream links", () => {
  it("exposure_join links to the synthetic portfolio, not Copernicus", () => {
    for (const ev of ["EMSR773", "EMSR517", "LIVE-EU", null]) {
      const l = upstreamFor("floodsense.exposure_join", ev);
      expect(l?.label).toBe("Synthetic insurer portfolio (demo data) · OSM sites");
      expect(l?.href).not.toMatch(/copernicus/);
    }
    const a = all.find((c) => c.layer === "a" && c.title.includes("exposure_join"))!;
    expect(sourceFromRun(a, run.eventId).link?.label).toBe("Synthetic insurer portfolio (demo data) · OSM sites");
  });

  it("footprint fields link to the run's own Copernicus activation (Ahr too), never a fallback", () => {
    expect(upstreamFor("floodsense.exposure_join", "EMSR517", "in_footprint")?.href).toBe(
      "https://mapping.emergency.copernicus.eu/activations/EMSR517",
    );
    expect(upstreamFor("floodsense.flood_footprint", "EMSR773")?.label).toBe("Copernicus EMS EMSR773");
    expect(upstreamFor("floodsense.flood_footprint", "LIVE-EU")).toBeNull();
    expect(upstreamFor("floodsense.flood_footprint", null)).toBeNull();
  });

  it("eu_watch links to the Open-Meteo Flood API as a model, not a warning", () => {
    const l = upstreamFor("floodsense.eu_watch", "LIVE-EU");
    expect(l?.href).toBe("https://open-meteo.com/en/docs/flood-api");
    expect(l?.label).toBe("Open-Meteo Flood API (GloFAS) · model, not an official warning");
  });

  it("reads the answer's own event id, including LIVE-EU", () => {
    expect(answerEventId({ ...(answer as unknown as Answer), event_id: "LIVE-EU" } as unknown as Answer)).toBe("LIVE-EU");
    expect(answerEventId(answer as unknown as Answer)).toBeNull();
  });
});

describe("providerOf", () => {
  it("uses the trace's explicit provider first, the id rule only without one", () => {
    expect(providerOf("nvidia/nemotron-3.5-lightning-30b-a3b", "openrouter")).toBe("openrouter");
    expect(providerOf("acme/model-x", "nightshift")).toBe("Nightshift");
    expect(providerOf("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("Nightshift");
    expect(providerOf("acme/model-x", null)).toBeNull();
    expect(providerOf("openai/gpt-x", "")).toBeNull();
    expect(modelChip("nvidia/nemotron-3.5-lightning-30b-a3b", "fast", "openrouter")).toBe("Nemotron 3.5 Lightning 30B · openrouter");
  });
});
