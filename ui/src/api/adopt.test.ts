import { describe, expect, it } from "vitest";
import { adoptView, markBatchSeed } from "./adopt";

const fixture = [{ point_id: "VAL01" }];
const fixtureDetail = "Fixture copy.";

describe("adoptView", () => {
  it("keeps the fixture when health failed", () => {
    const adopted = adoptView({
      healthOk: false,
      parsed: [{ point_id: "LIVE" }],
      fixtureRows: fixture,
      fixtureDetail,
      missDetail: "ignored",
    });
    expect(adopted.origin).toBe("fixture");
    expect(adopted.rows).toEqual(fixture);
    expect(adopted.detail).toBe(fixtureDetail);
  });

  it("keeps the fixture when the body is not a valid array", () => {
    const adopted = adoptView({
      healthOk: true,
      parsed: null,
      fixtureRows: fixture,
      fixtureDetail,
      missDetail: "GET /views/discharge_daily did not match the view columns",
    });
    expect(adopted.origin).toBe("fixture");
    expect(adopted.rows).toEqual(fixture);
    expect(adopted.detail).toContain("did not match");
  });

  it("keeps an empty array empty and does not call it live", () => {
    const adopted = adoptView({
      healthOk: true,
      parsed: [],
      fixtureRows: fixture,
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    expect(adopted.origin).toBe("fixture");
    expect(adopted.rows).toEqual([]);
    expect(adopted.detail).toContain("0 rows");
    expect(adopted.detail).not.toMatch(/\blive\b/);
  });

  it("does not label unstamped rows as live", () => {
    const rows = [{ point_id: "VAL01" }];
    const adopted = adoptView({
      healthOk: true,
      parsed: rows,
      fixtureRows: fixture,
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    expect(adopted.origin).toBe("fixture");
    expect(adopted.rows).toEqual(rows);
    expect(adopted.detail).toContain("unstamped");
    expect(adopted.detail).not.toMatch(/\blive\b/);
  });

  it("labels synthetic exposure as seed even when the source stamp is not seed", () => {
    const adopted = adoptView({
      healthOk: true,
      parsed: [{ policy_id: "SYN-1", source: "open-meteo-flood-glofas", synthetic: "yes" }],
      fixtureRows: [],
      fixtureDetail,
      missDetail: "GET /views/exposure_join",
    });
    expect(adopted.origin).toBe("seed");
    expect(adopted.detail).not.toMatch(/\blive\b/);
  });

  it("adopts stamped non-seed rows as live", () => {
    const rows = [{ point_id: "LIVE", source: "open-meteo-flood-glofas" }];
    const adopted = adoptView({
      healthOk: true,
      parsed: rows,
      fixtureRows: fixture,
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    expect(adopted.origin).toBe("live");
    expect(adopted.rows).toEqual(rows);
    expect(adopted.detail).toContain("GET /views/discharge_daily");
  });

  it("does not label a mix of seed and non-seed rows as live", () => {
    const adopted = adoptView({
      healthOk: true,
      parsed: [{ source: "seed:open-meteo-flood-glofas" }, { source: "open-meteo-flood-glofas" }],
      fixtureRows: [{ source: "seed:fixture" }],
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    expect(adopted.origin).toBe("seed");
    expect(adopted.detail).not.toMatch(/\blive\b/);
  });

  it("labels seed-stamped view rows as seed, not live", () => {
    const adopted = adoptView({
      healthOk: true,
      parsed: [{ source: "seed:open-meteo-flood-glofas" }],
      fixtureRows: [{ source: "seed:fixture" }],
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    expect(adopted.origin).toBe("seed");
    expect(adopted.detail).not.toMatch(/\blive\b/);
  });

  it("does not treat a health success with no view body as live", () => {
    const adopted = adoptView({
      healthOk: true,
      parsed: null,
      fixtureRows: fixture,
      fixtureDetail,
      missDetail: "GET /views/discharge_daily returned 404",
    });
    expect(adopted.origin).toBe("fixture");
  });

  it("marks sibling view responses seed when discharge is seed", () => {
    const discharge = adoptView({
      healthOk: true,
      parsed: [{ source: "seed:open-meteo-flood-glofas" }],
      fixtureRows: [{ source: "seed:fixture" }],
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    const hazard = markBatchSeed(
      discharge,
      adoptView({
        healthOk: true,
        parsed: [{ point_id: "VAL01" }],
        fixtureRows: [],
        fixtureDetail,
        missDetail: "GET /views/hazard_timeline",
      }),
    );
    expect(hazard.origin).toBe("seed");
    expect(hazard.detail).toBe("GET /views/hazard_timeline · seed");
    expect(hazard.detail).not.toMatch(/\blive\b/);
  });

  it("does not promote an unstamped sibling to live when discharge is live", () => {
    const discharge = adoptView({
      healthOk: true,
      parsed: [{ source: "open-meteo-flood-glofas" }],
      fixtureRows: [{ source: "seed:fixture" }],
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    const hazard = markBatchSeed(
      discharge,
      adoptView({
        healthOk: true,
        parsed: [{ point_id: "VAL01" }],
        fixtureRows: [],
        fixtureDetail,
        missDetail: "GET /views/hazard_timeline",
      }),
    );
    expect(hazard.origin).toBe("fixture");
    expect(hazard.rows).toEqual([{ point_id: "VAL01" }]);
    expect(hazard.detail).toContain("unstamped");
    expect(hazard.detail).not.toMatch(/\blive\b/);
  });

  it("does not paint synthetic exposure live when discharge is live", () => {
    const discharge = adoptView({
      healthOk: true,
      parsed: [{ source: "open-meteo-flood-glofas" }],
      fixtureRows: [{ source: "seed:fixture" }],
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    const exposure = markBatchSeed(
      discharge,
      adoptView({
        healthOk: true,
        parsed: [{ policy_id: "SYN-1", synthetic: "yes" }],
        fixtureRows: [],
        fixtureDetail,
        missDetail: "GET /views/exposure_join",
      }),
    );
    expect(exposure.origin).toBe("seed");
    expect(exposure.rows).toEqual([{ policy_id: "SYN-1", synthetic: "yes" }]);
    expect(exposure.detail).not.toMatch(/\blive\b/);
  });

  it("does not relabel a missed sibling as live", () => {
    const discharge = adoptView<{ source: string }>({
      healthOk: true,
      parsed: [{ source: "open-meteo-flood-glofas" }],
      fixtureRows: [{ source: "seed:fixture" }],
      fixtureDetail,
      missDetail: "GET /views/discharge_daily",
    });
    const hazard = markBatchSeed(
      discharge,
      adoptView({
        healthOk: true,
        parsed: null,
        fixtureRows: fixture,
        fixtureDetail,
        missDetail: "GET /views/hazard_timeline returned 404",
      }),
    );
    expect(hazard.origin).toBe("fixture");
    expect(hazard.rows).toEqual(fixture);
    expect(hazard.detail).not.toMatch(/\blive\b/);
  });
});
