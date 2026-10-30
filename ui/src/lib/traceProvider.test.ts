import { describe, expect, it } from "vitest";
import { NEBIUS_NAME, providerLabel } from "./lanes";

// The agents now stamp `provider` on every model step of the trace, so a recorded run
// names its backend instead of staying neutral. This is the contract that relies on.
describe("a recorded step that states its provider", () => {
  it("names Nebius Token Factory for a step served by nebius", () => {
    expect(providerLabel("nvidia/Nemotron-3.5-Super-VL", "nebius")).toBe(NEBIUS_NAME);
  });

  it("stays neutral without a stated provider, as before", () => {
    expect(providerLabel("nvidia/Nemotron-3.5-Super-VL")).toBeNull();
  });
});
