import { describe, expect, it } from "vitest";
import type { RecordedRun, ReplayStep } from "../api/replay";
import { initialLiveState, liveReducer, statusAnnounce, type LiveRunState } from "./liveRun";
import { buildPipeline, escalationOf, statusText } from "./pipeline";

const step = (node: string, summary: string, seq: number): ReplayStep =>
  ({ node, summary, seq, lane: null, modelId: null, latencyMs: 5 }) as unknown as ReplayStep;

function run(lane: "quick" | "full", status: string, trace: ReplayStep[], routerReason = ""): RecordedRun {
  return {
    runId: "r1",
    label: "",
    summary: "s",
    claims: [],
    judgeOverall: 1,
    judgePasses: true,
    flaggedClaimIds: [],
    trace,
    servedFrom: "live",
    status,
    threadId: null,
    modelIds: [],
    mode: "live",
    eventId: null,
    lane,
    routerReason,
  };
}

const QUICK_TRACE = [
  step("router", "chose quick: live level question about KÖLN", 1),
  step("scope", "in scope", 2),
  step("live_watch", "KÖLN: floodsense.gauge_levels 1 row", 3),
  step("quick_answer", "1 template claims, one per place; lead kept", 4),
  step("judge", "PASS overall=1.00", 5),
];

describe("buildPipeline by lane", () => {
  it("draws the quick lane without human review", () => {
    const model = buildPipeline(run("quick", "answered", QUICK_TRACE));
    expect(model.nodes.map((n) => n.label)).toEqual(["Router", "Scope", "Live data", "Quick answer", "Judge"]);
    expect(model.nodes.some((n) => n.id === "approval")).toBe(false);
    expect(statusText("answered")).toBe("Answered (no human review needed: no outbound action)");
  });

  it("shows an escalation on the router node", () => {
    const trace = [
      ...QUICK_TRACE.slice(0, 4),
      step("judge", "FLAG overall=0.40", 5),
      step("router", "escalated: judge flagged Q1; running the full lane", 6),
      step("watchers", "3 anomalies", 7),
    ];
    const r = run("full", "awaiting_approval", trace, "chose quick: x; escalated: judge flagged Q1");
    const model = buildPipeline(r);
    const ids = model.nodes.map((n) => n.id);
    expect(ids.slice(0, 4)).toEqual(["router", "scope", "live_watch", "quick_answer"]);
    expect(ids).toContain("approval");
    const router = model.nodes.find((n) => n.id === "router")!;
    expect(router.status).toBe("flag");
    expect(router.summary).toMatch(/^escalated: judge flagged Q1/);
    expect(escalationOf(r)).toMatch(/^escalated:/);
  });
});

function feed(events: [string, string][]): LiveRunState {
  return events.reduce(
    (s, [node, summary], i) => liveReducer(s, { type: "trace", data: { node, summary, seq: i + 1 } }),
    initialLiveState("r1"),
  );
}

describe("live pipeline by lane", () => {
  it("narrows to the quick steps once the router chooses quick", () => {
    let s = feed([["router", "chose quick: live level question about KÖLN"]]);
    expect(s.lane).toBe("quick");
    expect(s.nodes.map((n) => n.label)).toEqual(["Router", "Scope", "Live data", "Quick answer", "Judge"]);
    s = liveReducer(s, { type: "status", data: { status: "answered" } });
    expect(s.announce).toBe("Answered (no human review needed: no outbound action).");
    expect(statusAnnounce("answered")).toContain("no human review");
  });

  it("shows the escalation and the full lane after it", () => {
    const s = feed([
      ["router", "chose quick: live level question about KÖLN"],
      ["live_watch", "KÖLN: no live row"],
      ["router", "escalated: no live rows for the asked place; running the full lane"],
    ]);
    expect(s.lane).toBe("full");
    expect(s.escalated).toMatch(/^escalated:/);
    expect(s.loops.at(-1)).toMatch(/^Escalated to the full investigation/);
    const ids = s.nodes.map((n) => n.id);
    expect(ids).toContain("live_watch");
    expect(ids).toContain("watchers");
    expect(ids.at(-1)).toBe("approval");
  });

  it("a full run keeps human review and hides the quick steps", () => {
    const s = feed([["router", "chose full: asks 'why', which needs the full investigation"]]);
    const ids = s.nodes.map((n) => n.id);
    expect(ids).not.toContain("live_watch");
    expect(ids.at(-1)).toBe("approval");
  });
});
