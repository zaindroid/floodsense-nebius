import { adoptPastRuns, type QueueRow } from "../lib/approvalQueue";
import { apiBaseUrl, apiTimeoutMs } from "./config";

export type PastRunsLoad = { ok: true; rows: QueueRow[] } | { ok: false; detail: string };

/** GET /runs/past, newest first (the agents sort by updated_at). Any failure is reported, never filled in. */
export async function fetchPastRuns(limit = 50, signal?: AbortSignal, base = apiBaseUrl()): Promise<PastRunsLoad> {
  const timeout = AbortSignal.timeout(Math.max(apiTimeoutMs(), 4000));
  try {
    const response = await fetch(`${base}/runs/past?limit=${limit}`, {
      credentials: "omit",
      signal: signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return { ok: false, detail: `GET /runs/past returned ${response.status}` };
    return { ok: true, rows: adoptPastRuns(await response.json()) };
  } catch {
    return { ok: false, detail: "GET /runs/past could not be reached" };
  }
}
