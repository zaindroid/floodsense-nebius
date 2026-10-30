import { describe, expect, it } from "vitest";
import { adoptRunBody } from "../api/replay";
import { escalationLine, pipelineSummary } from "../components/AgentPipeline";
import { buildPipeline } from "./pipeline";

const quick = adoptRunBody(
  {
    served_from: "live",
    summary: "s",
    claims: [],
    lane: "quick",
    status: "answered",
    trace: [
      { seq: 1, node: "router", summary: "quick: one place", lane: "fast" },
      { seq: 2, node: "scope", summary: "in scope" },
      { seq: 3, node: "live_watch", summary: "1 row", lane: "sql" },
      { seq: 4, node: "quick_answer", summary: "1 claim", model_id: "nvidia/nemotron-3.5-lightning-30b-a3b", lane: "fast" },
      { seq: 5, node: "judge", summary: "PASS", lane: "deep" },
    ],
  },
  "q1",
)!;

describe("compact stepper on #79 lanes", () => {
  it("draws the quick lane as Router, Scope, Live data, Quick answer, Judge, with no human review", () => {
    const model = buildPipeline(quick);
    expect(model.nodes.map((n) => n.label)).toEqual(["Router", "Scope", "Live data", "Quick answer", "Judge"]);
    expect(pipelineSummary(quick)).toMatch(/^5 agents · /);
  });

  it("words the escalation line", () => {
    expect(escalationLine("escalated: the question needs the exposure join")).toBe(
      "Escalated to the full investigation: the question needs the exposure join",
    );
    expect(escalationLine(null)).toBeNull();
  });
});
