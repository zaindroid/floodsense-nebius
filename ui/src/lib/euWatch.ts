import type { GaugeStatus, GaugeSummary } from "./gauges";

/** One row of the `eu_watch` view (contracts/views.yaml): a GloFAS model point outside Germany. */
export interface EuWatchRow {
  point_id: string;
  name: string;
  country: string;
  river: string;
  lat: number;
  lon: number;
  discharge_m3s: number | null;
  forecast_max_m3s: number | null;
  past30_median_m3s: number | null;
  band: GaugeStatus;
  basis: string;
  source: string;
  as_of_date: string | null;
}

/** View band words -> the shared marker colours. */
const BAND: Record<string, GaugeStatus> = { below: "ok", near: "near", above: "over", unknown: "unknown" };

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asEuWatchRow(value: unknown): EuWatchRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const pointId = text(row.point_id);
  const lat = num(row.lat);
  const lon = num(row.lon);
  if (!pointId || lat === null || lon === null) return null;
  return {
    point_id: pointId,
    name: text(row.name) || pointId,
    country: text(row.country),
    river: text(row.river),
    lat,
    lon,
    discharge_m3s: num(row.discharge_m3s),
    forecast_max_m3s: num(row.forecast_max_m3s),
    past30_median_m3s: num(row.past30_median_m3s),
    band: BAND[text(row.band).toLowerCase()] ?? "unknown",
    basis: text(row.basis),
    source: text(row.source),
    as_of_date: text(row.as_of_date) || null,
  };
}

/** River names a person reads. PEGELONLINE waters are upper-case German shortnames. */
const WATER_NAME: Record<string, string> = {
  RHEIN: "Rhine",
  MOSEL: "Mosel",
  SAAR: "Saar",
  MAIN: "Main",
  NECKAR: "Neckar",
  ELBE: "Elbe",
  DONAU: "Danube",
  ODER: "Oder",
  WESER: "Weser",
  EMS: "Ems",
};

export function riverName(water: string): string {
  return WATER_NAME[water.toUpperCase()] ?? water;
}

/** Title case for a PEGELONLINE shortname ("FRANKFURT1 (ODER)" -> "Frankfurt1 (Oder)"). */
export function stationName(station: string): string {
  return station.toLowerCase().replace(/(^|[\s(.-])(\p{L})/gu, (_, pre: string, c: string) => pre + c.toUpperCase());
}

/** gauge: PEGELONLINE vs MHW; model: eu_watch GloFAS band; valencia: hazard_now GloFAS vs the point's own recent flow. */
export type SourceKind = "gauge" | "model" | "valencia";

/** One marker / list row: a PEGELONLINE gauge or a GloFAS point. */
export interface WatchSource {
  id: string;
  kind: SourceKind;
  name: string;
  river: string;
  country: string;
  lat: number;
  lon: number;
  status: GaugeStatus;
  /** Ratio used for sorting: level / MHW for a gauge, forecast max / past-30-day median for a model point. */
  ratio: number | null;
  value: string;
  live: boolean;
  question: string;
  /** Measured time (gauge), model day (eu_watch) or latest model hour (Valencia). */
  measuredAt: string | null;
  /** PEGELONLINE river kilometre (gauges only), so the operator desk can order a river's gauges. */
  riverKm?: number | null;
}

const STATUS_RANK: Record<GaugeStatus, number> = { over: 0, near: 1, ok: 2, unknown: 3 };

export function questionFor(river: string, place: string): string {
  return `Is the ${river} at ${place} at risk right now?`;
}

export function fromGauge(g: GaugeSummary): WatchSource | null {
  if (g.lat === null || g.lon === null) return null;
  const river = riverName(g.water);
  const name = stationName(g.station);
  return {
    id: `gauge:${g.station}`,
    kind: "gauge",
    name,
    river,
    country: "DE",
    lat: g.lat,
    lon: g.lon,
    status: g.status,
    ratio: g.warningLevelCm ? g.levelCm / g.warningLevelCm : null,
    value: `${Math.round(g.levelCm)} cm${g.warningLevelCm ? ` · MHW ${Math.round(g.warningLevelCm)} cm` : ""}`,
    live: g.origin === "live" && !g.stale,
    question: questionFor(river, name),
    measuredAt: g.measuredAt,
    riverKm: g.riverKm ?? null,
  };
}

export function fromModel(r: EuWatchRow): WatchSource {
  const ratio =
    r.forecast_max_m3s !== null && r.past30_median_m3s !== null && r.past30_median_m3s > 0
      ? r.forecast_max_m3s / r.past30_median_m3s
      : null;
  return {
    id: `model:${r.point_id}`,
    kind: "model",
    name: r.name,
    river: r.river,
    country: r.country,
    lat: r.lat,
    lon: r.lon,
    status: r.band,
    ratio,
    value:
      r.forecast_max_m3s === null
        ? "no model reading"
        : `7-day max ${Math.round(r.forecast_max_m3s)} m³/s${ratio === null ? "" : ` · ${ratio.toFixed(1)}× 30-day median`}`,
    live: r.forecast_max_m3s !== null && !r.source.toLowerCase().includes("seed"),
    question: questionFor(r.river, r.name),
    measuredAt: r.as_of_date,
  };
}

/**
 * Pure: the Valencia cuts for one point, relative to the point's own recent flow so a point whose base flow is high
 * (about 30 m³/s at most of the eight) is not permanently raised: watch at 2x, over at 4x the median of its past
 * rows, with the median floored at 5 m³/s so a near-dry point does not trip on noise.
 */
export function valenciaCuts(past: readonly { discharge_m3s: number | null }[]): { watch: number; warning: number } {
  const v = past.map((r) => r.discharge_m3s).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const median = v.length === 0 ? 0 : v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const base = Math.max(median, 5);
  return { watch: base * 2, warning: base * 4 };
}

/** Valencia model point from hazard_now: the higher of now and the 48 h forecast max, against its own cuts (`valenciaCuts`). */
export function fromValencia(
  point: { point_id: string; name: string; lat: number; lon: number },
  now: { latest: { discharge_m3s: number | null; ts_utc: string } | null; forecastMax: { discharge_m3s: number } | null },
  cuts: { watch: number; warning: number },
): WatchSource {
  const values = [now.latest?.discharge_m3s ?? null, now.forecastMax?.discharge_m3s ?? null].filter(
    (v): v is number => v !== null,
  );
  const top = values.length ? Math.max(...values) : null;
  const status: GaugeStatus = top === null ? "unknown" : top >= cuts.warning ? "over" : top >= cuts.watch ? "near" : "ok";
  return {
    id: `valencia:${point.point_id}`,
    kind: "valencia",
    name: point.name,
    river: "",
    country: "ES",
    lat: point.lat,
    lon: point.lon,
    status,
    ratio: top === null ? null : top / cuts.warning,
    value: top === null ? "no model reading" : `up to ${top.toFixed(1)} m³/s (now and next 48 h)`,
    live: top !== null,
    question: `Is ${point.name} at risk in the next 48 hours?`,
    measuredAt: now.latest?.ts_utc ?? null,
  };
}

export function buildSources(gauges: readonly GaugeSummary[], points: readonly EuWatchRow[]): WatchSource[] {
  const out: WatchSource[] = [];
  for (const g of gauges) {
    const s = fromGauge(g);
    if (s) out.push(s);
  }
  for (const p of points) out.push(fromModel(p));
  return out;
}

export type SortKey = "status" | "river" | "name" | "country";

/** Pure sort. status: raised first, then by ratio (highest first); others alphabetical. */
export function sortSources(list: readonly WatchSource[], key: SortKey): WatchSource[] {
  const by = (s: WatchSource) => (key === "river" ? s.river : key === "country" ? s.country : s.name);
  return [...list].sort((a, b) => {
    if (key === "status") {
      const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (r) return r;
      return (b.ratio ?? -1) - (a.ratio ?? -1) || a.name.localeCompare(b.name);
    }
    return by(a).localeCompare(by(b)) || a.name.localeCompare(b.name);
  });
}

export const EU_WATCH_BOUNDS = { south: 36.5, west: -7.0, north: 54.5, east: 21.5 };
