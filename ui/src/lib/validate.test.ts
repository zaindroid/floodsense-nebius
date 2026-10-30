import { describe, expect, it } from "vitest";
import { asDischargeRow, asHazardRow, asProvenanceRow, assertAnswer, parseRows } from "./validate";

const provenance = {
  dataset: "Open-Meteo Flood API (GloFAS discharge)",
  source_url: "https://open-meteo.com/en/docs/flood-api",
  publisher: "Open-Meteo",
  licence: "CC BY 4.0",
  attribution: "Weather data by Open-Meteo.com",
  fetched_at: "2026-10-23T00:00:00Z",
};

describe("asProvenanceRow", () => {
  it("keeps http and https URLs", () => {
    expect(asProvenanceRow(provenance)?.source_url).toBe(provenance.source_url);
    expect(asProvenanceRow({ ...provenance, source_url: "http://example.com/data" })?.source_url).toBe(
      "http://example.com/data",
    );
  });

  it("rejects javascript: and other non-http URLs", () => {
    expect(asProvenanceRow({ ...provenance, source_url: "javascript:alert(1)" })).toBeNull();
    expect(asProvenanceRow({ ...provenance, source_url: "urn:floodsense:fixture:x" })).toBeNull();
    expect(asProvenanceRow({ ...provenance, source_url: "data:text/html,hi" })).toBeNull();
  });
});

describe("asHazardRow", () => {
  const base = {
    point_id: "VAL01",
    ts_utc: "2024-10-29T12:00:00Z",
    rain_mm: 16.4,
    discharge_m3s: 31.06,
    warning_level: null,
  };

  it("allows a null or missing discharge and a missing warning_level", () => {
    expect(asHazardRow({ ...base, discharge_m3s: null })?.discharge_m3s).toBeNull();
    expect(
      asHazardRow({
        point_id: base.point_id,
        ts_utc: base.ts_utc,
        rain_mm: base.rain_mm,
        warning_level: null,
      })?.discharge_m3s,
    ).toBeNull();
    expect(
      asHazardRow({
        point_id: base.point_id,
        ts_utc: base.ts_utc,
        rain_mm: base.rain_mm,
        discharge_m3s: base.discharge_m3s,
      })?.warning_level,
    ).toBeNull();
  });

  it("rejects a non-numeric discharge and a non-string warning_level", () => {
    expect(asHazardRow({ ...base, discharge_m3s: "high" })).toBeNull();
    expect(asHazardRow({ ...base, warning_level: 2 })).toBeNull();
  });

  it("stores a zone-less ts_utc as UTC", () => {
    expect(asHazardRow({ ...base, ts_utc: "2024-10-29 12:00:00" })?.ts_utc).toBe("2024-10-29T12:00:00Z");
    expect(asHazardRow({ ...base, ts_utc: "2024-10-29T12:00:00" })?.ts_utc).toBe("2024-10-29T12:00:00Z");
    expect(asHazardRow({ ...base, ts_utc: "2024-10-29T12:00:00+02:00" })?.ts_utc).toBe(
      "2024-10-29T12:00:00+02:00",
    );
  });
});

describe("parseRows", () => {
  it("returns an empty array for [] and null for a bad body", () => {
    expect(parseRows([], asDischargeRow)).toEqual([]);
    expect(parseRows({}, asDischargeRow)).toBeNull();
    expect(parseRows([{ point_id: "VAL01" }], asDischargeRow)).toBeNull();
  });
});

describe("assertAnswer", () => {
  const answer = {
    run_id: "run_1",
    served_from: "replay",
    cached_at: "2026-10-24T14:32:00Z",
    claims: [{ claim_id: "c", text: "t" }],
    citations: [{ source_url: "https://open-meteo.com/en/docs/flood-api" }],
    evidence: [],
  };

  it("accepts an https citation and rejects javascript:", () => {
    expect(assertAnswer(answer).run_id).toBe("run_1");
    expect(() =>
      assertAnswer({
        ...answer,
        citations: [{ source_url: "javascript:alert(1)" }],
      }),
    ).toThrow(/http or https/);
  });
});
