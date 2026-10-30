import { describe, expect, it } from "vitest";
import { plainLanguage } from "./plain";

describe("plainLanguage", () => {
  it("replaces table and column names but keeps the numbers and the seed disclosure", () => {
    const out = plainLanguage(
      "VAL07 discharge in floodsense_seed.discharge_daily is 0.62 m³/s on 29 Oct 2024. The source column is seed:open-meteo-flood-glofas. warning_level is null.",
    );
    expect(out).not.toMatch(/floodsense_seed|warning_level|source column/);
    expect(out).toContain("0.62 m³/s");
    expect(out).toContain("(seed data: Open-Meteo GloFAS model)");
    expect(out).toContain("daily river-flow record (seed data)");
    expect(out).toContain("no official warning level is attached");
  });
  it("keeps distinct tables distinct", () => {
    const out = plainLanguage("floodsense_seed.hazard_now and floodsense_seed.gauge_levels");
    expect(out).toContain("hazard now record");
    expect(out).toContain("gauge levels record");
  });
  it("leaves plain text alone", () => {
    expect(plainLanguage("Rain peaked at 16.4 mm.")).toBe("Rain peaked at 16.4 mm.");
  });
});

import { roundLongNumbers } from "./plain";
describe("long numbers", () => {
  it("rounds float noise and leaves dates, ids and short decimals alone", () => {
    expect(roundLongNumbers("peak 140.89999999999998 m3/s, 72.30000000000001 mm")).toBe("peak 140.9 m3/s, 72.3 mm");
    expect(roundLongNumbers("on 2021-07-13 00:00:00.0 value 5.6 mm id 1a2b3c4d.5678")).toBe("on 2021-07-13 00:00:00.0 value 5.6 mm id 1a2b3c4d.5678");
  });
});
