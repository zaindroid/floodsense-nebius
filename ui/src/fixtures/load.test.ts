import { describe, expect, it } from "vitest";
import { loadFixtures } from "./load";

describe("loadFixtures", () => {
  it("loads the trimmed provenance set and an answer with http citations", () => {
    const bundle = loadFixtures();
    expect(bundle.provenance).toHaveLength(6);
    expect(bundle.provenance.map((row) => row.dataset).join(" ")).not.toMatch(/PEGELONLINE|DWD/);
    expect(bundle.answer.citations.every((citation) => citation.source_url.startsWith("https:"))).toBe(true);
    expect(bundle.discharge.length).toBeGreaterThan(0);
  });
});