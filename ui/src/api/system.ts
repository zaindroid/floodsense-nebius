import { parseSystem, type SystemStatus } from "../lib/system";
import { apiBaseUrl, apiTimeoutMs } from "./config";

export type SystemFetch = { status: SystemStatus | null; error: string | null; aborted?: boolean };

/**
 * GET /system once. A failure is an error string, never a throw.
 * `signal` cancels the request (the page unmounted); the probe timeout still applies.
 */
export async function fetchSystem(base = apiBaseUrl(), signal?: AbortSignal): Promise<SystemFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs());
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(`${base}/system`, {
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return { status: null, error: `GET /system returned ${response.status}` };
    const status = parseSystem(await response.json());
    return status ? { status, error: null } : { status: null, error: "GET /system did not return an object" };
  } catch {
    if (signal?.aborted) return { status: null, error: null, aborted: true };
    return { status: null, error: `API not reached at ${base}/system` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
