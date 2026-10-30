import { useEffect, useState } from "react";
import sampleRun from "../fixtures/run_f16733274f1c.json";
import { fetchPlatformStatus, type PlatformStatus } from "../api/platform";
import { fetchPastRuns } from "../api/pastRuns";
import { fetchReplayBody } from "../api/stackRun";
import { subscribeRunEvents, resolveFinalRun } from "../api/liveRun";
import { fetchSystem } from "../api/system";
import { adoptReplay, type RecordedRun } from "../api/replay";
import { initialLiveState, liveReducer, type LiveRunState } from "../lib/liveRun";
import { SYSTEM_POLL_MS, type SystemStatus } from "../lib/system";
import { traceFrames } from "../lib/stack";
import { publishPlatform } from "../lib/platformStore";
import { createPoller } from "../lib/stackPoll";

export interface StackRun {
  raw: unknown;
  run: RecordedRun;
  /** live = streamed to this page just now; replay = recorded run from the API; sample = bundled recording. */
  kind: "live" | "replay" | "sample";
}
export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export interface StackData {
  platform: Fetched<PlatformStatus>;
  system: Fetched<SystemStatus>;
  /** The run to replay: newest recorded run with a trace, else the bundled sample. */
  stackRun: StackRun | null;
  /** A run streaming right now (SSE), null when none runs. */
  live: LiveRunState | null;
  runsError: string | null;
}

const SAMPLE_ID = "run_f16733274f1c";

function sample(): StackRun | null {
  const run = adoptReplay(sampleRun, SAMPLE_ID);
  return run ? { raw: sampleRun, run, kind: "sample" } : null;
}

/** One poll loop for the page: platform status, /system, newest recorded run, and the SSE follow of a running run. */
export function useStackData(): StackData {
  const [platform, setPlatform] = useState<Fetched<PlatformStatus>>({ data: null, error: null, loading: true });
  const [system, setSystem] = useState<Fetched<SystemStatus>>({ data: null, error: null, loading: true });
  const [stackRun, setStackRun] = useState<StackRun | null>(null);
  const [live, setLive] = useState<LiveRunState | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    let stopStream: (() => void) | null = null;
    let streaming: string | null = null;
    let shown: string | null = null;

    const loadRun = async (id: string, kind: StackRun["kind"]) => {
      const raw = await fetchReplayBody(id, ctl.signal);
      const run = raw ? adoptReplay(raw, id) : null;
      if (ctl.signal.aborted || !run || !traceFrames(run.trace).length) return false;
      shown = id;
      setStackRun({ raw, run, kind });
      return true;
    };

    const follow = (id: string) => {
      streaming = id;
      let state = initialLiveState(id);
      setLive(state);
      stopStream = subscribeRunEvents(
        id,
        (event) => {
          state = liveReducer(state, event);
          setLive(state);
          if (event.type === "status" || event.type === "error") {
            stopStream = null;
            void resolveFinalRun(id, state.servedFrom, { signal: ctl.signal }).then(async () => {
              if (ctl.signal.aborted) return;
              streaming = null;
              setLive(null);
              await loadRun(id, "live");
            });
          }
        },
        { signal: ctl.signal },
      );
    };

    const tick = async (): Promise<boolean> => {
      const [p, s, past] = await Promise.all([fetchPlatformStatus(undefined, ctl.signal), fetchSystem(undefined, ctl.signal), fetchPastRuns(30, ctl.signal)]);
      if (ctl.signal.aborted) return false;
      setPlatform({ data: p.status, error: p.error, loading: false });
      publishPlatform(p.status);
      setSystem({ data: s.status, error: s.error, loading: false });
      setRunsError(past.ok ? null : past.detail);
      if (past.ok && !streaming) {
        const running = past.rows.find((r) => r.state === "running");
        const recorded = past.rows.find((r) => r.state !== "running" && (r.lane === "full" || r.lane === null));
        if (running) follow(running.runId);
        else if (recorded && recorded.runId !== shown) await loadRun(recorded.runId, "replay");
      }
      if (!shown && !streaming) setStackRun((cur) => cur ?? sample());
      return Boolean(p.status || s.status);
    };
    const poller = createPoller({
      run: tick,
      baseMs: SYSTEM_POLL_MS,
      isHidden: () => document.visibilityState === "hidden",
      onVisible: (cb) => {
        const on = () => document.visibilityState === "visible" && cb();
        document.addEventListener("visibilitychange", on);
        return () => document.removeEventListener("visibilitychange", on);
      },
      controller: ctl,
    });
    poller.start();
    return () => {
      poller.stop();
      stopStream?.();
    };
  }, []);

  return { platform, system, stackRun, live, runsError };
}
