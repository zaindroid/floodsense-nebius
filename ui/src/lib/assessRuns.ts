import { startLiveRun, subscribeRunEvents } from "../api/liveRun";
import type { AskContext } from "./askContext";
import { setAwaitingRunId } from "./lastRun";
import type { StartedRun } from "./approvalQueue";

/**
 * Agent runs a reviewer started from Alerts ("Ask the agents to assess"). Each one is a real
 * POST /runs?wait=false through the same client the Ask chat uses; nothing starts on its own, because every run
 * costs model calls. The run is followed over SSE so that, once it reaches human review, it becomes the
 * Approvals handoff run. The list lives in sessionStorage so a page change does not lose it.
 */
export interface TrackedRun extends StartedRun {
  /** The alert row or rehearsal moment that started it. */
  key: string;
  status: string;
}

export type AssessOutcome =
  | { kind: "started"; runId: string }
  | { kind: "answered"; message: string }
  | { kind: "busy"; message: string; retryAfterS: number | null }
  | { kind: "error"; message: string };

const KEY = "floodsense.assessRuns";
const MAX = 12;
type Listener = (runs: TrackedRun[]) => void;
const listeners = new Set<Listener>();
const following = new Set<string>();
let cache: TrackedRun[] | null = null;

function read(): TrackedRun[] {
  if (cache) return cache;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed)
      ? parsed.filter((r): r is TrackedRun => !!r && typeof r === "object" && typeof (r as TrackedRun).runId === "string")
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(runs: TrackedRun[]): void {
  cache = runs.slice(0, MAX);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked: listeners still hear it */
  }
  for (const l of listeners) l(cache);
}

export function trackedRuns(): TrackedRun[] {
  const runs = read();
  for (const r of runs) if (r.status === "running") follow(r.runId);
  return runs;
}

export function onTrackedRuns(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(runId: string, status: string): void {
  write(read().map((r) => (r.runId === runId ? { ...r, status } : r)));
}

function follow(runId: string): void {
  if (following.has(runId) || typeof window === "undefined") return;
  following.add(runId);
  subscribeRunEvents(runId, (event) => {
    if (event.type === "error") {
      following.delete(runId);
      return;
    }
    if (event.type !== "status") return;
    const d = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
    const status = typeof d.status === "string" ? d.status : "error";
    following.delete(runId);
    setStatus(runId, status);
    if (status === "awaiting_approval") setAwaitingRunId(runId);
  });
}

/** The newest tracked run for a key (an alert row or a rehearsal moment), or null. */
export function runForKey(runs: readonly TrackedRun[], key: string): TrackedRun | null {
  return runs.find((r) => r.key === key) ?? null;
}

/** Pure: the one line a row shows about its run. */
export function trackedLine(run: TrackedRun): string {
  switch (run.status) {
    case "running":
      return `Run ${run.runId} started · agents working (a full run takes a few minutes) · it appears in Approvals`;
    case "awaiting_approval":
      return `Run ${run.runId} is ready for review in Approvals`;
    case "approved":
    case "rejected":
    case "answered":
      return `Run ${run.runId} ended: ${run.status}`;
    case "failed":
      return `Run ${run.runId} failed after it started. It is not replaced by a recording; ask again if needed.`;
    case "not_found":
      return `Run ${run.runId} was not found.`;
    default:
      return `Run ${run.runId}: ${run.status}`;
  }
}

/** Start one assessment run. Only ever called from a button press. */
export async function startAssessment(input: {
  key: string;
  question: string;
  context: AskContext;
  eventId?: string | null;
  replayTs?: string | null;
}): Promise<AssessOutcome> {
  const result = await startLiveRun({
    question: input.question,
    context: input.context,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.replayTs ? { replayTs: input.replayTs } : {}),
  });
  if (result.kind === "started") {
    const run: TrackedRun = {
      runId: result.runId,
      key: input.key,
      question: input.question,
      startedAt: new Date().toISOString(),
      eventId: input.eventId ?? null,
      status: "running",
    };
    write([run, ...read().filter((r) => r.runId !== run.runId)]);
    follow(run.runId);
    return { kind: "started", runId: run.runId };
  }
  if (result.kind === "run") {
    const r = result.run;
    if (r.status === "awaiting_approval") setAwaitingRunId(r.runId);
    // A finished cache hit or replay is still this press's run: track it, so it reaches the queue of the desk that asked.
    write([
      { runId: r.runId, key: input.key, question: input.question, startedAt: new Date().toISOString(), eventId: input.eventId ?? null, status: r.status ?? "answered" },
      ...read().filter((x) => x.runId !== r.runId),
    ]);
    const label = r.servedFrom === "live" ? "a live run" : r.servedFrom === "cache" ? "the cache (not live)" : "a recorded replay (not live)";
    return { kind: "answered", message: `Answered at once from ${label}, run ${r.runId}${r.status === "awaiting_approval" ? " · waiting in Approvals" : ""}.` };
  }
  if (result.kind === "reply") return { kind: "answered", message: result.answer };
  if (result.kind === "rate_limited") {
    return {
      kind: "busy",
      retryAfterS: result.retryAfterS,
      message: `The agents are busy; no run was started.${result.retryAfterS ? ` Try again in ${result.retryAfterS} s.` : ""}`,
    };
  }
  if (result.kind === "aborted") return { kind: "error", message: "Cancelled." };
  return { kind: "error", message: result.message };
}
