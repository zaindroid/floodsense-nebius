/** Pure logic of MapShell: mode persistence and the band-to-column mapping used by the 3D view. */
import type { DischargeBand } from "../../types/ui";
import type { GaugeStatus } from "../../lib/gauges";

export type MapMode = "2d" | "3d";
export const MAP_MODE_KEY = "floodsense.mapMode";
export const DEFAULT_MAP_MODE: MapMode = "2d";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 2D unless the viewer chose 3D. Storage may be blocked or absent: then the default. */
export function readMapMode(storage: StorageLike | null = browserStorage()): MapMode {
  try {
    return storage?.getItem(MAP_MODE_KEY) === "3d" ? "3d" : DEFAULT_MAP_MODE;
  } catch {
    return DEFAULT_MAP_MODE;
  }
}

export function writeMapMode(mode: MapMode, storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.setItem(MAP_MODE_KEY, mode);
  } catch {
    /* private mode: the choice lasts for this page view only */
  }
}

/** Shown mode after a 3D failure (no WebGL, style or tile error): back to 2D, and 2D is saved so the next load does not retry. */
export function failMapMode(storage: StorageLike | null = browserStorage()): MapMode {
  writeMapMode("2d", storage);
  return "2d";
}

/** One point as the shell draws it. `rank` 0..3 is the band order, not a measured value; -1 = no reading, no column. */
export interface ShellPoint {
  id: string;
  lat: number;
  lon: number;
  label: string;
  rank: number;
  color: string;
}

export interface ExtraPoint {
  id: string;
  label?: string;
  lat: number;
  lon: number;
}

/** Amber, never red, for every model band; red is not in this palette at all. */
export const BAND_STYLE: Record<DischargeBand, { rank: number; color: string }> = {
  low: { rank: 0, color: "#3f8f5f" },
  typical: { rank: 1, color: "#d9b44a" },
  elevated: { rank: 2, color: "#d98a1f" },
  peak: { rank: 3, color: "#a85d00" },
};
export const STATUS_STYLE: Record<GaugeStatus, { rank: number; color: string }> = {
  ok: { rank: 0, color: "#3f8f5f" },
  near: { rank: 1, color: "#d9b44a" },
  over: { rank: 2, color: "#a85d00" },
  unknown: { rank: -1, color: "#8a97a8" },
};

type Base = { id: string; lat: number; lon: number; label: string };
/** `null` band = no value for that point: a flat marker, not a column. */
export const bandPoint = (p: Base, band: DischargeBand | null): ShellPoint => ({ ...p, ...(band ? BAND_STYLE[band] : STATUS_STYLE.unknown) });
export const statusPoint = (p: Base, status: GaugeStatus): ShellPoint => ({ ...p, ...STATUS_STYLE[status] });

const M_PER_DEG = 111_000;

/**
 * GeoJSON squares for fill-extrusion. `halfDeg` is the half side in degrees; height is (rank + 1) steps of
 * 4 x halfDeg, so a column's height shows its band order only. Points with a non-finite position are dropped.
 */
export function columnsGeoJson(points: readonly ShellPoint[], selectedId: string | undefined, halfDeg: number) {
  const features = points
    .filter((p) => p.rank >= 0 && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => {
      const h = p.id === selectedId ? halfDeg * 1.6 : halfDeg;
      const dx = h / Math.max(Math.cos((p.lat * Math.PI) / 180), 0.2);
      const ring = [
        [p.lon - dx, p.lat - h],
        [p.lon + dx, p.lat - h],
        [p.lon + dx, p.lat + h],
        [p.lon - dx, p.lat + h],
        [p.lon - dx, p.lat - h],
      ];
      return {
        type: "Feature" as const,
        properties: { id: p.id, label: p.label, color: p.color, height: (p.rank + 1) * halfDeg * 4 * M_PER_DEG },
        geometry: { type: "Polygon" as const, coordinates: [ring] },
      };
    });
  return { type: "FeatureCollection" as const, features };
}

/** Points with no reading: a small flat grey circle labelled as such, never a column. */
export function flatGeoJson(points: readonly ShellPoint[]) {
  return {
    type: "FeatureCollection" as const,
    features: points
      .filter((p) => p.rank < 0 && Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({
        type: "Feature" as const,
        properties: { id: p.id, label: `${p.label} · no reading, no column`, color: p.color },
        geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
      })),
  };
}
