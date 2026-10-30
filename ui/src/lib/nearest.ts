import type { WatchSource } from "./euWatch";
import { statusView } from "./places";

/** The insured book this demo ships: synthetic, Valencia only. Said wherever sites are drawn or totalled. */
export const DEMO_BOOK_LINE = "Demo book: synthetic Valencia portfolio · connect your own book";

/** A watched source this far from a site or nearer is taken to describe that site's river. Farther is only "nearest". */
export const NEAR_KM = 25;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

const okCoord = (lat: unknown, lon: unknown): boolean =>
  typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Pure: the nearest watched source and its distance, or null when the site has no usable lat/lon or no source exists. */
export function nearestSource(site: { lat: number; lon: number }, sources: readonly WatchSource[]): { source: WatchSource; km: number } | null {
  if (!okCoord(site.lat, site.lon)) return null;
  let best: { source: WatchSource; km: number } | null = null;
  for (const s of sources) {
    if (!okCoord(s.lat, s.lon)) continue;
    const km = haversineKm(site, s);
    if (!best || km < best.km) best = { source: s, km };
  }
  return best;
}


/** Pure: the per-site line. Within NEAR_KM it gives the source's live status; farther it says the source is too far to describe the site. */
export function siteWatchLine(n: { source: WatchSource; km: number } | null): string {
  if (!n) return "No usable lat/lon, or no watched source loaded";
  const what = `${n.source.river ? `${n.source.river} at ` : ""}${n.source.name} (${n.source.kind === "gauge" ? "gauge" : "model"})`;
  const km = `${Math.round(n.km)} km`;
  if (n.km > NEAR_KM) return `Nearest watched source: ${what}, ${km} away — too far to describe this site`;
  return `${what}, ${km} away: ${statusView(n.source.kind, n.source.status).word}${n.source.live ? "" : " · not live"}`;
}

export interface NearestGroup {
  source: WatchSource;
  sites: number;
  minKm: number;
  maxKm: number;
  near: boolean;
}

/** Pure: insured sites grouped by their nearest watched source, nearest groups first. Sites without lat/lon are counted apart. */
export function groupByNearest(
  sites: readonly { lat: number; lon: number }[],
  sources: readonly WatchSource[],
): { groups: NearestGroup[]; unplaced: number } {
  const by = new Map<string, NearestGroup>();
  let unplaced = 0;
  for (const site of sites) {
    const n = nearestSource(site, sources);
    if (!n) {
      unplaced += 1;
      continue;
    }
    const g = by.get(n.source.id);
    if (g) {
      g.sites += 1;
      g.minKm = Math.min(g.minKm, n.km);
      g.maxKm = Math.max(g.maxKm, n.km);
      g.near = g.minKm <= NEAR_KM;
    } else {
      by.set(n.source.id, { source: n.source, sites: 1, minKm: n.km, maxKm: n.km, near: n.km <= NEAR_KM });
    }
  }
  return { groups: [...by.values()].sort((a, b) => a.minKm - b.minKm), unplaced };
}
