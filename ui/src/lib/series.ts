import type {
  DataOrigin,
  DischargeDailyRow,
  ExposureJoinRow,
  HazardTimelineRow,
  ProvenanceRow,
  ValenciaPoint,
} from "../types/views";
import {
  BAND_ELEVATED_M3S,
  BAND_TYPICAL_M3S,
  MAP_BOUNDS,
  SIMULATED_ALERT_M3S,
} from "../config/scenario";
import type { DischargeBand } from "../types/ui";

export { MAP_BOUNDS };

export function mapAspectRatio(): string {
  const midLat = ((MAP_BOUNDS.minLat + MAP_BOUNDS.maxLat) / 2) * (Math.PI / 180);
  const lonKm = (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon) * 111 * Math.cos(midLat);
  const latKm = (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat) * 111;
  return `${lonKm} / ${latKm}`;
}

export function project(lat: number, lon: number): { x: number; y: number } {
  const x = ((lon - MAP_BOUNDS.minLon) / (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon)) * 100;
  const y = ((MAP_BOUNDS.maxLat - lat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * 100;
  return { x, y };
}

export function insideMap(point: { x: number; y: number }): boolean {
  return point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
}

export function datesOf(rows: DischargeDailyRow[]): string[] {
  return [...new Set(rows.map((row) => row.date))].sort();
}

export function seriesFor(rows: DischargeDailyRow[], pointId: string): DischargeDailyRow[] {
  return rows.filter((row) => row.point_id === pointId).sort((a, b) => a.date.localeCompare(b.date));
}

export function rowAt(
  rows: DischargeDailyRow[],
  pointId: string,
  date: string,
): DischargeDailyRow | undefined {
  return rows.find((row) => row.point_id === pointId && row.date === date);
}

export function rowsOnDate(rows: DischargeDailyRow[], date: string): DischargeDailyRow[] {
  return rows.filter((row) => row.date === date);
}

export function dischargeBand(m3s: number): DischargeBand {
  if (m3s >= SIMULATED_ALERT_M3S) return "peak";
  if (m3s >= BAND_ELEVATED_M3S) return "elevated";
  if (m3s >= BAND_TYPICAL_M3S) return "typical";
  return "low";
}

export function peakRow(series: DischargeDailyRow[]): DischargeDailyRow | null {
  return series.reduce<DischargeDailyRow | null>(
    (best, row) => (!best || row.discharge_m3s > best.discharge_m3s ? row : best),
    null,
  );
}

export function sameDischargePoints(
  rows: DischargeDailyRow[],
  pointId: string,
  date: string,
): string[] {
  const row = rowAt(rows, pointId, date);
  if (!row) return [];
  return rows
    .filter(
      (other) =>
        other.date === date &&
        other.point_id !== pointId &&
        other.discharge_m3s === row.discharge_m3s,
    )
    .map((other) => other.point_id)
    .sort();
}

export function hazardOnDate(rows: HazardTimelineRow[], pointId: string, date: string): HazardTimelineRow[] {
  return rows
    .filter((row) => row.point_id === pointId && row.ts_utc.startsWith(date))
    .sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
}

export function rainSummary(rows: HazardTimelineRow[]): {
  hours: number;
  sum: number;
  peak: HazardTimelineRow | null;
} {
  if (rows.length === 0) return { hours: 0, sum: 0, peak: null };
  const peak = rows.reduce((best, row) => (row.rain_mm > best.rain_mm ? row : best));
  const sum = rows.reduce((total, row) => total + row.rain_mm, 0);
  return { hours: rows.length, sum, peak };
}

export function pointsCrossing(
  rows: DischargeDailyRow[],
  fromDate: string,
  toDate: string,
  threshold: number,
): string[] {
  const previous = new Map(
    rows.filter((row) => row.date === fromDate).map((row) => [row.point_id, row.discharge_m3s]),
  );
  return rows
    .filter((row) => {
      if (row.date !== toDate || row.discharge_m3s < threshold) return false;
      return (previous.get(row.point_id) ?? 0) < threshold;
    })
    .map((row) => row.point_id)
    .sort();
}

/** Source stamp, without a seed: prefix, mapped to a stable fragment of dataset. */
const SOURCE_DATASET_KEY: Record<string, string> = {
  "open-meteo-flood-glofas": "open-meteo flood",
  "open-meteo-rain": "historical weather",
};

export function sourceStamp(source: string): string {
  const value = source.trim().toLowerCase();
  return value.startsWith("seed:") ? value.slice("seed:".length) : value;
}

export function provenanceForSource(
  source: string,
  rows: ProvenanceRow[],
): ProvenanceRow | undefined {
  const key = SOURCE_DATASET_KEY[sourceStamp(source)];
  if (!key) return undefined;
  return rows.find((row) => row.dataset.toLowerCase().includes(key));
}

export function isModelledGlofasSource(source: string): boolean {
  return sourceStamp(source) === "open-meteo-flood-glofas";
}

/** GloFAS wording only when the source stamp is that series. Other sources stay quiet. */
export function glofasDischargeNote(source: string): string | null {
  if (!isModelledGlofasSource(source)) return null;
  return "Values are modelled GloFAS discharge, not observed gauge readings.";
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function exposureStats(rows: ExposureJoinRow[]): {
  policies: number;
  inFootprint: number;
  sumInsured: number;
  segments: { segment: string; count: number; sum: number }[];
} {
  const inside = rows.filter((row) => row.in_footprint);
  const bySegment = new Map<string, { count: number; sum: number }>();
  for (const row of inside) {
    const current = bySegment.get(row.segment) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += row.sum_insured_eur;
    bySegment.set(row.segment, current);
  }
  return {
    policies: rows.length,
    inFootprint: inside.length,
    sumInsured: inside.reduce((total, row) => total + row.sum_insured_eur, 0),
    segments: [...bySegment.entries()]
      .map(([segment, stats]) => ({ segment, count: stats.count, sum: stats.sum }))
      .sort((a, b) => b.sum - a.sum),
  };
}

export function nearbyExposure(
  rows: ExposureJoinRow[],
  point: ValenciaPoint,
  km: number,
): ExposureJoinRow[] {
  return rows.filter(
    (row) => row.in_footprint && haversineKm(point.lat, point.lon, row.lat, row.lon) <= km,
  );
}

export function pointById(points: ValenciaPoint[], pointId: string): ValenciaPoint | undefined {
  return points.find((point) => point.point_id === pointId);
}

export function markerText(pointId: string): string {
  const stripped = pointId.replace(/^VAL/, "");
  return stripped.length > 0 && stripped.length <= 3 ? stripped : pointId.slice(0, 3);
}

export function sourceExplanation(source: string, origin?: DataOrigin): string {
  if (source.startsWith("seed:")) {
    if (origin === "seed") {
      return `The source column is "${source}". These rows are seed.`;
    }
    return `The source column is "${source}". That is a seed stamp in the source column.`;
  }
  if (source === "open-meteo-flood-glofas") {
    return `The source column is "${source}", the Open-Meteo Flood (GloFAS) stamp on discharge_daily.`;
  }
  return `The source column is "${source}".`;
}

export function prefersGlofasGridNote(source: string): boolean {
  return sourceStamp(source) === "open-meteo-flood-glofas";
}
