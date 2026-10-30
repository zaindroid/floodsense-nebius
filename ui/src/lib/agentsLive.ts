import type { PlatformStatus } from "../api/platform";
import type { ReplayStep } from "../api/replay";
import { hhmm, type WatchEvent } from "./controlTower";
import { NEBIUS_NAME } from "./lanes";
import type { LiveRunState } from "./liveRun";
import { CORE_NODES, hitRateOf, slotLights, type CoreId, type DataKind, type Frame, type NodeView, type ViewRead } from "./stack";

/**
 * Pure logic of the animated agent pool (<AgentsLive/>). Every value is read from an API response or a recorded run;
 * a missing field becomes null or an empty list, never a made-up number.
 */

/** The badge: live = a run streaming now; replay = a recorded run played back; sample = the bundled example. */
export function sourceKind(live: Pick<LiveRunState, "status"> | null, recorded: { kind: "live" | "replay" | "sample" } | null): DataKind {
  // useStackData keeps `live` for a moment after the stream ends; only a still-running stream is live.
  if (live && live.status === "running") return "live";
  if (!recorded) return "none";
  // A run that streamed here and finished is a recording now, not something happening.
  return recorded.kind === "sample" ? "sample" : "replay";
}

/* ---------- replay timer ---------- */

export const REPLAY_HOLD_MS = 5000;

/** Wait before the next recorded step shows: the step's own latency sped up 10x, clamped to 0.5 to 1.6 s. */
export function replayDelayMs(frame: Pick<Frame, "latencyMs"> | undefined): number {
  const l = frame?.latencyMs;
  return l == null ? 800 : Math.round(Math.max(500, Math.min(1600, l / 10)));
}

/** Next played-step count: one more frame, then back to 0 after the hold on the finished run. */
export function replayNext(played: number, total: number): number {
  return played < total ? played + 1 : 0;
}

/** Steps the recorded trace on timers, loops after the hold. Returns the cleanup that cancels the pending timer. */
export function startReplay(frames: readonly Pick<Frame, "latencyMs">[], onPlayed: (n: number) => void): () => void {
  let n = 0;
  let t: ReturnType<typeof setTimeout>;
  const step = () => {
    t = setTimeout(() => {
      n = replayNext(n, frames.length);
      onPlayed(n);
      step();
    }, n < frames.length ? replayDelayMs(frames[n]) : REPLAY_HOLD_MS);
  };
  onPlayed(0);
  step();
  return () => clearTimeout(t);
}

/* ---------- handoff ---------- */

export interface Handoff {
  from: CoreId;
  to: CoreId;
}

/** Replay: the step just played was handed work by the step before it (Skeptic -> Investigator is a revise loop). */
export function handoffAt(frames: readonly Frame[], played: number): Handoff | null {
  if (played < 2 || played > frames.length) return null;
  const from = frames[played - 2].node;
  const to = frames[played - 1].node;
  return from === to ? null : { from, to };
}

/** Live: the running agent was handed work by the nearest earlier agent that finished. */
export function handoffLive(nodes: readonly NodeView[]): Handoff | null {
  const i = nodes.findIndex((n) => n.state === "active");
  for (let j = i - 1; j >= 0; j--) if (nodes[j].state === "done") return { from: nodes[j].id, to: nodes[i].id };
  return null;
}

/** True when the wire between CORE_NODES[i] and CORE_NODES[i+1] carries the handoff. */
export function wireOn(h: Handoff | null, i: number): boolean {
  return !!h && h.from === CORE_NODES[i] && h.to === CORE_NODES[i + 1];
}

/* ---------- tool-call chips ---------- */

export interface ToolContext {
  reads: readonly ViewRead[];
  /** H-MEM memories the run recalled. */
  recalled: number;
  /** world_model trace steps of the run. */
  worldModelSteps: number;
}

export function worldModelSteps(trace: readonly ReplayStep[] | null | undefined): number {
  return (trace ?? []).filter((s) => s.node === "world_model").length;
}

const isGauge = (v: string) => /gauge_levels|hazard_now|eu_watch/i.test(v);
const isExposure = (v: string) => /exposure_join/i.test(v);
const viewNames = (list: readonly ViewRead[]) => [...new Set(list.map((r) => r.view.replace(/^.*\./, "")))];

/** Chips under one agent, only for tools the recorded run shows. A live run carries no evidence until it ends, so it has none. */
export function toolChips(node: CoreId, c: ToolContext): string[] {
  switch (node) {
    case "memory":
      return c.recalled > 0 ? [`H-MEM recall x${c.recalled}`] : [];
    case "watchers": {
      const v = viewNames(c.reads.filter((r) => isGauge(r.view)));
      return v.length ? [`Zetaris SQL: ${v.join(", ")}`] : [];
    }
    case "exposure": {
      const v = viewNames(c.reads.filter((r) => isExposure(r.view)));
      return v.length ? [`Zetaris SQL: ${v.join(", ")}`] : [];
    }
    case "investigator": {
      const rest = c.reads.filter((r) => !isGauge(r.view) && !isExposure(r.view));
      return rest.length ? [`Zetaris SQL x${rest.length} view reads`] : [];
    }
    case "skeptic":
      return c.worldModelSteps > 0 ? [`World Model x${c.worldModelSteps}`] : [];
    default:
      return [];
  }
}

/* ---------- cache ---------- */

export interface CacheBadge {
  text: string;
  tone: "live" | "cache" | "replay" | "none";
}

/** A run's served_from as a badge: live / cache / replay, or nothing stated. `recorded` words it as a fact about a past run. */
export function servedBadge(servedFrom: string | null | undefined, recorded = false): CacheBadge {
  const pre = recorded ? "Recorded run: " : "";
  switch (servedFrom) {
    case "live":
      return { text: `${pre}${recorded ? "computed live" : "Computed live"}`, tone: "live" };
    case "cache":
      return { text: `${pre}${recorded ? "cache hit" : "Cache hit"}`, tone: "cache" };
    case "replay":
      return { text: `${pre}${recorded ? "replayed answer" : "Replayed answer"}`, tone: "replay" };
    default:
      return { text: "Source not stated", tone: "none" };
  }
}

/** Global counters: "3 hits · 1 miss · 75% hit rate"; null when the API did not report them. */
export function cacheLine(p: PlatformStatus | null): string | null {
  if (!p) return null;
  const { hits, misses } = p.cache;
  const rate = p.cache.hitRate ?? hitRateOf(hits, misses);
  return `${hits} hit${hits === 1 ? "" : "s"} · ${misses} miss${misses === 1 ? "" : "es"} · ${rate === null ? "no lookups yet" : `${Math.round(rate * 100)}% hit rate`}`;
}

/* ---------- rate limit ---------- */

export interface RateView {
  lights: boolean[];
  inFlight: number;
  max: number;
  runsPerMin: number;
  recent429: number;
}

export function rateView(p: PlatformStatus | null): RateView | null {
  if (!p) return null;
  const r = p.rateLimit;
  return { lights: slotLights(r.inFlight, r.maxConcurrent), inFlight: r.inFlight, max: r.maxConcurrent, runsPerMin: r.runsPerMin, recent429: r.recent429 };
}

/** Whole seconds left of a Retry-After wait; null when there is none or it passed. */
export function secondsLeft(until: number | null, now: number): number | null {
  if (until === null) return null;
  const s = Math.ceil((until - now) / 1000);
  return s > 0 ? s : null;
}

/** Deadline from a Retry-After value in seconds; null when the server gave none. */
export function retryDeadline(retryAfterS: number | null, now: number): number | null {
  return retryAfterS !== null && retryAfterS > 0 ? now + retryAfterS * 1000 : null;
}

/* ---------- model per lane ---------- */

export interface LaneRow {
  lane: string;
  model: string | null;
  calls: number | null;
  tokens: number | null;
  avgMs: number | null;
  p50Ms: number | null;
}

export function backendName(b: string | null | undefined): string | null {
  return b === "nebius" ? NEBIUS_NAME : b === "nightshift" ? "Nightshift" : b || null;
}

/** One row per lane the platform status names: model id, calls, tokens (this process) and latency. */
export function laneRows(p: PlatformStatus | null): LaneRow[] {
  if (!p) return [];
  const names = [...new Set([...Object.keys(p.lanes), ...Object.keys(p.llmUsage?.lanes ?? {})])];
  return names.map((lane) => {
    const u = p.llmUsage?.lanes[lane];
    return {
      lane,
      model: p.lanes[lane] ?? null,
      calls: u ? u.calls : null,
      tokens: u ? u.totalTokens : null,
      avgMs: u?.avgLatencyMs ?? null,
      p50Ms: p.latency[lane]?.p50Ms ?? null,
    };
  });
}

/* ---------- watch loop ---------- */

export interface WatchLine {
  id: string;
  agent: string;
  time: string;
  text: string;
}

/** The newest `n` feed events, newest first. */
export function watchLines(events: readonly WatchEvent[], n = 3): WatchLine[] {
  return events
    .slice(-n)
    .reverse()
    .map((e) => ({ id: e.id, agent: e.agent, time: hhmm(e.ts), text: e.text.length > 110 ? `${e.text.slice(0, 107)}...` : e.text }));
}
