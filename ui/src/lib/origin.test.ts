import { describe, expect, it } from "vitest";
import { honestyChip, originPill, statusLabel } from "./origin";

describe("honestyChip", () => {
  it("says Preview while any row is a fixture or seed, even with a live answer", () => {
    expect(honestyChip(["fixture", "fixture", "fixture", "fixture"], "cached").label).toBe("Preview");
    expect(honestyChip(["live", "live", "seed", "live"], "live").label).toBe("Preview");
    expect(honestyChip(["live", "fixture", "live", "live"], "live").state).toBe("preview");
    expect(honestyChip([], "live").state).toBe("preview");
  });

  it("says Cached when every view is live but the answer is not", () => {
    expect(honestyChip(["live", "live", "live", "live"], "cached")).toEqual({ state: "cached", label: "Cached" });
    expect(honestyChip(["live", "live", "live", "live"], "unlabelled").state).toBe("cached");
  });

  it("says Live only when every view and the answer are live", () => {
    expect(honestyChip(["live", "live", "live", "live"], "live")).toEqual({ state: "live", label: "Live" });
  });
});

describe("originPill", () => {
  it("labels a seed desk as seed, without the live tone", () => {
    const pill = originPill(["seed", "seed", "seed", "seed"]);
    expect(pill).toEqual({ tone: "seed", label: "Seed" });
    expect(pill.tone).not.toBe("live");
  });

  it("labels a non-seed view response as live", () => {
    expect(originPill(["live", "live", "live", "live"])).toEqual({ tone: "live", label: "Live" });
  });

  it("labels fixtures as fixture", () => {
    const pill = originPill(["fixture", "fixture", "fixture", "fixture"]);
    expect(pill).toEqual({ tone: "fixture", label: "Fixture" });
    expect(pill.label.toLowerCase()).not.toContain("live");
  });

  it("names a seed and fixture mix without calling it live", () => {
    const pill = originPill(["seed", "fixture", "fixture", "seed"]);
    expect(pill.tone).toBe("mixed");
    expect(pill.label).toBe("Seed · Fixture");
    expect(pill.label).not.toMatch(/live/i);
  });
});

describe("statusLabel", () => {
  it("uses Fixture, Seed, and Live", () => {
    expect(statusLabel("fixture")).toBe("Fixture");
    expect(statusLabel("seed")).toBe("Seed");
    expect(statusLabel("live")).toBe("Live");
  });
});
