/**
 * Column names match the Zetaris views on feat/zetaris-data-sync.
 * discharge_daily and the seed view share one shape (migrations 004 and 012).
 * hazard_timeline: 007 / 013. exposure_join: 014 / 016. provenance: 015 / 017.
 * Valencia points are the prep CSV, not a view. point_id joins them to discharge.
 */

export interface DischargeDailyRow {
  point_id: string;
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  discharge_m3s: number;
  source: string;
}

export interface HazardTimelineRow {
  point_id: string;
  /**
   * ISO 8601 timestamp. Migration 007 has no zone; validators store that form as UTC (Z).
   */
  ts_utc: string;
  rain_mm: number;
  /** Null when the view omitted the column or stored SQL NULL. */
  discharge_m3s: number | null;
  warning_level: string | null;
}

export interface ExposureJoinRow {
  policy_id: string;
  site_id: string;
  lat: number;
  lon: number;
  in_footprint: boolean;
  sum_insured_eur: number;
  segment: string;
  /** Migration 018. "yes" means the synthetic book, never a live exposure feed. */
  synthetic?: string;
}

export interface ProvenanceRow {
  dataset: string;
  source_url: string;
  publisher: string;
  licence: string;
  attribution: string;
  /** accessed_at from the prep CSV, cast to a timestamp the way the view does. */
  fetched_at: string;
}

export interface ValenciaPoint {
  point_id: string;
  name: string;
  municipality: string;
  lat: number;
  lon: number;
  why: string;
  verified_against_footprint: string;
  in_flood: string;
  dist_m_to_flood: number;
}

/** fixture: local JSON, an empty array, or adopted rows with no source stamp. seed: a seed stamp, a seed sibling of seed discharge, or synthetic === "yes". live: every row carries a non-seed source stamp and none is synthetic. A live discharge response does not paint an unstamped sibling live. Health alone is never live. */
export type DataOrigin = "fixture" | "seed" | "live";

export interface LoadedRows<T> {
  rows: T[];
  origin: DataOrigin;
  detail: string;
}
