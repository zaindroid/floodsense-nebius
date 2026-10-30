import { describe, expect, it } from "vitest";
import { sourceExplanation } from "./series";

const stamp = "seed:open-meteo-flood-glofas";

describe("sourceExplanation", () => {
  it("calls the rows seed only when the view origin is seed", () => {
    expect(sourceExplanation(stamp, "seed")).toMatch(/These rows are seed/);
  });

  it("names the stamp without calling a fixture origin Seed", () => {
    const text = sourceExplanation(stamp, "fixture");
    expect(text).toMatch(/seed stamp/);
    expect(text).not.toMatch(/These rows are seed/);
  });
});
