import { describe, expect, it } from "vitest";
import { buildRunRequest, mapRunResponse, modeForPage, modeLabel } from "./ask";

const base = { question: "Is any Valencia point at risk in the next 48 hours?" };

describe("Ask mode from the route", () => {
  it("a Now page asks in live mode", () => {
    expect(modeForPage("now")).toBe("live");
    expect(buildRunRequest({ ...base, mode: modeForPage("now") }).mode).toBe("live");
  });

  it("any other page leaves mode unset for the agents to classify", () => {
    for (const page of ["overview", "approvals", "portfolio", undefined, null]) {
      expect(modeForPage(page)).toBeUndefined();
      expect("mode" in buildRunRequest({ ...base, mode: modeForPage(page) })).toBe(false);
    }
  });

  it("the answer header names the effective mode", () => {
    const body = (mode: unknown) => ({
      run_id: "r1",
      served_from: "live",
      summary: "Live data.",
      claims: [],
      event_id: "EMSR773",
      mode,
    });
    const live = mapRunResponse(201, body({ mode: "live", reason: "x" }), null);
    const event = mapRunResponse(201, body({ mode: "event", reason: "x" }), null);
    const none = mapRunResponse(201, body(undefined), null);
    expect(live.ok && modeLabel(live.run)).toBe("Live data · next 48 h");
    expect(event.ok && modeLabel(event.run)).toBe("Event · EMSR773 replay");
    expect(none.ok && modeLabel(none.run)).toBeNull();
  });
});
