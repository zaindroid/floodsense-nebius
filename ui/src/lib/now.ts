import { normalizeUtcTimestamp } from "./time";

/** One hourly row of `hazard_now`: modelled discharge and rain, past or forecast. */
export interface HazardNowRow {
  point_id: string;
  ts_utc: string;
  t: number;
  rain_mm: number | null;
  discharge_m3s: number | null;
  warning_level: string | null;
  horizon: "past" | "forecast";
}

/** One PEGELONLINE reading from `gauge_levels`. */
export interface GaugeLevelRow {
  station: string;
  water: string | null;
  ts_utc: string | null;
  level_cm: number | null;
  source: string | null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
/** null stays null; a non-number, non-null value is invalid (undefined). */
function optNum(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asHazardNowRow(value: unknown): HazardNowRow | null {
  const row = rec(value);
  if (!row) return null;
  const pointId = str(row.point_id);
  const stamp = str(row.ts_utc);
  const ts = stamp ? normalizeUtcTimestamp(stamp) : null;
  const horizon = row.horizon;
  if (!pointId || !ts || (horizon !== "past" && horizon !== "forecast")) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const rain = optNum(row.rain_mm);
  const discharge = optNum(row.discharge_m3s);
  if (rain === undefined || discharge === undefined) return null;
  const level = row.warning_level;
  if (level !== null && level !== undefined && typeof level !== "string") return null;
  return {
    point_id: pointId,
    ts_utc: ts,
    t,
    rain_mm: rain,
    discharge_m3s: discharge,
    warning_level: typeof level === "string" && level !== "" ? level : null,
    horizon,
  };
}

export function asGaugeLevelRow(value: unknown): GaugeLevelRow | null {
  const row = rec(value);
  if (!row) return null;
  const station = str(row.station);
  const level = optNum(row.level_cm);
  if (!station || level === undefined) return null;
  const stamp = str(row.ts_utc);
  return {
    station,
    water: str(row.water),
    ts_utc: stamp ? normalizeUtcTimestamp(stamp) : null,
    level_cm: level,
    source: str(row.source),
  };
}

/** Bad rows are dropped one by one. A body that is not an array is null. */
export function parseList<T>(body: unknown, parse: (row: unknown) => T | null): { rows: T[]; dropped: number } | null {
  if (!Array.isArray(body)) return null;
  const rows: T[] = [];
  for (const item of body) {
    const row = parse(item);
    if (row) rows.push(row);
  }
  return { rows, dropped: body.length - rows.length };
}

const HOUR = 3_600_000;

export type Trend = "up" | "down" | "flat" | "unknown";

export interface PointNow {
  point_id: string;
  latest: HazardNowRow | null;
  rainLastHour: number | null;
  rain24h: number | null;
  discharge24hAgo: number | null;
  trend: Trend;
  forecastMax: { discharge_m3s: number; ts_utc: string } | null;
  /** Past 72 h up to the latest past row, oldest first. */
  past: HazardNowRow[];
  /** Forecast up to 48 h after the latest past row. */
  forecast: HazardNowRow[];
}

/** Within 2 % (or 0.5 m³/s) counts as flat: modelled values wobble. */
export function trendOf(now: number | null, before: number | null): Trend {
  if (now === null || before === null) return "unknown";
  const tolerance = Math.max(Math.abs(before) * 0.02, 0.5);
  if (now - before > tolerance) return "up";
  if (before - now > tolerance) return "down";
  return "flat";
}

function maxDischarge(rows: HazardNowRow[]): PointNow["forecastMax"] {
  let best: PointNow["forecastMax"] = null;
  for (const row of rows) {
    if (row.discharge_m3s === null) continue;
    if (!best || row.discharge_m3s > best.discharge_m3s) best = { discharge_m3s: row.discharge_m3s, ts_utc: row.ts_utc };
  }
  return best;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function summarisePoint(pointId: string, rows: HazardNowRow[]): PointNow {
  const own = rows.filter((row) => row.point_id === pointId).sort((a, b) => a.t - b.t);
  const pastAll = own.filter((row) => row.horizon === "past");
  const latest = pastAll.length > 0 ? pastAll[pastAll.length - 1] : null;
  if (!latest) {
    const forecast = own.filter((row) => row.horizon === "forecast").slice(0, 48);
    return {
      point_id: pointId,
      latest: null,
      rainLastHour: null,
      rain24h: null,
      discharge24hAgo: null,
      trend: "unknown",
      forecastMax: maxDischarge(forecast),
      past: [],
      forecast,
    };
  }
  const dayStart = latest.t - 24 * HOUR;
  const rains = pastAll
    .filter((row) => row.t > dayStart)
    .map((row) => row.rain_mm)
    .filter((v): v is number => v !== null);
  const ago = pastAll.find((row) => row.t === dayStart) ?? null;
  const before = ago?.discharge_m3s ?? null;
  const forecast = own.filter((row) => row.horizon === "forecast" && row.t > latest.t && row.t <= latest.t + 48 * HOUR);
  return {
    point_id: pointId,
    latest,
    rainLastHour: latest.rain_mm,
    rain24h: rains.length > 0 ? round1(rains.reduce((a, b) => a + b, 0)) : null,
    discharge24hAgo: before,
    trend: trendOf(latest.discharge_m3s, before),
    forecastMax: maxDischarge(forecast),
    past: pastAll.filter((row) => row.t > latest.t - 72 * HOUR),
    forecast,
  };
}

/** One summary per point id, sorted by id. */
export function summariseAll(rows: HazardNowRow[]): PointNow[] {
  const ids = [...new Set(rows.map((row) => row.point_id))].sort();
  return ids.map((id) => summarisePoint(id, rows));
}

/** Newest past row across all points: what "right now" means on the page. */
export function latestPastStamp(rows: HazardNowRow[]): string | null {
  let best: HazardNowRow | null = null;
  for (const row of rows) if (row.horizon === "past" && (!best || row.t > best.t)) best = row;
  return best?.ts_utc ?? null;
}

/** Sparkline values with null discharge dropped (never drawn as 0); split is the last past index. */
export function sparkSeries(summary: PointNow): { values: number[]; split: number | undefined } {
  const past = summary.past.map((row) => row.discharge_m3s).filter((v): v is number => v !== null);
  const forecast = summary.forecast.map((row) => row.discharge_m3s).filter((v): v is number => v !== null);
  return {
    values: [...past, ...forecast],
    split: past.length > 0 && forecast.length > 0 ? past.length - 1 : undefined,
  };
}

export function relativeTime(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, (nowMs - fromMs) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 59.5 * 60) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  const minutes = seconds / 60;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
