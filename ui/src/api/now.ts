import { asGaugeLevelRow, asHazardNowRow, parseList, type GaugeLevelRow, type HazardNowRow } from "../lib/now";
import { demoFetch, isDemo } from "../lib/demo";
import { cacheInfoOf, type ViewCacheInfo } from "../lib/staleness";
import { apiBaseUrl, apiTimeoutMs } from "./config";

export interface HazardNowResult {
  rows: HazardNowRow[];
  dropped: number;
  queryId: string | null;
  executedAt: string | null;
  truncated: boolean;
  cache?: ViewCacheInfo;
}

/** Caller's signal (unmount, refresh) plus the configured timeout. */
function signalFor(signal: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(apiTimeoutMs());
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs());
  const stop = () => {
    clearTimeout(timer);
    ctrl.abort();
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return ctrl.signal;
}

async function getJson(path: string, signal: AbortSignal): Promise<{ body: unknown; headers: Headers }> {
  const response = await (isDemo() ? demoFetch : fetch)(`${apiBaseUrl()}${path}`, { credentials: "omit", signal: signalFor(signal) });
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return { body: await response.json(), headers: response.headers };
}

/** Live `hazard_now` from Zetaris. Throws on any failure: there is no fixture fallback for "now". */
export async function fetchHazardNow(signal: AbortSignal): Promise<HazardNowResult> {
  const { body, headers } = await getJson("/views/hazard_now", signal);
  const parsed = parseList(body, asHazardNowRow);
  if (!parsed) throw new Error("GET /views/hazard_now did not return a list");
  const serverDropped = Number(headers.get("x-dropped-rows") ?? "0");
  return {
    rows: parsed.rows,
    dropped: parsed.dropped + (Number.isFinite(serverDropped) ? serverDropped : 0),
    queryId: headers.get("x-query-id"),
    executedAt: headers.get("x-executed-at"),
    truncated: headers.get("x-truncated") === "true",
    cache: cacheInfoOf("hazard_now", headers),
  };
}

export async function fetchGaugeLevels(signal: AbortSignal): Promise<GaugeLevelRow[]> {
  const { body } = await getJson("/views/gauge_levels", signal);
  const parsed = parseList(body, asGaugeLevelRow);
  if (!parsed) throw new Error("GET /views/gauge_levels did not return a list");
  return parsed.rows;
}
