import type { ReplayStep } from "../api/replay";
import type { LiveRunState } from "./liveRun";

/**
 * Pure mappers for the "Under the hood" page. Every number here comes from a response field; a missing field
 * becomes null or an empty list, never a made-up value.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Where a card's numbers come from. none = nothing to show yet. */
export type DataKind = "live" | "replay" | "sample" | "none";

/* ---------- agent pool ---------- */

export const CORE_NODES = ["scope", "watchers", "memory", "investigator", "skeptic", "exposure", "playbook", "judge"] as const;
export type CoreId = (typeof CORE_NODES)[number];
export const CORE_LABELS: Record<CoreId, string> = {
  scope: "Scope",
  watchers: "Watchers",
  memory: "Memory",
  investigator: "Investigator",
  skeptic: "Skeptic",
  exposure: "Exposure",
  playbook: "Playbook",
  judge: "Judge",
};

export interface Frame {
  node: CoreId;
  latencyMs: number | null;
  modelId: string | null;
  summary: string;
}

/** Trace steps of the 8 core agents in run order. world_model, router and unknown nodes are not nodes here. */
export function traceFrames(trace: readonly ReplayStep[] | null | undefined): Frame[] {
  const ids = new Set<string>(CORE_NODES);
  return [...(trace ?? [])]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.seq || 0) - (b.s.seq || 0) || a.i - b.i)
    .filter(({ s }) => ids.has(s.node))
    .map(({ s }) => ({
      node: s.node as CoreId,
      latencyMs: s.latencyMs ?? null,
      modelId: s.modelId ?? null,
      summary: s.summary ?? "",
    }));
}

export interface NodeView {
  id: CoreId;
  label: string;
  state: "idle" | "active" | "done";
  runs: number;
  latencyMs: number | null;
  /** Comma-joined distinct model ids the node's steps named; "deterministic" is a rule, not a model. */
  modelId: string | null;
}

/** Node states after the first `played` frames: the last played frame is active, earlier ones done. */
export function nodeStatesAt(frames: readonly Frame[], played: number): NodeView[] {
  const n = Math.max(0, Math.min(played, frames.length));
  return CORE_NODES.map((id) => {
    let runs = 0;
    let ms: number | null = null;
    const models: string[] = [];
    frames.slice(0, n).forEach((f) => {
      if (f.node !== id) return;
      runs += 1;
      if (f.latencyMs !== null) ms = (ms ?? 0) + f.latencyMs;
      for (const m of (f.modelId ?? "").split(",").map((x) => x.trim()).filter(Boolean)) if (!models.includes(m)) models.push(m);
    });
    const active = n > 0 && frames[n - 1].node === id;
    return { id, label: CORE_LABELS[id], state: active ? "active" : runs > 0 ? "done" : "idle", runs, latencyMs: ms, modelId: models.join(", ") || null };
  });
}

/** Loops seen in the first `played` frames: a second Investigator pass is a revise round, a second Judge pass a repair round. */
export function loopsAt(frames: readonly Frame[], played: number): { revise: number; repair: number } {
  const seen = frames.slice(0, Math.max(0, played));
  const count = (id: CoreId) => seen.filter((f) => f.node === id).length;
  return { revise: Math.max(0, count("investigator") - 1), repair: Math.max(0, count("judge") - 1) };
}

/** Live SSE state as frames-equivalent node views, so one renderer draws both. */
export function nodesFromLive(state: LiveRunState): NodeView[] {
  return CORE_NODES.map((id) => {
    const n = state.nodes.find((x) => x.id === id);
    return {
      id,
      label: CORE_LABELS[id],
      state: n?.state === "running" ? "active" : n?.state === "done" ? "done" : "idle",
      runs: n?.runs ?? 0,
      latencyMs: n?.durationMs ?? null,
      modelId: n?.modelId ?? null,
    };
  });
}

/* ---------- Nebius Token Factory / Nemotron usage ---------- */

export interface LaneUsage {
  lane: string;
  calls: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  /** Distinct model ids that served this lane (from a run's usage.models). */
  modelIds: string[];
}
export interface UsageView {
  lanes: LaneUsage[];
  totalCalls: number;
  totalTokens: number;
  costUsd: number | null;
}

function usageView(lanes: LaneUsage[], costUsd: number | null): UsageView | null {
  if (!lanes.length) return null;
  return {
    lanes,
    totalCalls: lanes.reduce((a, l) => a + l.calls, 0),
    totalTokens: lanes.reduce((a, l) => a + l.totalTokens, 0),
    costUsd,
  };
}

/** A run body's `usage` ({lanes, models, total, cost_usd}); null when absent, null, or empty. */
export function usageOfRun(raw: unknown): UsageView | null {
  const u = obj(raw);
  const models = (Array.isArray(u.models) ? u.models : []).map(obj);
  const lanes = Object.entries(obj(u.lanes)).map(([lane, v]) => {
    const l = obj(v);
    return {
      lane,
      calls: num(l.calls) ?? 0,
      totalTokens: num(l.total_tokens) ?? 0,
      avgLatencyMs: num(l.avg_latency_ms),
      modelIds: models.filter((m) => m.lane === lane).flatMap((m) => str(m.model_id) ?? []),
    };
  });
  return usageView(lanes, num(u.cost_usd));
}

/** Eased counter value: t in [0,1]. */
export function easeCount(from: number, to: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
}

/* ---------- Zetaris views ---------- */

export interface ViewRead {
  queryId: string;
  view: string;
  /** Row count; null when the body does not state one. */
  rows: number | null;
  failed: boolean;
  source: string;
}

/** Upstream behind a Zetaris view (docs/architecture: gauges from PEGELONLINE, hazard and forecast from Open-Meteo...). */
export function sourceOfView(view: string): string {
  const v = view.toLowerCase();
  if (v.startsWith("floodsense_seed.")) return "Seed CSVs";
  if (v.includes("gauge_levels")) return "PEGELONLINE";
  if (/discharge_daily|hazard_now|hazard_timeline|weather_forecast|eu_watch/.test(v)) return "Open-Meteo";
  if (v.includes("exposure_join")) return "Copernicus EMS";
  return "Zetaris catalogue";
}

/** A run body's `evidence` ({query_id: {view, row_count, error?}}) as one row per query; errors are kept visible as null rows. */
export function viewReads(raw: unknown): ViewRead[] {
  return Object.entries(obj(raw)).map(([key, v]) => {
    const e = obj(v);
    const view = str(e.view) ?? "unknown view";
    return {
      queryId: str(e.query_id) ?? key,
      view,
      rows: e.error ? null : num(e.row_count),
      failed: !!e.error,
      source: sourceOfView(view),
    };
  });
}

/** Fallback when a body has no evidence map: the layer-a citations still name view and query id (row counts unknown). */
export function readsFromCitations(claims: readonly { citations: readonly { layer: string; title: string; queryId: string | null }[] }[]): ViewRead[] {
  const out: ViewRead[] = [];
  for (const c of claims.flatMap((x) => x.citations)) {
    if (c.layer !== "a" || !c.queryId || out.some((r) => r.queryId === c.queryId)) continue;
    out.push({ queryId: c.queryId, view: c.title, rows: null, failed: false, source: sourceOfView(c.title) });
  }
  return out;
}

/* ---------- memory ---------- */

export interface RecalledMemory {
  id: string;
  text: string;
}

/** What H-MEM recalled in this run: memory_used (with text) or the raw memories list. */
export function memoryRecall(body: unknown): RecalledMemory[] {
  const b = obj(body);
  const list = Array.isArray(b.memory_used) ? b.memory_used : Array.isArray(b.memories) ? b.memories : [];
  return list.flatMap((raw, i) => {
    const m = obj(raw);
    const text = str(m.text) ?? str(m.content);
    return text ? [{ id: str(m.memory_id) ?? `memory ${i + 1}`, text: text.length > 140 ? `${text.slice(0, 137)}...` : text }] : [];
  });
}

/* ---------- cache and limits ---------- */

/** Hit rate 0..1 from counters; null with no lookups (never a 0% claim). */
export function hitRateOf(hits: number, misses: number): number | null {
  return hits + misses > 0 ? hits / (hits + misses) : null;
}

/** Stroke-dasharray for a ring of radius r filled to `rate` (0..1). */
export function ringDash(rate: number | null, r: number): string {
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, rate ?? 0)) * c;
  return `${f.toFixed(2)} ${(c - f).toFixed(2)}`;
}

/** One boolean per slot, true = in use. Capped so a misconfigured max never floods the DOM. */
export function slotLights(inFlight: number, max: number, cap = 12): boolean[] {
  const n = Math.max(0, Math.min(Math.floor(max), cap));
  return Array.from({ length: n }, (_, i) => i < inFlight);
}

/** CountUp start value: static data starts at its value; only a later change animates from the previous one. */
export function countStart(prev: number | null, value: number): number {
  return prev ?? value;
}

/**
 * Judge chips belong to the run on screen only. While a live run streams, the recorded run in hand is a
 * different (previous) run, so nothing is shown. Otherwise they carry that run's id.
 */
export function judgeChips(
  run: { runId: string; judgeOverall: number | null; judgePasses: boolean | null; judgeClaims?: { score: number | null }[] } | null,
  streamingLive: boolean,
  finished: boolean,
): { runId: string; overall: number | null; flagged: boolean; scores: number[] } | null {
  if (!run || streamingLive || !finished) return null;
  const scores = (run.judgeClaims ?? []).flatMap((j) => (j.score === null ? [] : [j.score]));
  if (run.judgeOverall === null && !scores.length) return null;
  return { runId: run.runId, overall: run.judgeOverall, flagged: run.judgePasses === false, scores };
}

/** Next poll delay: hidden tabs wait long, consecutive failures back off (x2 per failure, capped at 60 s). */
export function nextPollMs(base: number, failures: number, hidden: boolean): number {
  if (hidden) return 30_000;
  return Math.min(60_000, base * 2 ** Math.max(0, Math.min(failures, 6)));
}
