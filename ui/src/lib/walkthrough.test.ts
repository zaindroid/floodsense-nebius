import { describe, expect, it } from "vitest";
import { adoptRunBody, type RecordedRun } from "../api/replay";
import sample from "../fixtures/run_f16733274f1c.json";
import { boardTally, boardText, buildWalkthrough, claimsBySeq, clampBeat, parseVerdict } from "./walkthrough";
import { nodeRuns, nodeState } from "../components/RunWalkthrough";

const run = adoptRunBody(sample as unknown as Record<string, unknown>, "f16733274f1c")!;

describe("parseVerdict", () => {
  it("reads the Judge's own summary line", () => {
    const v = parseVerdict("FLAG overall=0.87 hallucination=17% coverage=100% numbers=100% flagged=['C-doc']")!;
    expect(v.passed).toBe(false);
    expect(v.overall).toBe(0.87);
    expect(v.hallucination).toBe(0.17);
    expect(v.flagged).toEqual(["C-doc"]);
  });

  it("reads a pass with nothing flagged", () => {
    const v = parseVerdict("PASS overall=1.00 hallucination=0% flagged=[]")!;
    expect(v.passed).toBe(true);
    expect(v.flagged).toEqual([]);
  });

  it("is null for a summary that is not a verdict", () => {
    expect(parseVerdict("4 actions, 2 outbound (await approval)")).toBeNull();
  });
});

describe("claimsBySeq", () => {
  it("files each claim under the step that ran its query", () => {
    const { bySeq, unlinked } = claimsBySeq(run);
    expect(unlinked).toEqual([]);
    // The Investigator's queries ground C2, C3, C4 and the document claim.
    expect(bySeq.get(5)!.map((c) => c.id).sort()).toEqual(["C-doc", "C2", "C3", "C4"]);
    // Exposure's own queries ground the two portfolio claims.
    expect(bySeq.get(14)!.map((c) => c.id).sort()).toEqual(["C5", "C6"]);
  });

  it("names a claim no step accounts for instead of dropping it", () => {
    const orphan: RecordedRun = {
      ...run,
      claims: [{ id: "CX", text: "unsourced", citations: [{ ...run.claims[0].citations[0], queryId: "not-in-trace" }] }],
    };
    const { bySeq, unlinked } = claimsBySeq(orphan);
    expect(bySeq.size).toBe(0);
    expect(unlinked.map((c) => c.id)).toEqual(["CX"]);
  });
});

describe("buildWalkthrough", () => {
  it("keeps one beat per trace step and adds the human gate", () => {
    const { beats } = buildWalkthrough(run);
    expect(beats).toHaveLength(run.trace.length + 1);
    expect(beats.map((b) => b.seq)).toEqual([...run.trace.map((s) => s.seq), 19]);
    const gate = beats[beats.length - 1];
    expect(gate.kind).toBe("gate");
    expect(gate.spine).toBe("approval");
    expect(gate.summary).toMatch(/Nothing outbound is sent before it/);
  });

  it("marks the revise edge as a loop back to the Investigator", () => {
    const { beats } = buildWalkthrough(run);
    const loop = beats.find((b) => b.kind === "loop")!;
    expect(loop.seq).toBe(9);
    expect(loop.heading).toBe("Revise loop");
    expect(loop.loopTo).toBe("investigator");
  });

  it("holds a board beat on the node it reports, not on world_model", () => {
    const { beats } = buildWalkthrough(run);
    const board = beats.find((b) => b.seq === 6)!;
    expect(board.kind).toBe("board");
    expect(board.spine).toBe("investigator");
    expect(board.board!.states.map((s) => s.state)).toEqual(["proposed", "proposed", "proposed"]);
  });

  it("carries the board forward so a later beat still shows it", () => {
    const { beats } = buildWalkthrough(run);
    // Exposure records no board of its own; the Skeptic's last one still stands.
    const exposure = beats.find((b) => b.node === "exposure")!;
    expect(boardText(exposure.board)).toBe("H1 not supported, H2 supported, H3 supported");
  });

  it("totals the queries and claims as the walk proceeds, never retroactively", () => {
    const { beats } = buildWalkthrough(run);
    const at = (seq: number) => beats.find((b) => b.seq === seq)!.ledger;
    expect(at(1).queries).toBe(0);
    expect(at(2).queries).toBe(3); // Watchers' three view queries
    expect(at(5).queries).toBe(9); // plus the Investigator's six
    expect(at(5).claims).toBe(4);
    expect(at(14).claims).toBe(6); // Exposure adds the two portfolio claims
    expect(at(14).queries).toBe(17);
    const last = beats[beats.length - 1].ledger;
    expect(last.revises).toBe(1);
    expect(last.repairs).toBe(1);
  });

  it("tracks the hypothesis the Skeptic dropped", () => {
    const { beats } = buildWalkthrough(run);
    expect(beats.find((b) => b.seq === 6)!.ledger.dropped).toBe(0);
    const after = beats.find((b) => b.seq === 8)!;
    expect(after.ledger.dropped).toBe(1);
    expect(after.ledger.supported).toBe(2);
  });

  it("reads both Judge verdicts, including the one after the repair", () => {
    const { beats } = buildWalkthrough(run);
    const verdicts = beats.filter((b) => b.verdict).map((b) => b.verdict!.overall);
    expect(verdicts).toEqual([0.87, 0.9]);
    expect(beats[beats.length - 1].ledger.flagged).toBe(1);
  });

  it("only counts a query id against a step that ran SQL", () => {
    const { beats } = buildWalkthrough(run);
    for (const beat of beats) if (beat.lane !== "sql") expect(beat.queryIds).toEqual([]);
  });
});

describe("boardTally and clampBeat", () => {
  it("counts the board's states", () => {
    expect(boardTally(null)).toEqual({ supported: 0, dropped: 0 });
    expect(boardTally({ after: "skeptic", states: [{ id: "H1", state: "not_supported" }, { id: "H2", state: "supported" }] })).toEqual({
      supported: 1,
      dropped: 1,
    });
  });

  it("keeps a seek inside the walk", () => {
    expect(clampBeat(-3, 19)).toBe(0);
    expect(clampBeat(99, 19)).toBe(18);
    expect(clampBeat(5, 0)).toBe(0);
  });
});

describe("the spine at a beat", () => {
  const { beats } = buildWalkthrough(run);

  it("marks the node the playhead sits on, what it has passed and what is ahead", () => {
    const at = beats.findIndex((b) => b.seq === 7); // the Skeptic's first pass
    expect(nodeState("skeptic", beats, at)).toBe("current");
    expect(nodeState("watchers", beats, at)).toBe("visited");
    expect(nodeState("judge", beats, at)).toBe("ahead");
  });

  it("counts a node's second pass after the revise loop", () => {
    const first = beats.findIndex((b) => b.seq === 5);
    const second = beats.findIndex((b) => b.seq === 10);
    expect(nodeRuns("investigator", beats, first)).toBe(1);
    expect(nodeRuns("investigator", beats, second)).toBe(2);
  });

  it("does not count a board reading as a run of the node it reports", () => {
    const board = beats.findIndex((b) => b.seq === 6); // board after investigator
    expect(nodeRuns("investigator", beats, board)).toBe(1);
  });
});

describe("a run that recorded its own human decision", () => {
  // The shape of run c2aeb76b51d1 on the deployment: approved, so the trace
  // carries hitl and learn steps, which are not nodes of the graph.
  const approved: RecordedRun = {
    ...run,
    status: "approved",
    trace: [
      { seq: 1, node: "scope", summary: "question names valencia", lane: "none", latencyMs: 0 },
      { seq: 2, node: "judge", summary: "PASS overall=1.00 hallucination=0% coverage=100% numbers=100% flagged=-" },
      { seq: 3, node: "hitl", summary: "APPROVED by zain; 1 outbound action(s) released: A4" },
      { seq: 4, node: "learn", summary: "approved run: 1 claim(s) stored in H-MEM, 0 already remembered" },
    ],
  };

  it("names hitl and learn instead of printing the raw trace node", () => {
    const { beats } = buildWalkthrough(approved);
    expect(beats.map((b) => b.heading)).toEqual(["Scope", "Judge", "Human approval", "Memory write"]);
  });

  it("treats the recorded decision as the gate and adds no second one", () => {
    const { beats } = buildWalkthrough(approved);
    expect(beats).toHaveLength(approved.trace.length);
    const gates = beats.filter((b) => b.kind === "gate");
    expect(gates).toHaveLength(1);
    expect(gates[0].summary).toMatch(/APPROVED by zain/);
    expect(gates[0].spine).toBe("approval");
  });

  it("keeps the playhead on the gate for what follows it, without counting it as a second approval", () => {
    const { beats } = buildWalkthrough(approved);
    const last = beats[beats.length - 1];
    expect(last.spine).toBe("approval");
    expect(last.isRun).toBe(false);
    expect(nodeRuns("approval", beats, beats.length - 1)).toBe(1);
  });

  it("reads a pass that writes flagged=- rather than an empty list", () => {
    const { beats } = buildWalkthrough(approved);
    const judge = beats.find((b) => b.verdict)!;
    expect(judge.verdict!.passed).toBe(true);
    expect(judge.verdict!.overall).toBe(1);
    expect(judge.verdict!.flagged).toEqual([]);
    expect(beats[beats.length - 1].ledger.flagged).toBe(0);
  });
});
