import { describe, expect, it } from "vitest";
import type { RecordedRun, ReplayStep } from "../api/replay";
import { initialLiveState, liveNodeId, liveReducer, type LiveRunState } from "./liveRun";
import { buildPipeline } from "./pipeline";

const step = (node: string, summary: string, seq: number): ReplayStep =>
  ({ node, summary, seq, lane: null, modelId: null, latencyMs: 5 }) as unknown as ReplayStep;

const FORECAST_TRACE = [
  step("router", "chose forecast: forecast question ('next 48 hours') about KÖLN", 1),
  step("scope", "in scope", 2),
  step("forecast_data", "PEG07 weather: floodsense.weather_forecast 1 row", 3),
  step("history", "EMSR517 seed AHR01: 1 row", 4),
  step("forecast_answer", "4 deterministic claims; status Normal; outlook kept", 5),
  step("judge", "PASS overall=1.00", 6),
];

function run(lane: "forecast" | "full", status: string, trace: ReplayStep[]): RecordedRun {
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
    routerReason: "",
  };
}

const LABELS = ["Router", "Scope", "Forecast data", "History", "Forecast answer", "Judge"];

describe("forecast lane stepper", () => {
  it("draws Router, Scope, Forecast data, History, Forecast answer, Judge", () => {
    const model = buildPipeline(run("forecast", "answered", FORECAST_TRACE));
    expect(model.nodes.map((n) => n.label)).toEqual(LABELS);
    expect(model.nodes.every((n) => n.status === "done")).toBe(true);
  });

  it("narrows the live stepper once the router chooses forecast", () => {
    const s: LiveRunState = FORECAST_TRACE.reduce(
      (st, e, i) => liveReducer(st, { type: "trace", data: { node: e.node, summary: e.summary, seq: i + 1 } }),
      initialLiveState("r1"),
    );
    expect(s.lane).toBe("forecast");
    expect(s.nodes.map((n) => n.label)).toEqual(LABELS);
    expect(liveNodeId("forecast_judge")).toBe("judge");
  });

  it("an escalated forecast run keeps its forecast steps before the full lane", () => {
    const trace = [
      ...FORECAST_TRACE.slice(0, 5),
      step("judge", "FLAG overall=0.40", 6),
      step("router", "escalated: judge flagged F1; running the full lane", 7),
      step("watchers", "3 anomalies", 8),
    ];
    const ids = buildPipeline(run("full", "awaiting_approval", trace)).nodes.map((n) => n.id);
    expect(ids.slice(0, 5)).toEqual(["router", "scope", "forecast_data", "history", "forecast_answer"]);
    expect(ids).not.toContain("live_watch");
    expect(ids).toContain("approval");
  });
});
