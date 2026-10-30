import { VIEW_PATHS, type ViewName } from "../config/scenario";
import type {
  DischargeDailyRow,
  ExposureJoinRow,
  HazardTimelineRow,
  ProvenanceRow,
} from "../types/views";
import { asDischargeRow, asExposureRow, asHazardRow, asProvenanceRow, parseRows } from "../lib/validate";
import { apiBaseUrl, apiTimeoutMs } from "./config";

export type { ViewName };

export interface HealthProbe {
  ok: boolean;
  detail: string;
}

export interface LiveViews {
  health: HealthProbe;
  discharge_daily: DischargeDailyRow[] | null;
  hazard_timeline: HazardTimelineRow[] | null;
  exposure_join: ExposureJoinRow[] | null;
  provenance: ProvenanceRow[] | null;
  details: Record<ViewName, string>;
}

async function fetchHealth(base: string): Promise<HealthProbe> {
  try {
    const response = await fetch(`${base}/health`, {
      credentials: "omit",
      signal: AbortSignal.timeout(apiTimeoutMs()),
    });
    if (!response.ok) {
      return { ok: false, detail: `GET /health returned ${response.status}` };
    }
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "status" in body && body.status === "ok") {
      return { ok: true, detail: `GET ${base}/health ok` };
    }
    return { ok: false, detail: "GET /health did not return status ok" };
  } catch {
    return { ok: false, detail: `API not reached at ${base}/health` };
  }
}

async function fetchJson(base: string, name: ViewName): Promise<{ body: unknown; detail: string; ok: boolean }> {
  const path = VIEW_PATHS[name];
  try {
    const response = await fetch(`${base}${path}`, {
      credentials: "omit",
      signal: AbortSignal.timeout(apiTimeoutMs()),
    });
    if (!response.ok) {
      return { body: null, ok: false, detail: `GET ${path} returned ${response.status}` };
    }
    return { body: await response.json(), ok: true, detail: `GET ${base}${path}` };
  } catch {
    return { body: null, ok: false, detail: `GET ${path} failed` };
  }
}

function rowsOrNull<T>(ok: boolean, body: unknown, parse: (row: unknown) => T | null, detail: string, pathDetail: string): {
  rows: T[] | null;
  detail: string;
} {
  if (!ok) return { rows: null, detail };
  const rows = parseRows(body, parse);
  if (rows === null) return { rows: null, detail: `${pathDetail} did not match the view columns` };
  return { rows, detail };
}

async function probeLiveViews(): Promise<LiveViews> {
  const base = apiBaseUrl();
  const health = await fetchHealth(base);
  const empty: LiveViews = {
    health,
    discharge_daily: null,
    hazard_timeline: null,
    exposure_join: null,
    provenance: null,
    details: {
      discharge_daily: "fixture",
      hazard_timeline: "fixture",
      exposure_join: "fixture",
      provenance: "fixture",
    },
  };
  if (!health.ok) return empty;

  const names = Object.keys(VIEW_PATHS) as ViewName[];
  const loaded = await Promise.all(names.map(async (name) => ({ name, ...(await fetchJson(base, name)) })));
  for (const item of loaded) {
    if (item.name === "discharge_daily") {
      const parsed = rowsOrNull(item.ok, item.body, asDischargeRow, item.detail, VIEW_PATHS.discharge_daily);
      empty.discharge_daily = parsed.rows;
      empty.details.discharge_daily = parsed.detail;
    } else if (item.name === "hazard_timeline") {
      const parsed = rowsOrNull(item.ok, item.body, asHazardRow, item.detail, VIEW_PATHS.hazard_timeline);
      empty.hazard_timeline = parsed.rows;
      empty.details.hazard_timeline = parsed.detail;
    } else if (item.name === "exposure_join") {
      const parsed = rowsOrNull(item.ok, item.body, asExposureRow, item.detail, VIEW_PATHS.exposure_join);
      empty.exposure_join = parsed.rows;
      empty.details.exposure_join = parsed.detail;
    } else {
      const parsed = rowsOrNull(item.ok, item.body, asProvenanceRow, item.detail, VIEW_PATHS.provenance);
      empty.provenance = parsed.rows;
      empty.details.provenance = parsed.detail;
    }
  }
  return empty;
}

let liveViewsRequest: Promise<LiveViews> | null = null;

/** One probe per page load, so React strict mode does not hit /health twice. */
export function loadLiveViews(): Promise<LiveViews> {
  if (!liveViewsRequest) {
    liveViewsRequest = probeLiveViews().catch((error: unknown) => {
      liveViewsRequest = null;
      throw error;
    });
  }
  return liveViewsRequest;
}
