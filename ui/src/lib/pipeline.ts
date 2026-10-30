import type { RecordedRun, ReplayStep } from "../api/replay";
import { laneLabel, providerOf } from "./lanes";

/** Canonical node order of the agent graph. world_model steps are folded into badges, not nodes. */
export const PIPELINE_ORDER = [
  "router",
  "scope",
  "live_watch",
  "quick_answer",
  "forecast_data",
  "history",
  "forecast_answer",
  "watchers",
  "memory",
  "investigator",
  "skeptic",
  "exposure",
  "playbook",
  "judge",
  "approval",
] as const;

export type PipelineNodeId = (typeof PIPELINE_ORDER)[number];

export const NODE_LABELS: Record<PipelineNodeId, string> = {
  router: "Router",
  scope: "Scope",
  live_watch: "Live data",
  quick_answer: "Quick answer",
  forecast_data: "Forecast data",
  history: "History",
  forecast_answer: "Forecast answer",
  watchers: "Watchers",
  memory: "Memory",
  investigator: "Investigator",
  skeptic: "Skeptic",
  exposure: "Exposure",
  playbook: "Playbook",
  judge: "Judge",
  approval: "Human approval",
};

export type NodeStatus = "done" | "flag" | "waiting" | "skipped";

export interface PipelineBadge {
  kind: "zetaris" | "nightshift" | "model" | "hmem" | "world" | "rag";
  text: string;
}

export interface PipelineNode {
  id: PipelineNodeId;
  label: string;
  status: NodeStatus;
  /** Sum of the node's trace latencies, null when none recorded. */
  latencyMs: number | null;
  lane: string | null;
  modelId: string | null;
  /** Provider the trace states for this node's model step, when it does. */
  provider: string | null;
  summary: string;
  /** How many times the node ran (a revise or repair loop runs it again). */
  runs: number;
  badges: PipelineBadge[];
}

export interface WorldBoard {
  /** Hypothesis id to state, e.g. H1 -> not_supported. */
  states: { id: string; state: string }[];
  after: string;
}

export interface PipelineModel {
  nodes: PipelineNode[];
  reviseRounds: number;
  repairRounds: number;
  /** Last world-model board in the trace, or null. */
  board: WorldBoard | null;
  totalLatencyMs: number;
}

/** The quick lane's steps (router.py): no Playbook, no human review. */
export const QUICK_ORDER: readonly PipelineNodeId[] = ["router", "scope", "live_watch", "quick_answer", "judge"];
/** The forecast lane's steps (nodes/forecast.py): no Playbook, no human review. */
export const FORECAST_ORDER: readonly PipelineNodeId[] = [
  "router",
  "scope",
  "forecast_data",
  "history",
  "forecast_answer",
  "judge",
];
/** Steps only the quick or forecast lane runs; a full run shows them only after an escalation. */
export const QUICK_ONLY: readonly PipelineNodeId[] = [
  "live_watch",
  "quick_answer",
  "forecast_data",
  "history",
  "forecast_answer",
];

/** The run status a person reads. A quick answer has no outbound action, so no human review. */
export function statusText(status: string | null | undefined): string {
  if (status === "answered") return "Answered (no human review needed: no outbound action)";
  if (status === "awaiting_approval") return "Waiting for human review";
  return status ? `Run status: ${status}` : "";
}

/** Pure: "escalated: ..." from the router trace, or null when the run did not escalate. */
export function escalationOf(run: Pick<RecordedRun, "trace" | "routerReason">): string | null {
  const step = [...run.trace].reverse().find((s) => s.node === "router" && /^escalated:/i.test(s.summary));
  if (step) return step.summary;
  const m = /escalated: .*/i.exec(run.routerReason ?? "");
  return m ? m[0] : null;
}

/** Pure: which pipeline nodes a run shows, by its lane. */
export function pipelineIds(run: Pick<RecordedRun, "trace" | "lane">): PipelineNodeId[] {
  const ran = new Set(run.trace.map((s) => s.node));
  if (run.lane === "quick") return [...QUICK_ORDER];
  if (run.lane === "forecast") return [...FORECAST_ORDER];
  return PIPELINE_ORDER.filter((id) => {
    if (QUICK_ONLY.includes(id)) return ran.has(id);
    if (id === "router") return ran.has("router");
    return true;
  });
}

const isEdge = (step: ReplayStep) => /^revise edge|^repair edge/i.test(step.summary);

/** True for a model id that is a real LLM, not "deterministic" or empty. */
function llmIds(modelId: string | null | undefined): string[] {
  return (modelId ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== "deterministic");
}

/** Badge for an LLM id, by the shared provider rule (`providerOf`): Nemotron ids are Nightshift. */
export function modelBadge(modelId: string, provider?: string | null): PipelineBadge {
  const label = laneLabel(modelId);
  const p = providerOf(modelId, provider);
  if (p === "Nightshift") return { kind: "nightshift", text: `Nightshift · ${label}` };
  if (p) return { kind: "model", text: `${p} · ${label}` };
  return { kind: "model", text: modelId };
}

/** Pure: N from a memory summary "recalled N past approved finding(s)", else null. */
export function recalledCount(summary: string): number | null {
  const m = /recalled\s+(\d+)/i.exec(summary);
  return m ? Number(m[1]) : null;
}

/** Pure: parse "board after skeptic: H1 not_supported, H2 supported". */
export function parseBoard(summary: string): WorldBoard | null {
  const m = /^board after (\w+):\s*(.+)$/i.exec(summary.trim());
  if (!m) return null;
  const states = m[2]
    .split(",")
    .map((part) => part.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^H\d+$/i.test(p[0]))
    .map(([id, state]) => ({ id, state }));
  return states.length ? { states, after: m[1] } : null;
}

/** Pure: the pipeline graph for an adopted run body (live, cache or replay). */
export function buildPipeline(run: RecordedRun): PipelineModel {
  const hasLayerC = run.claims.some((c) => c.citations.some((ci) => ci.layer === "c"));
  let board: WorldBoard | null = null;
  const boardsAfter = new Map<string, WorldBoard>();
  for (const step of run.trace) {
    if (step.node !== "world_model") continue;
    const b = parseBoard(step.summary);
    if (b) {
      board = b;
      boardsAfter.set(b.after, b);
    }
  }
  const reviseRounds = Math.max(run.reviseRounds ?? 0, run.trace.filter((s) => /^revise edge/i.test(s.summary)).length);
  const repairRounds = Math.max(
    run.repairRounds ?? 0,
    run.trace.filter((s) => /^repair round/i.test(s.summary)).length,
  );

  const escalated = escalationOf(run);
  const nodes = pipelineIds(run).map((id): PipelineNode => {
    const steps = run.trace.filter((s) => s.node === id && !isEdge(s));
    const work = steps.filter((s) => s.latencyMs !== null && s.latencyMs !== undefined);
    const latencies = work.map((s) => s.latencyMs as number);
    const main = steps.find((s) => s.lane || s.modelId) ?? steps[0];
    const last = steps[steps.length - 1];
    const modelProvider = new Map<string, string | null>();
    for (const s of steps) for (const m of llmIds(s.modelId)) if (!modelProvider.get(m)) modelProvider.set(m, s.provider ?? run.provider ?? null);
    const queryCount = steps.filter((s) => s.lane === "sql").reduce((n, s) => n + (s.evidenceIds?.length ?? 0), 0);
    const badges: PipelineBadge[] = [];
    if (queryCount > 0) badges.push({ kind: "zetaris", text: `Zetaris · ${queryCount} queryId${queryCount === 1 ? "" : "s"}` });
    for (const [m, p] of modelProvider) badges.push(modelBadge(m, p));
    if (id === "memory" && steps.length) {
      const n = steps.reduce((acc, s) => acc + (recalledCount(s.summary) ?? 0), 0);
      if (n > 0) badges.push({ kind: "hmem", text: `H-MEM recall · ${n}` });
    }
    const b = boardsAfter.get(id);
    if (b && (id === "investigator" || id === "skeptic")) {
      badges.push({ kind: "world", text: `World Model · ${b.states.map((s) => `${s.id} ${s.state}`).join(", ")}` });
    }
    if (id === "investigator" && hasLayerC) badges.push({ kind: "rag", text: "pgvector + Zetaris JDBC" });

    let status: NodeStatus = steps.length ? "done" : "skipped";
    let summary = id === "investigator" || id === "playbook" ? main?.summary ?? "" : last?.summary ?? "";
    if (id === "judge" && steps.length && (run.judgePasses === false || /^FLAG/.test(last?.summary ?? ""))) status = "flag";
    if (id === "router" && escalated) {
      status = "flag";
      summary = escalated;
    }
    if (id === "approval") {
      if (run.status === "awaiting_approval") {
        status = "waiting";
        summary = "Waiting for a human decision. Nothing outbound is sent before it.";
      } else if (run.status) {
        status = "done";
        summary = `Run status: ${run.status}`;
      } else {
        summary = "A human decides before anything is sent.";
      }
    }
    if (id === "memory" && !summary && run.memoryCount) summary = `recalled ${run.memoryCount} past finding(s)`;
    return {
      id,
      label: NODE_LABELS[id],
      status,
      latencyMs: latencies.length ? latencies.reduce((a, c) => a + c, 0) : null,
      lane: main?.lane ?? null,
      modelId: main?.modelId ?? null,
      provider: main?.provider ?? null,
      summary,
      runs: steps.length,
      badges,
    };
  });
  return {
    nodes,
    reviseRounds,
    repairRounds,
    board,
    totalLatencyMs: nodes.reduce((n, node) => n + (node.latencyMs ?? 0), 0),
  };
}

/** "149.3 s", "980 ms", or "—". */
export function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}
