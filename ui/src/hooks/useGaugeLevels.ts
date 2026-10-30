import { useEffect, useState } from "react";
import { fetchGaugeLevels, type GaugeLoad } from "../api/gauges";
import { isDemo } from "../lib/demo";

/** `fetchedAt` is when the shared request that produced these rows was started (ms). */
export type GaugeState = (GaugeLoad & { fetchedAt?: number; demo?: boolean }) | { state: "loading"; rows: []; detail: string; fetchedAt?: number };

/** PEGELONLINE updates most gauges every 15 minutes; the view's is_stale threshold is 30. */
export const GAUGE_REFRESH_MS = 5 * 60 * 1000;

let shared: { at: number; demo: boolean; request: Promise<GaugeLoad> } | null = null;

/** Shared between widgets for GAUGE_REFRESH_MS. A failed or empty load is not reused. `force` reloads now. */
function load(now: number, force = false): { at: number; demo: boolean; request: Promise<GaugeLoad> } {
  if (force || !shared || shared.demo !== isDemo() || now - shared.at >= GAUGE_REFRESH_MS) {
    const request = fetchGaugeLevels();
    const entry = { at: now, demo: isDemo(), request };
    shared = entry;
    void request.then((result) => {
      if (result.state !== "rows" && shared?.request === request) shared = null;
    });
    return entry;
  }
  return shared;
}

/** `reloadKey` > 0 forces one fresh read each time it changes (the Refresh button). */
export function useGaugeLevels(reloadKey = 0, demo = false): GaugeState {
  const [state, setState] = useState<GaugeState>({ state: "loading", rows: [], detail: "" });
  useEffect(() => {
    let alive = true;
    // Switching between live and demo data never keeps the other source's rows on screen.
    setState((prev) => (prev.state === "rows" && Boolean(prev.demo) !== demo ? { state: "loading", rows: [], detail: "" } : prev));
    const run = (force: boolean) => {
      const entry = load(Date.now(), force);
      void entry.request.then((result) => {
        if (!alive) return;
        // A failed refresh keeps the last good rows on screen.
        setState((prev) => (result.state === "rows" ? { ...result, fetchedAt: entry.at, demo } : prev.state === "rows" ? prev : result));
      });
    };
    run(reloadKey > 0);
    const timer = setInterval(() => run(false), GAUGE_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reloadKey, demo]);
  return state;
}
