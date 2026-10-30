import { asEuWatchRow, type EuWatchRow } from "../lib/euWatch";
import { parseRows } from "../lib/validate";
import { demoFetch, isDemo } from "../lib/demo";
import { cacheInfoOf, type ViewCacheInfo } from "../lib/staleness";
import { apiBaseUrl, apiTimeoutMs } from "./config";

export const EU_WATCH_PATH = "/views/eu_watch";

export interface EuWatchLoad {
  rows: EuWatchRow[];
  state: "loading" | "rows" | "empty" | "unavailable";
  detail: string;
  queryId: string | null;
  executedAt?: string | null;
  /** API views cache: miss, hit or stale (last good copy). */
  cache?: ViewCacheInfo;
}

/** GloFAS model points outside Germany, through the Zetaris-backed API. The browser never calls Open-Meteo. */
export async function fetchEuWatch(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<EuWatchLoad> {
  const base = apiBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs());
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (isDemo() ? (demoFetch as typeof fetch) : fetcher)(`${base}${EU_WATCH_PATH}`, { credentials: "omit", signal: controller.signal });
    const queryId = response.headers?.get?.("x-query-id") ?? null;
    const executedAt = response.headers?.get?.("x-executed-at") ?? null;
    if (!response.ok) return { rows: [], state: "unavailable", detail: `GET ${EU_WATCH_PATH} returned ${response.status}`, queryId };
    const rows = parseRows(await response.json(), asEuWatchRow);
    if (rows === null) return { rows: [], state: "unavailable", detail: `${EU_WATCH_PATH} did not match the view columns`, queryId };
    if (rows.length === 0) return { rows: [], state: "empty", detail: `GET ${EU_WATCH_PATH} returned no rows`, queryId };
    return { rows, state: "rows", detail: `GET ${base}${EU_WATCH_PATH}`, queryId, executedAt, cache: cacheInfoOf("eu_watch", response.headers) };
  } catch {
    return { rows: [], state: "unavailable", detail: `GET ${EU_WATCH_PATH} failed`, queryId: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
