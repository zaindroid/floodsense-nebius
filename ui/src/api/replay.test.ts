import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptReplay, fetchRecordedRun } from "./replay";

const body = {
  run_id: "f16733274f1c",
  served_from: "replay",
  label: { live: false, kind: "replay", text: "Replay of a recorded run · not live" },
  summary: "Runoff produced an extreme discharge [C2].",
  claims: [
    {
      claim_id: "C2",
      text: "Discharge reached 471 m3/s.",
      citations: [
        { citation_id: "C2-a1", layer: "a", title: "floodsense.hazard_timeline", query_id: "q1" },
        {
          citation_id: "C2-c1",
          layer: "c",
          title: "Flood report",
          publisher: "JRC",
          licence: "CC BY 4.0",
          attribution: "(c) European Union, JRC",
          quote: "The Poyo overflowed.",
          locator: { page: 12 },
        },
      ],
    },
  ],
  lane: "full",
  router_reason: "chose full: explicit event_id, replay_ts or doc_query",
  judge_summary: { overall: 0.9, passes: false, flagged_claim_ids: ["C2", 7] },
  trace: [{ seq: 1, node: "scope", summary: "in scope" }],
};

afterEach(() => vi.unstubAllGlobals());

describe("adoptReplay", () => {
  it("adopts a recorded run with layer (c) passages", () => {
    const run = adoptReplay(body, "f16733274f1c");
    expect(run?.runId).toBe("f16733274f1c");
    expect(run?.claims[0].citations[1]).toMatchObject({ layer: "c", quote: "The Poyo overflowed.", page: 12 });
    expect(run?.judgeOverall).toBe(0.9);
    expect(run?.trace).toHaveLength(1);
    expect(run?.claims[0].citations[1].attribution).toBe("(c) European Union, JRC");
    expect(run?.flaggedClaimIds).toEqual(["C2"]);
    expect(run?.lane).toBe("full");
    expect(run?.routerReason).toContain("chose full");
    expect(adoptReplay({ ...body, lane: "sideways" }, "x")?.lane).toBeNull();
  });

  it("refuses a body not served as a replay", () => {
    expect(adoptReplay({ ...body, served_from: "live" }, "x")).toBeNull();
    expect(adoptReplay(null, "x")).toBeNull();
    expect(adoptReplay({ ...body, summary: "" }, "x")).toBeNull();
  });
});

describe("fetchRecordedRun", () => {
  it("returns the run on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    expect((await fetchRecordedRun("f16733274f1c", "http://api"))?.summary).toContain("Runoff");
  });

  it("falls back to null on an HTTP error or a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    expect(await fetchRecordedRun("missing", "http://api")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await fetchRecordedRun("x", "http://api")).toBeNull();
  });
});
