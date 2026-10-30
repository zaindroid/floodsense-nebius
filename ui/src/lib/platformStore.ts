import { fetchPlatformStatus, type PlatformStatus } from "../api/platform";
import { setLanePricing, setLlmBackend } from "./lanes";

/** One shared /platform/status snapshot. The Stack page poll (useStackData) publishes into it, so the header strip does not fetch again while that poll runs. */
let snap: { status: PlatformStatus | null; at: number } = { status: null, at: 0 };
const subs = new Set<() => void>();

export function publishPlatform(status: PlatformStatus | null, now = Date.now()): void {
  snap = { status, at: now };
  if (status?.llmBackend) setLlmBackend(status.llmBackend);
  setLanePricing(status?.llmUsage?.pricing);
  subs.forEach((s) => s());
}
export const getPlatformSnap = () => snap;
export const getPlatformStatus = (): PlatformStatus | null => snap.status;
export function subscribePlatform(cb: () => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}
export const resetPlatform = (): void => {
  snap = { status: null, at: 0 };
};

type Fetcher = (base?: string, signal?: AbortSignal) => Promise<{ status: PlatformStatus | null }>;

/**
 * Keeps the snapshot fresh: fetches only when it is older than `ms`, never two at once, aborts on stop,
 * and refreshes when the tab becomes visible. Returns the stop function.
 */
export function startPlatformPoll(fetcher: Fetcher = fetchPlatformStatus, ms = 30_000): () => void {
  const ctl = new AbortController();
  let busy = false;
  const tick = () => {
    if (busy || ctl.signal.aborted || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    if (Date.now() - snap.at < ms - 1000) return;
    busy = true;
    void fetcher(undefined, ctl.signal)
      .then((r) => !ctl.signal.aborted && publishPlatform(r.status))
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const t = setInterval(tick, ms);
  const onVis = () => document.visibilityState === "visible" && tick();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  return () => {
    ctl.abort();
    clearInterval(t);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
  };
}
