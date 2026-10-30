import { apiBaseUrl, apiTimeoutMs } from "./config";

/** GET /runs/{id}/replay as the raw body: the stack page also reads usage, evidence and memory_used. Null on any failure. */
export async function fetchReplayBody(runId: string, signal?: AbortSignal, base = apiBaseUrl()): Promise<unknown | null> {
  try {
    const timeout = AbortSignal.timeout(Math.max(apiTimeoutMs(), 5000));
    const r = await fetch(`${base}/runs/${encodeURIComponent(runId)}/replay`, {
      credentials: "omit",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
