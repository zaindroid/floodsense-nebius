import type { Answer } from "../types/contract";
import type {
  DischargeDailyRow,
  ExposureJoinRow,
  HazardTimelineRow,
  ProvenanceRow,
  ValenciaPoint,
} from "../types/views";
import { normalizeUtcTimestamp } from "./time";
import { isSafeHttpUrl } from "./urls";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

export function asDischargeRow(value: unknown): DischargeDailyRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const pointId = asNonEmpty(row.point_id);
  const date = asDate(row.date);
  const discharge = asFinite(row.discharge_m3s);
  const source = asNonEmpty(row.source);
  if (!pointId || !date || discharge === null || !source) return null;
  return { point_id: pointId, date, discharge_m3s: discharge, source };
}

export function asHazardRow(value: unknown): HazardTimelineRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const pointId = asNonEmpty(row.point_id);
  const stamp = asNonEmpty(row.ts_utc);
  const rain = asFinite(row.rain_mm);
  if (!pointId || !stamp || rain === null) return null;
  const ts = normalizeUtcTimestamp(stamp);
  if (!ts) return null;
  let discharge: number | null;
  if (!("discharge_m3s" in row) || row.discharge_m3s === null) {
    discharge = null;
  } else {
    const parsed = asFinite(row.discharge_m3s);
    if (parsed === null) return null;
    discharge = parsed;
  }
  const level = "warning_level" in row ? row.warning_level : null;
  if (level !== null && typeof level !== "string") return null;
  return {
    point_id: pointId,
    ts_utc: ts,
    rain_mm: rain,
    discharge_m3s: discharge,
    warning_level: level === "" ? null : level,
  };
}

export function asExposureRow(value: unknown): ExposureJoinRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const policyId = asNonEmpty(row.policy_id);
  const siteId = asNonEmpty(row.site_id);
  const lat = asFinite(row.lat);
  const lon = asFinite(row.lon);
  const sum = asFinite(row.sum_insured_eur);
  const segment = asNonEmpty(row.segment);
  if (!policyId || !siteId || lat === null || lon === null || sum === null || !segment) return null;
  if (typeof row.in_footprint !== "boolean") return null;
  const synthetic = typeof row.synthetic === "string" && row.synthetic.length > 0 ? row.synthetic : undefined;
  return {
    policy_id: policyId,
    site_id: siteId,
    lat,
    lon,
    in_footprint: row.in_footprint,
    sum_insured_eur: sum,
    segment,
    ...(synthetic ? { synthetic } : {}),
  };
}

export function asProvenanceRow(value: unknown): ProvenanceRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const dataset = asNonEmpty(row.dataset);
  const sourceUrl = asNonEmpty(row.source_url);
  const publisher = asNonEmpty(row.publisher);
  const licence = asNonEmpty(row.licence);
  const attribution = asNonEmpty(row.attribution);
  const fetchedAt = asNonEmpty(row.fetched_at);
  if (!dataset || !sourceUrl || !publisher || !licence || !attribution || !fetchedAt) return null;
  if (!isSafeHttpUrl(sourceUrl)) return null;
  return {
    dataset,
    source_url: sourceUrl,
    publisher,
    licence,
    attribution,
    fetched_at: fetchedAt,
  };
}

export function asValenciaPoint(value: unknown): ValenciaPoint | null {
  const row = asRecord(value);
  if (!row) return null;
  const pointId = asNonEmpty(row.point_id);
  const name = asNonEmpty(row.name);
  const municipality = asNonEmpty(row.municipality);
  const lat = asFinite(row.lat);
  const lon = asFinite(row.lon);
  const why = asNonEmpty(row.why);
  const verified = asNonEmpty(row.verified_against_footprint);
  const inFlood = asNonEmpty(row.in_flood);
  const dist = asFinite(row.dist_m_to_flood);
  if (!pointId || !name || !municipality || lat === null || lon === null || !why || !verified || !inFlood) {
    return null;
  }
  if (dist === null) return null;
  return {
    point_id: pointId,
    name,
    municipality,
    lat,
    lon,
    why,
    verified_against_footprint: verified,
    in_flood: inFlood,
    dist_m_to_flood: dist,
  };
}

export function parseRows<T>(value: unknown, parse: (row: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const rows: T[] = [];
  for (const item of value) {
    const row = parse(item);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

export function assertAnswer(value: unknown): Answer {
  const row = asRecord(value);
  if (!row) throw new Error("Answer fixture is not an object.");
  const served = row.served_from;
  if (served !== "live" && served !== "cache" && served !== "replay") {
    throw new Error("Answer fixture served_from is invalid.");
  }
  if (typeof row.run_id !== "string" || row.run_id.length === 0) {
    throw new Error("Answer fixture is missing run_id.");
  }
  if (!Array.isArray(row.claims) || row.claims.length === 0) {
    throw new Error("Answer fixture is missing claims.");
  }
  if (!Array.isArray(row.citations) || !Array.isArray(row.evidence)) {
    throw new Error("Answer fixture is missing citations or evidence.");
  }
  if (served !== "live" && typeof row.cached_at !== "string") {
    throw new Error("Cached or replay answer is missing cached_at.");
  }
  for (const citation of row.citations) {
    const record = asRecord(citation);
    const sourceUrl = record ? asNonEmpty(record.source_url) : null;
    if (!sourceUrl || !isSafeHttpUrl(sourceUrl)) {
      throw new Error("Citation source_url must be an http or https URL.");
    }
  }
  return value as Answer;
}
