import { describe, expect, it } from "vitest";
import { loadFixtures } from "../fixtures/load";
import { laneLabel } from "./lanes";

describe("laneLabel", () => {
  it("shows routing names and deterministic as stored", () => {
    expect(laneLabel("meterless/fast")).toBe("meterless/fast");
    expect(laneLabel("meterless/deep")).toBe("meterless/deep");
    expect(laneLabel("deterministic")).toBe("deterministic");
  });

  it("labels a concrete Nightshift id as the model that answered", () => {
    const superVl = laneLabel("nvidia/nemotron-3.5-super-vl-120b-a12b");
    const lightning = laneLabel("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(superVl).toBe("answered by Nemotron 3.5 Super VL 120B A12B");
    expect(lightning).toBe("answered by Nemotron 3.5 Lightning 30B A3B");
    expect(superVl).not.toMatch(/meterless\/(fast|deep)/);
    expect(lightning).not.toBe("meterless/fast");
  });

  it("does not relabel the discontinued Super id", () => {
    expect(laneLabel("nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });
});

describe("judge fixture", () => {
  it("stores meterless/deep on every judge claim", () => {
    const ids = loadFixtures().answer.judge?.claims.map((claim) => claim.model_id);
    expect(ids?.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(["meterless/deep"]));
  });
});
