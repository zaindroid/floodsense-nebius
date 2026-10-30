import type { WatchSource } from "../lib/euWatch";
import { forecastBriefFrom, forecastLaneEnabled, forecastQuestion, operatorContext, outlookBlocked, type ForecastBrief } from "../lib/operatorDesk";
import { fetchAgentsConfig } from "./config";
import type { RecordedRun } from "./replay";
import { fetchRunSnapshot, startLiveRun } from "./liveRun";

export type ForecastLoad =
  | { state: "ready"; brief: ForecastBrief; run: RecordedRun; at: number }
  | { state: "unavailable"; message: string };

const POLL_MS = 1000;
const GIVE_UP_MS = 45_000;

/**
 * The next-48 h outlook for one place from the forecast lane, through the same live-run client the Ask chat uses
 * (POST /runs?wait=false, then GET /runs/{id}). The lane is deterministic (weather rows, gauge, history, template
 * claims, no model call) and takes about 1-2 s. A run that is not a finished forecast-lane answer is reported as
 * unavailable, never repainted as one.
 */
export async function loadForecast(source: WatchSource, signal?: AbortSignal): Promise<ForecastLoad> {
  // Never post a run unless the lane is known to be deterministic for this place: a place the router might send
  // to the full lane would cost a multi-minute, multi-model run on every selection.
  const blocked = outlookBlocked(source);
  if (blocked) return { state: "unavailable", message: `Outlook not available: ${blocked}.` };
  const config = await fetchAgentsConfig(signal);
  if (config.kind !== "ok") return { state: "unavailable", message: "Outlook not available: the agents' /config did not answer, so the forecast lane cannot be confirmed." };
  if (!forecastLaneEnabled(config.body)) {
    return { state: "unavailable", message: "Outlook not available: the forecast lane or live data is switched off on this deployment." };
  }
  const start = await startLiveRun(
    { question: forecastQuestion(source), context: operatorContext(source) },
    signal,
  );
  if (start.kind === "aborted") return { state: "unavailable", message: "Cancelled." };
  if (start.kind === "error") return { state: "unavailable", message: start.message };
  if (start.kind === "rate_limited") {
    return { state: "unavailable", message: `${start.message}${start.retryAfterS ? ` Try again in ${start.retryAfterS} s.` : ""}` };
  }
  if (start.kind === "reply") return { state: "unavailable", message: "The front door answered with text instead of an outlook." };
  const runId = start.kind === "started" ? start.runId : start.run.runId;
  const began = Date.now();
  for (;;) {
    let snap: Awaited<ReturnType<typeof fetchRunSnapshot>>;
    try {
      snap = await fetchRunSnapshot(runId, signal);
    } catch {
      if (signal?.aborted) return { state: "unavailable", message: "Cancelled." };
      return { state: "unavailable", message: `Could not read run ${runId}.` };
    }
    const status = typeof snap.body?.status === "string" ? snap.body.status : "running";
    if (status !== "running") {
      const brief = forecastBriefFrom(snap.body, runId);
      if (brief && snap.run) return { state: "ready", brief, run: snap.run, at: Date.now() };
      const lane = typeof snap.body?.lane === "string" ? snap.body.lane : "unknown";
      return {
        state: "unavailable",
        message: `Run ${runId} ended as "${status}" on the ${lane} lane, not as a forecast answer for this place. Nothing is shown in its place.`,
      };
    }
    if (Date.now() - began > GIVE_UP_MS) return { state: "unavailable", message: `Run ${runId} is taking longer than expected.` };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (signal?.aborted) return { state: "unavailable", message: "Cancelled." };
  }
}
