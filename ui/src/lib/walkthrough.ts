import type { RecordedRun, ReplayClaim, ReplayStep } from "../api/replay";
import { NODE_LABELS, parseBoard, PIPELINE_ORDER, statusText, type PipelineNodeId, type WorldBoard } from "./pipeline";

/**
 * The run as a sequence of beats, one per trace step, for stepping through.
 *
 * buildPipeline folds the 18 steps of a run into 9 node cards, which loses the
 * order the work happened in: the hypothesis the Skeptic knocked down, the
 * revise edge back to the Investigator, the claim the Judge flagged and the
 * repair round that rewrote it. A beat keeps each of those as its own moment.
 */

export type BeatKind = "work" | "board" | "loop" | "gate";

/** What the Judge said, parsed from its trace summary. */
export interface JudgeVerdict {
  passed: boolean;
  overall: number | null;
  hallucination: number | null;
  flagged: string[];
}

/** Running totals up to and including a beat. */
export interface Ledger {
  queries: number;
  claims: number;
  supported: number;
  dropped: number;
  flagged: number;
  revises: number;
  repairs: number;
}

export interface Beat {
  index: number;
  seq: number;
  /** Raw trace node, world_model included. */
  node: string;
  /** The graph node the playhead sits on; a board beat stays on the node it reports. */
  spine: PipelineNodeId;
  kind: BeatKind;
  heading: string;
  summary: string;
  latencyMs: number | null;
  lane: string | null;
  modelId: string | null;
  /** Zetaris query ids this step recorded, the handle for auditing it. */
  queryIds: string[];
  /** Claims whose evidence this step produced, so a claim appears with its query. */
  claims: ReplayClaim[];
  /** The hypothesis board as it stands at this beat, carried forward. */
  board: WorldBoard | null;
  verdict: JudgeVerdict | null;
  /** For a loop beat, the node the run returns to. */
  loopTo: PipelineNodeId | null;
  /** True when this beat is the graph node itself working, so it counts as a run of it.
   *  A board reading and a trailing step like learn sit on a node without being it. */
  isRun: boolean;
  ledger: Ledger;
}

export interface WalkthroughModel {
  beats: Beat[];
  /** Claims no trace step accounts for, named rather than hidden. */
  unlinkedClaims: ReplayClaim[];
}

const isBoard = (step: ReplayStep) => step.node === "world_model";
const LOOP = /^(revise|repair) edge\s*->\s*(\w+)/i;

/** Trace nodes that are not graph nodes, and what to call them. */
const OTHER_LABELS: Record<string, string> = {
  world_model: "World Model",
  hitl: "Human approval",
  learn: "Memory write",
};

/** Trace nodes that record the human decision: the run's own gate, not a step before it. */
const GATE_NODES = new Set(["hitl", "approval"]);

/** Pure: "FLAG overall=0.87 hallucination=17% ... flagged=['C-doc']" to a verdict. */
export function parseVerdict(summary: string): JudgeVerdict | null {
  if (!/^(FLAG|PASS)\b/i.test(summary.trim())) return null;
  const overall = /overall=([\d.]+)/i.exec(summary);
  const halluc = /hallucination=(\d+)%/i.exec(summary);
  const flagged = /flagged=\[([^\]]*)\]/i.exec(summary);
  return {
    passed: /^PASS/i.test(summary.trim()),
    overall: overall ? Number(overall[1]) : null,
    hallucination: halluc ? Number(halluc[1]) / 100 : null,
    flagged: flagged
      ? flagged[1]
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
      : [],
  };
}

/** Pure: how many hypotheses the board holds in each state. */
export function boardTally(board: WorldBoard | null): { supported: number; dropped: number } {
  if (!board) return { supported: 0, dropped: 0 };
  return {
    supported: board.states.filter((s) => s.state === "supported").length,
    dropped: board.states.filter((s) => s.state === "not_supported").length,
  };
}

/** Pure: the earliest trace seq that recorded each query id. */
function producedAt(trace: ReplayStep[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const step of trace) for (const id of step.evidenceIds ?? []) if (!at.has(id)) at.set(id, step.seq);
  return at;
}

/**
 * Pure: claim ids grouped by the trace seq that produced their evidence.
 *
 * A citation carries the query id that returned its rows, and a step records the
 * query ids it ran, so the two join exactly. That join is what makes the
 * walkthrough auditable: no claim appears before the query behind it.
 */
export function claimsBySeq(run: RecordedRun): { bySeq: Map<number, ReplayClaim[]>; unlinked: ReplayClaim[] } {
  const at = producedAt(run.trace);
  const bySeq = new Map<number, ReplayClaim[]>();
  const unlinked: ReplayClaim[] = [];
  for (const claim of run.claims) {
    const seqs = claim.citations.map((c) => (c.queryId ? at.get(c.queryId) : undefined)).filter((s): s is number => s !== undefined);
    if (seqs.length === 0) {
      unlinked.push(claim);
      continue;
    }
    const first = Math.min(...seqs);
    const list = bySeq.get(first);
    if (list) list.push(claim);
    else bySeq.set(first, [claim]);
  }
  return { bySeq, unlinked };
}

/** A node id the graph knows, else null. */
function asNode(name: string): PipelineNodeId | null {
  return (PIPELINE_ORDER as readonly string[]).includes(name) ? (name as PipelineNodeId) : null;
}

/** Pure: the beats of a recorded run, in trace order, ending at the human gate. */
export function buildWalkthrough(run: RecordedRun): WalkthroughModel {
  const { bySeq, unlinked } = claimsBySeq(run);
  const ledger: Ledger = { queries: 0, claims: 0, supported: 0, dropped: 0, flagged: 0, revises: 0, repairs: 0 };
  let board: WorldBoard | null = null;
  let spine: PipelineNodeId = "scope";
  const beats: Beat[] = [];

  for (const step of run.trace) {
    const loop = LOOP.exec(step.summary);
    const parsed = isBoard(step) ? parseBoard(step.summary) : null;
    if (parsed) board = parsed;

    // A board beat reports on the node it names, so the playhead stays there.
    const isGate = GATE_NODES.has(step.node);
    const named = parsed ? asNode(parsed.after) : asNode(step.node);
    if (isGate) spine = "approval";
    else if (named) spine = named;

    const queryIds = step.lane === "sql" ? (step.evidenceIds ?? []) : [];
    const claims = bySeq.get(step.seq) ?? [];
    const verdict = step.node === "judge" ? parseVerdict(step.summary) : null;

    ledger.queries += queryIds.length;
    ledger.claims += claims.length;
    if (loop && /^revise/i.test(loop[1])) ledger.revises += 1;
    if (/^repair round/i.test(step.summary)) ledger.repairs += 1;
    if (verdict) ledger.flagged = verdict.flagged.length;
    const tally = boardTally(board);
    ledger.supported = tally.supported;
    ledger.dropped = tally.dropped;

    const kind: BeatKind = loop ? "loop" : isGate ? "gate" : isBoard(step) ? "board" : "work";
    const loopTo = loop ? asNode(loop[2].toLowerCase()) : null;
    const own = asNode(step.node);
    const heading = loop
      ? `${/^revise/i.test(loop[1]) ? "Revise" : "Repair"} loop`
      : (OTHER_LABELS[step.node] ?? (own ? NODE_LABELS[own] : step.node));
    beats.push({
      index: beats.length,
      seq: step.seq,
      node: step.node,
      spine,
      kind,
      heading,
      summary: step.summary,
      latencyMs: step.latencyMs ?? null,
      lane: step.lane ?? null,
      modelId: step.modelId && step.modelId !== "deterministic" ? step.modelId : null,
      queryIds,
      claims,
      board,
      verdict,
      loopTo,
      isRun: !loop && (isGate || own !== null),
      ledger: { ...ledger },
    });
  }

  // A run that recorded its own decision already has its gate beat; the
  // synthetic one below is for a run that stops before anyone decided.
  // A quick answer is "answered": it has no outbound action, so no human review.
  if (beats.some((b) => b.kind === "gate")) return { beats, unlinkedClaims: unlinked };

  const waiting = run.status === "awaiting_approval";
  beats.push({
    index: beats.length,
    seq: (run.trace[run.trace.length - 1]?.seq ?? 0) + 1,
    node: "approval",
    spine: "approval",
    kind: "gate",
    heading: waiting ? NODE_LABELS.approval : "Run complete",
    summary: waiting
      ? "Waiting for a human decision. Nothing outbound is sent before it."
      : statusText(run.status) || "A human decides before anything is sent.",
    latencyMs: null,
    lane: null,
    modelId: null,
    queryIds: [],
    claims: [],
    board,
    verdict: null,
    loopTo: null,
    isRun: true,
    ledger: { ...ledger },
  });

  return { beats, unlinkedClaims: unlinked };
}

/** Pure: index clamped into the beats, so a seek can never leave the walk. */
export function clampBeat(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, index));
}

/** Pure: "H1 not supported, H2 supported" for a screen reader and the board line. */
export function boardText(board: WorldBoard | null): string {
  if (!board) return "no hypotheses yet";
  return board.states.map((s) => `${s.id} ${s.state.replace(/_/g, " ")}`).join(", ");
}
