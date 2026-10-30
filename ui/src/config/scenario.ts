/**
 * Demo values for the Valencia replay screen.
 * One place for dates, map geometry, band cuts, and the optional view paths.
 * These are not the shared contract and they are not warning levels.
 */

export const DEFAULT_DATE = "2024-10-29";
export const DEFAULT_POINT_ID = "VAL01";

/** Inclusive window the alert simulation walks. */
export const SIM_WINDOW_START = "2024-10-28";
export const SIM_WINDOW_END = "2024-10-31";
export const SIM_PLAY_INTERVAL_MS = 900;

/**
 * The one FloodSense alert line, in m³/s: Sites map, Replay and Overview all read it.
 * Mirrors anomaly_discharge (100) in agents/floodsense_agents/governance.py.
 * Not a warning level and not official.
 */
export const SIMULATED_ALERT_M3S = 100;

/** Marker bands below the simulation threshold, in m³/s. */
export const BAND_TYPICAL_M3S = 1;
export const BAND_ELEVATED_M3S = 20;

/** Haversine radius for the drill-down book totals. */
export const DRILLDOWN_RADIUS_KM = 8;

/** Inland-to-coast schematic. Not a river geometry layer. */
export const MAP_CHANNEL_IDS = ["VAL08", "VAL07", "VAL01"] as const;
export const COAST_LAT = 39.4;
export const COAST_LON = -0.34;
export const MOUTH_LAT = 39.41;
export const MOUTH_LON = -0.3;

export const MAP_BOUNDS = {
  minLat: 39.12,
  maxLat: 39.64,
  minLon: -1.3,
  maxLon: -0.18,
};

/** Used when VITE_API_TIMEOUT_MS is unset or not a positive number. */
export const API_TIMEOUT_MS_DEFAULT = 10000;

/**
 * Optional reads. Not the run contract. This desk does not call /runs.
 * It probes GET /health, then these paths. The API also serves /config, /runs,
 * and approval. A health check alone is not live data.
 */
export const VIEW_PATHS = {
  discharge_daily: "/views/discharge_daily",
  hazard_timeline: "/views/hazard_timeline",
  exposure_join: "/views/exposure_join",
  provenance: "/views/provenance",
} as const;

export type ViewName = keyof typeof VIEW_PATHS;

export const FIXTURE_DETAILS = {
  discharge_daily: "Fixture copy of floodsense_seed.discharge_daily (migration 012).",
  hazard_timeline: "Fixture copy of floodsense_seed.hazard_timeline for 28–30 Oct 2024 (migration 013).",
  exposure_join: "Fixture copy of floodsense_seed.exposure_join (migration 016).",
  provenance: "Fixture copy of floodsense_seed.provenance columns (migration 017).",
} as const;
