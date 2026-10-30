import { describe, expect, it } from "vitest";
import { formatElapsed, initialLiveState, liveReducer, modelLine, retryAfterSeconds, shortModel, tipFor, WAIT_TIPS, type LiveEvent } from "./liveRun";
import { classifyStart } from "../api/liveRun";
import { turnBadge } from "./turnBadge";
import type { RecordedRun } from "../api/replay";

const run = (events: LiveEvent[]) => events.reduce(liveReducer, initialLiveState("r1"));
const node = (s: ReturnType<typeof run>, id: string) => s.nodes.find((n) => n.id === id)!;

describe("liveReducer", () => {
  it("lights a node on started and finishes it on trace", () => {
    let s = run([{ type: "started", data: { run_id: "r1", node: "scope", phase: "started" } }]);
    expect(node(s, "scope").state).toBe("running");
    expect(node(s, "watchers").state).toBe("idle");
    s = liveReducer(s, {
      type: "trace",
      data: { seq: 1, node: "scope", lane: "none", model_id: "deterministic", duration_ms: 120, summary: "scoped to EMSR773", phase: "finished" },
    });
    expect(node(s, "scope")).toMatchObject({ state: "done", durationMs: 120, summary: "scoped to EMSR773", runs: 1 });
    expect(s.announce).toBe("Scope finished.");
  });

  it("drops duplicate seqs and unknown nodes", () => {
    const t = { type: "trace", data: { seq: 3, node: "watchers", duration_ms: 50, summary: "x" } } as const;
    const s = run([t, t, { type: "trace", data: { seq: 4, node: "world_model", summary: "board after skeptic: H1 supported" } }]);
    expect(node(s, "watchers").runs).toBe(1);
    expect(s.seen).toEqual([3]);
  });

  it("makes the Skeptic revise loop and Judge repair round visible", () => {
    const s = run([
      { type: "trace", data: { seq: 1, node: "skeptic", summary: "1 supported, 1 not supported after 3 checks" } },
      { type: "trace", data: { seq: 2, node: "skeptic", summary: "revise edge -> investigator" } },
      { type: "trace", data: { seq: 3, node: "playbook", summary: "repair round 1: 2 flagged claim(s) rewritten to their evidence" } },
    ]);
    expect(s.reviseRounds).toBe(1);
    expect(s.repairRounds).toBe(1);
    expect(s.loops[0]).toMatch(/^Skeptic sent back 1 unsupported hypothesis/);
    expect(s.loops[1]).toBe("Judge repair round 1");
  });

  it("maps hitl to Human review and ends on status", () => {
    const s = run([{ type: "status", data: { run_id: "r1", status: "awaiting_approval", served_from: "live", cached_at: null } }]);
    expect(s.status).toBe("awaiting_approval");
    expect(node(s, "approval")).toMatchObject({ label: "Human review", state: "running" });
    expect(run([{ type: "status", data: { status: "not_found" } }]).status).toBe("not_found");
  });
});

describe("helpers", () => {
  it("labels models", () => {
    expect(shortModel("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("nemotron-3.5-lightning");
    expect(modelLine("nvidia/nemotron-3.5-lightning-30b-a3b", "fast")).toBe("nemotron-3.5-lightning · Nightshift");
    expect(modelLine("deterministic", "none")).toBe("deterministic");
    expect(modelLine(null, "sql")).toBe("SQL · Zetaris");
  });
  it("parses Retry-After and formats time", () => {
    expect(retryAfterSeconds("30")).toBe(30);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(formatElapsed(367)).toBe("6:07");
    expect(tipFor(0)).toBe(WAIT_TIPS[0]);
    expect(tipFor(13)).toBe(WAIT_TIPS[1]);
  });
});

describe("classifyStart", () => {
  const body = { run_id: "r9", served_from: "cache", summary: "S", claims: [] };
  it("202 starts a live run", () => {
    expect(classifyStart(202, { run_id: "r1", thread_id: "t1", status: "running" }, null)).toEqual({ kind: "started", runId: "r1", threadId: "t1" });
  });
  it("200 cache hit is a full run, labelled not live", () => {
    const r = classifyStart(200, body, null);
    expect(r.kind).toBe("run");
    expect(turnBadge((r as { run: RecordedRun }).run)).toBe("Recorded/cached · not live");
  });
  it("intent reply without run_id is a plain message", () => {
    expect(classifyStart(200, { kind: "reply", answer: "Hello", suggestions: ["Q1", 3] }, null)).toEqual({
      kind: "reply",
      answer: "Hello",
      suggestions: ["Q1"],
    });
    expect(classifyStart(200, { kind: "reply", answer: "x", run_id: "r" }, null).kind).not.toBe("reply");
  });
  it("429 carries Retry-After", () => {
    expect(classifyStart(429, null, "12")).toMatchObject({ kind: "rate_limited", retryAfterS: 12 });
  });
  it("5xx is an error", () => {
    expect(classifyStart(503, { detail: "down" }, null).kind).toBe("error");
  });
});
