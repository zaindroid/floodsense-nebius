import { useEffect, useMemo, useState } from "react";
import { fetchWatchEvents, subscribeWatch } from "../api/watch";
import { reducedMotion } from "../components/stack/StackBits";
import {
  handoffAt,
  handoffLive,
  startReplay,
  retryDeadline,
  secondsLeft,
  sourceKind,
  toolChips,
  worldModelSteps,
  type Handoff,
} from "../lib/agentsLive";
import { mergeEvents, type WatchEvent } from "../lib/controlTower";
import {
  CORE_NODES,
  loopsAt,
  memoryRecall,
  nodeStatesAt,
  nodesFromLive,
  readsFromCitations,
  traceFrames,
  viewReads,
  type CoreId,
  type DataKind,
  type NodeView,
} from "../lib/stack";
import { useStackData, type StackData } from "./useStackData";

const WATCH_POLL_MS = 15_000;

export interface AgentsLiveModel {
  kind: DataKind;
  runId: string | null;
  nodes: NodeView[];
  handoff: Handoff | null;
  loops: { revise: number; repair: number };
  servedFrom: string | null;
  chips: Record<CoreId, string[]>;
  /** Replay only: steps shown so far and in total. */
  played: number;
  total: number;
  /** True when motion is reduced: a replay shows its final state at once and does not loop. */
  still: boolean;
  watch: WatchEvent[];
  watchOpen: boolean;
  /** Seconds left of a Retry-After wait the API asked for; null when none. */
  retryLeft: number | null;
  announce: string;
}

/** Merges the stack poll (platform status every 5 s, running/recorded run), the watch stream and the latest run into one view. */
export function useAgentsLiveFrom(stack: StackData, watchIn?: { events: WatchEvent[]; open: boolean }): AgentsLiveModel {
  const { stackRun } = stack;
  const live = stack.live && stack.live.status === "running" ? stack.live : null;
  const run = stackRun?.run ?? null;
  const frames = useMemo(() => traceFrames(run?.trace), [run]);
  const total = frames.length;
  const still = reducedMotion();
  const [played, setPlayed] = useState(0);
  const [watch, setWatch] = useState<WatchEvent[]>([]);
  const [watchOpen, setWatchOpen] = useState(false);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Replay timer: step through the recorded trace at its own pace, hold, start again. Never runs while a live run streams.
  useEffect(() => {
    if (live || total === 0) return;
    if (still) {
      setPlayed(total);
      return;
    }
    return startReplay(frames, setPlayed);
  }, [!!live, still, total, frames]);

  // Watch feed: SSE for new events, a slow poll for the backlog and for a 429's Retry-After.
  useEffect(() => {
    if (watchIn) return;
    const ctl = new AbortController();
    const load = async () => {
      const r = await fetchWatchEvents(null, 20, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.ok) setWatch((prev) => mergeEvents(prev, r.value, 50));
      else if (r.status === 429) {
        const t = Date.now();
        setNow(t);
        setRetryUntil(retryDeadline(r.retryAfterS, t));
      }
    };
    void load();
    const poll = setInterval(() => void load(), WATCH_POLL_MS);
    const stop = subscribeWatch(null, (e) => setWatch((prev) => mergeEvents(prev, [e], 50)), setWatchOpen);
    return () => {
      ctl.abort();
      clearInterval(poll);
      stop();
    };
  }, [!!watchIn]);

  // One-second clock only while a Retry-After countdown runs.
  useEffect(() => {
    if (retryUntil === null) return;
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
      if (retryUntil <= Date.now()) setRetryUntil(null);
    }, 1000);
    return () => clearInterval(t);
  }, [retryUntil]);

  const shown = live ? total : Math.min(played, total);
  const nodes = live ? nodesFromLive(live) : nodeStatesAt(frames, shown);
  const handoff = live ? handoffLive(nodes) : handoffAt(frames, shown);
  const loops = live ? { revise: live.reviseRounds, repair: live.repairRounds } : loopsAt(frames, shown);
  const rawBody = stackRun?.raw;
  const chips = useMemo(() => {
    const raw = (rawBody ?? {}) as Record<string, unknown>;
    const ev = viewReads(raw.evidence);
    const ctx = {
      reads: ev.length ? ev : readsFromCitations(run?.claims ?? []),
      recalled: memoryRecall(raw).length,
      worldModelSteps: worldModelSteps(run?.trace),
    };
    return Object.fromEntries(CORE_NODES.map((id) => [id, toolChips(id, ctx)])) as Record<CoreId, string[]>;
  }, [rawBody, run]);

  return {
    kind: sourceKind(live, stackRun),
    runId: live?.runId ?? run?.runId ?? null,
    nodes,
    handoff,
    loops,
    servedFrom: live ? live.servedFrom : run?.servedFrom ?? null,
    // A live run has no recorded evidence yet, so it shows no tool chips.
    chips: live ? (Object.fromEntries(CORE_NODES.map((id) => [id, []])) as unknown as Record<CoreId, string[]>) : chips,
    played: shown,
    total,
    still,
    watch: watchIn ? watchIn.events : watch,
    watchOpen: watchIn ? watchIn.open : watchOpen,
    retryLeft: secondsLeft(retryUntil, now),
    announce: live ? live.announce : "",
  };
}

/** Standalone: polls on its own. On a page that already runs useStackData, pass its result to <AgentsLive stack={...}/> instead. */
export function useAgentsLive(watchIn?: { events: WatchEvent[]; open: boolean }): { model: AgentsLiveModel; stack: StackData } {
  const stack = useStackData();
  return { model: useAgentsLiveFrom(stack, watchIn), stack };
}
