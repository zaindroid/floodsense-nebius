import { asGaugeRow, type GaugeLevelRow } from "../lib/gauges";
import { parseRows } from "../lib/validate";
import { demoFetch, isDemo } from "../lib/demo";
import { cacheInfoOf, type ViewCacheInfo } from "../lib/staleness";
import { apiBaseUrl, apiTimeoutMs } from "./config";

export const GAUGE_LEVELS_PATH = "/views/gauge_levels";

export interface GaugeLoad {
  rows: GaugeLevelRow[];
  /**
   * "rows" means the API answered with rows that match the view columns. It says nothing about liveness:
   * each row's origin and is_stale decide that (see isLiveGauge).
   */
  state: "rows" | "empty" | "unavailable";
  detail: string;
  /** Zetaris query id and execution time from the view response headers, when the API sends them. */
  queryId?: string | null;
  executedAt?: string | null;
  /** API views cache: miss, hit or stale (last good copy). */
  cache?: ViewCacheInfo;
}

/** Gauge readings through the Zetaris-backed API. The browser never calls PEGELONLINE. */
export async function fetchGaugeLevels(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<GaugeLoad> {
  const base = apiBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs());
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (isDemo() ? (demoFetch as typeof fetch) : fetcher)(`${base}${GAUGE_LEVELS_PATH}`, { credentials: "omit", signal: controller.signal });
    const queryId = response.headers?.get?.("x-query-id") ?? null;
    const executedAt = response.headers?.get?.("x-executed-at") ?? null;
    if (!response.ok) return { rows: [], state: "unavailable", detail: `GET ${GAUGE_LEVELS_PATH} returned ${response.status}`, queryId, executedAt };
    const body: unknown = await response.json();
    const rows = parseRows(body, asGaugeRow);
    if (rows === null) return { rows: [], state: "unavailable", detail: `${GAUGE_LEVELS_PATH} did not match the view columns`, queryId, executedAt };
    if (rows.length === 0) return { rows: [], state: "empty", detail: `GET ${GAUGE_LEVELS_PATH} returned no rows`, queryId, executedAt };
    return { rows, state: "rows", detail: `GET ${base}${GAUGE_LEVELS_PATH}`, queryId, executedAt, cache: cacheInfoOf("gauge_levels", response.headers) };
  } catch {
    return { rows: [], state: "unavailable", detail: `GET ${GAUGE_LEVELS_PATH} failed` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
