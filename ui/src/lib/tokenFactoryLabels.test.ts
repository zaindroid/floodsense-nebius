import { describe, expect, it } from "vitest";
import { adoptRunBody, type RecordedRun } from "../api/replay";
import { providerOf } from "./lanes";
import { initialLiveState, liveReducer } from "./liveRun";
import { modelChip, runModelLine, traceProvider } from "./modelChip";
import { buildTechTrace, modelDisplay } from "./techTrace";

// The ids Token Factory serves today (GET /v1/models, 30 Oct 2026). A Nemotron id answers on
// Nightshift too, so only the trace's provider can say which backend served a run.
const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
const SUPER = "nvidia/Nemotron-3.5-Super-VL";

const step = (seq: number, node: string, lane: string, model_id: string | null, provider: string | null) => ({
  seq,
  node,
  lane,
  model_id,
  latency_ms: 900,
  summary: "done",
  evidence_ids: [],
  provider,
});

function run(trace: ReturnType<typeof step>[]): RecordedRun {
  const r = adoptRunBody(
    { run_id: "r1", served_from: "live", status: "answered", summary: "s", claims: [], trace, model_ids: [SUPER], memory_used: [] },
    "r1",
  );
  if (!r) throw new Error("fixture not adopted");
  return r;
}

describe("a run served by Nebius Token Factory", () => {
  it("names the backend from the trace, not from the id", () => {
    expect(providerOf(SUPER, "nebius")).toBe("Nebius Token Factory");
    // Without a stated provider the id rule still says Nightshift: runs recorded before the stamp.
    expect(providerOf(SUPER)).toBe("Nightshift");
  });

  it("labels each lane's chip and the run line with Token Factory", () => {
    expect(modelChip(NANO, "fast", "nebius")).toBe("Nemotron 3 Nano 30B · Nebius Token Factory fast lane");
    expect(modelChip(SUPER, "deep", "nebius")).toBe("Nemotron 3.5 Super VL · Nebius Token Factory deep lane");
    expect(runModelLine([SUPER], "nebius")).toBe("Nemotron 3.5 Super VL via Nebius Token Factory");
  });

  it("reads the provider from the last trace step that states one", () => {
    expect(traceProvider([step(1, "watchers", "sql", null, null), step(2, "judge", "deep", SUPER, "nebius")])).toBe("nebius");
    expect(traceProvider([step(1, "judge", "deep", SUPER, null)])).toBeNull();
    expect(traceProvider(undefined)).toBeNull();
  });

  it("does not call Token Factory calls the test provider in How this answer was made", () => {
    const tile = buildTechTrace(run([step(1, "investigator", "fast", NANO, "nebius"), step(2, "judge", "deep", SUPER, "nebius")])).tiles.find(
      (t) => t.id === "nightshift",
    )!;
    expect(tile.used).toBe(true);
    expect(tile.name).toBe("Nebius Token Factory");
    expect(tile.headline).toContain("Nano 30B");
    expect(tile.details.some((d) => /test provider/i.test(`${d.label} ${d.value}`))).toBe(false);
  });

  it("keeps the live chip's provider from the streamed trace event", () => {
    const s = liveReducer(initialLiveState("r1"), {
      type: "trace",
      data: { seq: 5, node: "investigator", lane: "fast", model_id: NANO, provider: "nebius", duration_ms: 900, summary: "3 hypotheses" },
    });
    expect(s.nodes.find((n) => n.id === "investigator")?.provider).toBe("nebius");
  });

  it("gives the Token Factory ids readable names", () => {
    expect(modelDisplay(NANO)).toBe("Nemotron 3 Nano 30B");
    expect(modelDisplay(SUPER)).toBe("Nemotron 3.5 Super VL");
    expect(modelDisplay("nvidia/Nemotron-3_5-Lightning")).toBe("Nemotron 3.5 Lightning");
  });
});
