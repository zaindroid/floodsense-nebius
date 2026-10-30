import { FORECAST_ORDER, NODE_LABELS, PIPELINE_ORDER, QUICK_ONLY, QUICK_ORDER, statusText, type PipelineNodeId } from "./pipeline";

/**
 * Pure state for a live run streamed from GET /runs/{id}/events.
 * `started` lights a node, `trace` finishes it (duration, model, summary), `status` ends the stream.
 */

export type LiveNodeState = "idle" | "running" | "done";

export interface LiveNode {
  id: PipelineNodeId;
  label: string;
  state: LiveNodeState;
  /** Sum of the finished steps' durations. */
  durationMs: number | null;
  modelId: string | null;
  /** Backend that served modelId, as the trace event states it. */
  provider: string | null;
  lane: string | null;
  summary: string;
  /** Finished steps (a revise or repair loop runs a node again). */
  runs: number;
}

export type LiveStatus = "running" | "awaiting_approval" | "approved" | "rejected" | "failed" | "not_found" | "error" | string;

export interface LiveRunState {
  runId: string;
  nodes: LiveNode[];
  reviseRounds: number;
  repairRounds: number;
  /** "Skeptic sent back 1 claim", "Judge repair round 1". */
  loops: string[];
  /** Final status, or "running". */
  status: LiveStatus;
  servedFrom: string | null;
  cachedAt: string | null;
  /** One line for the aria-live region. */
  announce: string;
  seen: number[];
  error: string | null;
  /** Router lane once the router step lands: quick or full; null before. */
  lane?: "quick" | "forecast" | "full" | null;
  /** "escalated: ..." when the quick lane handed the run to the full lane. */
  escalated?: string | null;
}

export type LiveEvent =
  | { type: "started"; data: unknown }
  | { type: "trace"; data: unknown }
  | { type: "status"; data: unknown }
  | { type: "error"; message: string };

/** Graph node names in the trace, mapped to the pipeline the UI draws. world_model is not a node here. */
const NODE_ALIASES: Record<string, PipelineNodeId> = {
  router: "router",
  escalate: "router",
  scope: "scope",
  live_watch: "live_watch",
  quick_answer: "quick_answer",
  quick_judge: "judge",
  forecast_data: "forecast_data",
  history: "history",
  forecast_answer: "forecast_answer",
  forecast_judge: "judge",
  watchers: "watchers",
  memory: "memory",
  recall: "memory",
  investigator: "investigator",
  skeptic: "skeptic",
  exposure: "exposure",
  playbook: "playbook",
  judge: "judge",
  hitl: "approval",
  approval: "approval",
  learn: "approval",
};

export function liveNodeId(node: unknown): PipelineNodeId | null {
  return typeof node === "string" ? NODE_ALIASES[node.toLowerCase()] ?? null : null;
}


function blankNode(id: PipelineNodeId): LiveNode {
  return {
    id,
    label: id === "approval" ? "Human review" : NODE_LABELS[id],
    state: "idle",
    durationMs: null,
    modelId: null,
    provider: null,
    lane: null,
    summary: "",
    runs: 0,
  };
}

/** The nodes a lane draws, keeping what has already landed. Quick: no Human review. */
export function laneNodes(
  nodes: LiveNode[],
  lane: "quick" | "forecast" | "full" | null,
  escalated = false,
): LiveNode[] {
  const ran = new Set(nodes.map((n) => n.id));
  const ids: readonly PipelineNodeId[] =
    lane === "quick"
      ? QUICK_ORDER
      : lane === "forecast"
        ? FORECAST_ORDER
        : PIPELINE_ORDER.filter((id) => !QUICK_ONLY.includes(id) || (escalated && ran.has(id)));
  return ids.map((id) => nodes.find((n) => n.id === id) ?? blankNode(id));
}

export function initialLiveState(runId: string): LiveRunState {
  return {
    runId,
    nodes: laneNodes([], null),
    reviseRounds: 0,
    repairRounds: 0,
    loops: [],
    status: "running",
    servedFrom: null,
    cachedAt: null,
    announce: "Run started.",
    seen: [],
    error: null,
    lane: null,
    escalated: null,
  };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "nvidia/nemotron-3.5-lightning-30b-a3b" -> "nemotron-3.5-lightning". */
export function shortModel(modelId: string): string {
  const base = modelId.includes("/") && !modelId.startsWith("meterless/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  return base.replace(/-\d+(\.\d+)?b(-a\d+(\.\d+)?b)?$/i, "");
}

/** Provider from the model id itself (shared rule in ./lanes). */
export { providerOf } from "./lanes";
import { providerOf } from "./lanes";

/** The model line under a finished node: "nemotron-3.5-lightning · Nightshift", "deterministic", "SQL · Zetaris". */
export function modelLine(modelId: string | null, lane: string | null): string {
  const ids = (modelId ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== "deterministic");
  if (ids.length) return [...new Set(ids.map((id) => {
    const provider = providerOf(id);
    return provider ? `${shortModel(id)} · ${provider}` : shortModel(id);
  }))].join(", ");
  if ((lane ?? "").toLowerCase() === "sql") return "SQL · Zetaris";
  return "deterministic";
}

function patch(state: LiveRunState, id: PipelineNodeId, fn: (n: LiveNode) => LiveNode): LiveNode[] {
  return state.nodes.map((n) => (n.id === id ? fn(n) : n));
}

/** Pure reducer. Unknown nodes and duplicate trace seqs are ignored. */
export function liveReducer(state: LiveRunState, event: LiveEvent): LiveRunState {
  if (event.type === "error") return { ...state, status: "error", error: event.message, announce: event.message };
  const d = rec(event.data);
  if (event.type === "status") {
    const status = str(d.status) ?? "error";
    const nodes =
      status === "awaiting_approval"
        ? patch(state, "approval", (n) => ({ ...n, state: "running", summary: "Waiting for a human decision. Nothing is sent before it." }))
        : state.nodes;
    return { ...state, nodes, status, servedFrom: str(d.served_from), cachedAt: str(d.cached_at), announce: statusAnnounce(status) };
  }
  const id = liveNodeId(d.node);
  if (!id) return state;
  const label = state.nodes.find((n) => n.id === id)?.label ?? NODE_LABELS[id];
  if (event.type === "started") {
    const current = state.nodes.find((n) => n.id === id);
    if (current?.state === "running") return state;
    return { ...state, nodes: patch(state, id, (n) => ({ ...n, state: "running" })), announce: `${label} started.` };
  }
  // trace: a finished step.
  const seq = num(d.seq);
  if (seq !== null && state.seen.includes(seq)) return state;
  const summary = str(d.summary) ?? "";
  const seen = seq !== null ? [...state.seen, seq] : state.seen;
  let { reviseRounds, repairRounds } = state;
  const loops = [...state.loops];
  if (id === "skeptic" && /^revise edge/i.test(summary)) {
    reviseRounds += 1;
    const prior = state.nodes.find((n) => n.id === "skeptic")?.summary ?? "";
    const m = /(\d+)\s+not[_ ]supported/i.exec(prior);
    const n = m ? Number(m[1]) : null;
    loops.push(n !== null ? `Skeptic sent back ${n} unsupported hypothes${n === 1 ? "is" : "es"} · revise round ${reviseRounds}` : `Skeptic sent the chain back to the Investigator (round ${reviseRounds})`);
    return { ...state, seen, reviseRounds, loops, announce: loops[loops.length - 1] };
  }
  if (id === "router") {
    const prev = state.nodes.find((n) => n.id === "router");
    const routed = patch(state, "router", (n) => ({
      ...n,
      state: "done",
      durationMs: num(d.duration_ms) ?? num(d.latency_ms) ?? n.durationMs,
      modelId: str(d.model_id) ?? n.modelId,
      provider: str(d.provider) ?? n.provider,
      lane: str(d.lane) ?? n.lane,
      summary: summary || n.summary,
      runs: (prev?.runs ?? 0) + 1,
    }));
    if (/^escalated:/i.test(summary)) {
      loops.push(`Escalated to the full investigation: ${summary.replace(/^escalated:\s*/i, "")}`);
      return { ...state, seen, loops, lane: "full", escalated: summary, nodes: laneNodes(routed, "full", true), announce: loops[loops.length - 1] };
    }
    const lane = /^chose quick/i.test(summary)
      ? "quick"
      : /^chose forecast/i.test(summary)
        ? "forecast"
        : /^chose full/i.test(summary)
          ? "full"
          : state.lane ?? null;
    return { ...state, seen, lane, nodes: laneNodes(routed, lane, false), announce: summary ? `Router: ${summary}` : "Router finished." };
  }
  const repair = /^repair round\s*(\d+)?/i.exec(summary);
  if (repair) {
    repairRounds += 1;
    loops.push(`Judge repair round ${repair[1] ?? repairRounds}`);
  }
  const duration = num(d.duration_ms) ?? num(d.latency_ms);
  const nodes = patch(state, id, (n) => ({
    ...n,
    state: id === "approval" ? n.state : "done",
    durationMs: duration === null ? n.durationMs : (n.durationMs ?? 0) + duration,
    modelId: str(d.model_id) ?? n.modelId,
    provider: str(d.provider) ?? n.provider,
    lane: str(d.lane) ?? n.lane,
    summary: summary || n.summary,
    runs: n.runs + 1,
  }));
  return { ...state, nodes, seen, reviseRounds, repairRounds, loops, announce: repair ? loops[loops.length - 1] : `${label} finished.` };
}

export function statusAnnounce(status: string): string {
  switch (status) {
    case "awaiting_approval":
      return "Run reached human review.";
    case "answered":
      return `${statusText(status)}.`;
    case "failed":
      return "The run failed.";
    case "not_found":
      return "The run was not found. It may have stopped before its first step.";
    case "approved":
    case "rejected":
      return `Run ${status}.`;
    default:
      return `Run status: ${status}.`;
  }
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date), or null. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/** "0:42", "5:07". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const WAIT_TIPS = [
  "Every number in the answer comes from a cited Zetaris query.",
  "The Skeptic re-runs counter-check queries before anything reaches you.",
  "H-MEM recalls only findings a person approved earlier.",
  "The Judge scores each claim against its evidence; a flagged claim gets one repair round.",
  "Nothing outbound is sent until a person approves it.",
  "A deep reasoning lane can take a minute or two per step. That is normal.",
  "Exposure joins the hazard to insured sites through SQL, not a model guess.",
];

/** Pure: the tip for this elapsed second, rotating every 12 s. */
export function tipFor(seconds: number, tips: readonly string[] = WAIT_TIPS): string {
  return tips[Math.floor(Math.max(0, seconds) / 12) % tips.length];
}
