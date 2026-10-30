import type { DataOrigin } from "../types/views";
import { normalizeUtcTimestamp } from "./time";

/** One row of the `gauge_levels` view (contracts/views.yaml). Served by Zetaris, never fetched from PEGELONLINE here. */
export interface GaugeLevelRow {
  station: string;
  water: string;
  ts_utc: string;
  level_cm: number;
  source: string;
  /** PEGELONLINE river kilometre; absent on older rows. */
  river_km?: number | null;
  lat: number | null;
  lon: number | null;
  trend_cm_h: number | null;
  mw_cm: number | null;
  mhw_cm: number | null;
  band: GaugeStatus;
  fetched_at: string | null;
  is_stale: boolean;
}

export type GaugeStatus = "ok" | "near" | "over" | "unknown";
export type Trend = "rising" | "steady" | "falling";

export interface GaugeSummary {
  station: string;
  water: string;
  levelCm: number;
  measuredAt: string;
  trend: Trend | null;
  history: number[];
  source: string;
  /** Colour from the view's band (below|near|above|unknown). */
  status: GaugeStatus;
  /** MHW (mean high water) from the view, the warning reference shown on cards. */
  warningLevelCm: number | null;
  meanLevelCm: number | null;
  stale: boolean;
  /** seed when the source is a seed stamp, else live. Fixture/replay never reach this view. */
  origin: DataOrigin;
  lat: number | null;
  lon: number | null;
  /** PEGELONLINE river kilometre of the station, when the view carries it. */
  riverKm?: number | null;
}

/** A row's origin from its source stamp. Anything that names seed, fixture or replay is not live. */
export function gaugeOrigin(source: string): DataOrigin {
  const s = source.toLowerCase();
  if (s.startsWith("fixture")) return "fixture";
  if (!s || s.startsWith("seed") || s.includes("seed") || s.includes("replay")) return "seed";
  return "live";
}

/** Live only when the row is from a live source and the view says it is fresh. */
export function isLiveGauge(g: Pick<GaugeSummary, "origin" | "stale">): boolean {
  return g.origin === "live" && !g.stale;
}

/** Load-level label: Live only if every gauge is live and fresh. */
export function gaugesLabel(gauges: readonly GaugeSummary[]): "Live" | "Stale" | "Seed" | "Fixture" | null {
  if (gauges.length === 0) return null;
  if (gauges.some((g) => g.origin === "fixture")) return "Fixture";
  if (gauges.some((g) => g.origin === "seed")) return "Seed";
  return gauges.every(isLiveGauge) ? "Live" : "Stale";
}

/** Text that Leaflet renders as HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function asGaugeRow(value: unknown): GaugeLevelRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const station = typeof row.station === "string" ? row.station.trim() : "";
  const water = typeof row.water === "string" ? row.water.trim() : "";
  const source = typeof row.source === "string" ? row.source.trim() : "";
  const level = num(row.level_cm);
  const ts = typeof row.ts_utc === "string" ? normalizeUtcTimestamp(row.ts_utc.replace(/\.\d+$/, "")) : null;
  if (!station || level === null || !ts) return null;
  const band = typeof row.band === "string" ? row.band.trim().toLowerCase() : "";
  const fetched = typeof row.fetched_at === "string" ? normalizeUtcTimestamp(row.fetched_at.replace(/\.\d+$/, "")) : null;
  // A missing flag is stale: never call a reading live without the view saying so.
  const stale = !(row.is_stale === false || row.is_stale === "false");
  return {
    station,
    water,
    ts_utc: ts,
    level_cm: level,
    source,
    river_km: num(row.river_km),
    lat: num(row.lat),
    lon: num(row.lon),
    trend_cm_h: num(row.trend_cm_h),
    mw_cm: num(row.mw_cm),
    mhw_cm: num(row.mhw_cm),
    band: BANDS[band] ?? "unknown",
    fetched_at: fetched,
    is_stale: stale,
  };
}

/** The running API may send numbers as strings; coerce both. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const BANDS: Record<string, GaugeStatus> = { below: "ok", near: "near", above: "over", unknown: "unknown" };

function fold(name: string): string {
  return name
    .toUpperCase()
    .replace(/Ä/g, "AE")
    .replace(/Ö/g, "OE")
    .replace(/Ü/g, "UE")
    .replace(/ß/g, "SS")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Approximate positions of Rhine and Ahr gauges, so the map can place a station the view names.
 * Fallback only, for rows without lat/lon. A station with neither is listed but not drawn.
 */
export const STATION_POSITIONS: Record<string, [number, number]> = {
  [fold("Maxau")]: [49.0383, 8.3058],
  [fold("Speyer")]: [49.3238, 8.4489],
  [fold("Mannheim")]: [49.4868, 8.4613],
  [fold("Worms")]: [49.6334, 8.3725],
  [fold("Mainz")]: [50.004, 8.2747],
  [fold("Oestrich")]: [50.0047, 8.0313],
  [fold("Bingen")]: [49.9692, 7.9006],
  [fold("Kaub")]: [50.0853, 7.765],
  [fold("Sankt Goar")]: [50.1525, 7.7146],
  [fold("Koblenz")]: [50.3594, 7.6046],
  [fold("Andernach")]: [50.4399, 7.3912],
  [fold("Oberwinter")]: [50.6152, 7.2117],
  [fold("Bonn")]: [50.7368, 7.1062],
  [fold("Köln")]: [50.9368, 6.9632],
  [fold("Koeln")]: [50.9368, 6.9632],
  [fold("Düsseldorf")]: [51.2257, 6.7703],
  [fold("Ruhrort")]: [51.4554, 6.7289],
  [fold("Duisburg-Ruhrort")]: [51.4554, 6.7289],
  [fold("Wesel")]: [51.6474, 6.6025],
  [fold("Rees")]: [51.7564, 6.3956],
  [fold("Emmerich")]: [51.8296, 6.2453],
  [fold("Altenahr")]: [50.5163, 6.9897],
  [fold("Bad Bodendorf")]: [50.5527, 7.2195],
  [fold("Müsch")]: [50.3865, 6.8285],
};

export function stationPosition(station: string): [number, number] | null {
  return STATION_POSITIONS[fold(station)] ?? null;
}

/** Rhine and Ahr, the area the view covers. */
// The poller covers ten federal waterways (Rhine to Oder), so the map fits Germany.
export const GAUGE_BOUNDS = { south: 47.9, west: 5.9, north: 54.0, east: 14.8 };

const STEADY_CM = 1;

/** Latest reading per station, trend from the previous reading, newest first per station. */
export function summariseGauges(rows: readonly GaugeLevelRow[]): GaugeSummary[] {
  const byStation = new Map<string, GaugeLevelRow[]>();
  for (const row of rows) {
    const key = `${fold(row.station)}|${fold(row.water)}`;
    const list = byStation.get(key);
    if (list) list.push(row);
    else byStation.set(key, [row]);
  }
  const out: GaugeSummary[] = [];
  for (const list of byStation.values()) {
    const sorted = [...list].sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
    const last = sorted[sorted.length - 1];
    const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    let trend: Trend | null = null;
    if (last.trend_cm_h !== null) {
      trend = last.trend_cm_h > 0 ? "rising" : last.trend_cm_h < 0 ? "falling" : "steady";
    } else if (prev) {
      const delta = last.level_cm - prev.level_cm;
      trend = delta > STEADY_CM ? "rising" : delta < -STEADY_CM ? "falling" : "steady";
    }
    const pos = last.lat !== null && last.lon !== null ? ([last.lat, last.lon] as [number, number]) : stationPosition(last.station);
    out.push({
      station: last.station,
      water: last.water,
      levelCm: last.level_cm,
      measuredAt: last.ts_utc,
      trend,
      history: sorted.slice(-48).map((row) => row.level_cm),
      source: last.source,
      status: last.band,
      warningLevelCm: last.mhw_cm,
      meanLevelCm: last.mw_cm,
      stale: last.is_stale,
      origin: gaugeOrigin(last.source),
      lat: pos ? pos[0] : null,
      lon: pos ? pos[1] : null,
      riverKm: last.river_km ?? null,
    });
  }
  return out.sort((a, b) => a.water.localeCompare(b.water) || a.station.localeCompare(b.station));
}
