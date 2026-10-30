import ahr from "../fixtures/ahr_2021.json";
import type { DischargeDailyRow, ValenciaPoint } from "../types/views";
import type { DisasterEvent } from "./disasterReplay";
import type { AskContext } from "./askContext";
import type { DeskRoute } from "./route";

export type EventId = DisasterEvent["eventId"];

/** The event the console opens on: Ahr first, as the Replay page always did (Germany-first demo). */
export const DEFAULT_EVENT_ID: EventId = "EMSR517";

export const EVENT_META: Record<EventId, { short: string; region: string }> = {
  EMSR517: { short: "Ahr 2021", region: "Germany · Ahr valley" },
  EMSR773: { short: "Valencia 2024", region: "Spain · Valencia" },
};

/** Header subtitle: a short product tagline, the same on every page. Page context lives in the context strip. */
export const PRODUCT_TAGLINE = "Explainable flood risk for Europe";

export function headerSubtitle(): string {
  return PRODUCT_TAGLINE;
}

/** The Now page's own subtitle (#78 live-watch wording), shown in the context strip on Now. */
export const NOW_SUBTITLE = "Live · Europe live watch";

/** One map point with real coordinates from the seed rows. */
export interface MapPoint {
  point_id: string;
  name: string;
  /** Short permanent map label, e.g. "Paiporta" or "Dernau". */
  label: string;
  lat: number;
  lon: number;
}

/** Valencia: municipality from the prep CSV (valencia_points). */
export function valenciaMapPoints(points: readonly ValenciaPoint[]): MapPoint[] {
  return points.map((p) => ({
    point_id: p.point_id,
    name: p.name,
    label: p.municipality || p.name.replace(/ centre$/i, ""),
    lat: p.lat,
    lon: p.lon,
  }));
}

/** Ahr: the AHR01–AHR04 points of ingestion/prep/ahr_hazard.py, the same rows as floodsense_seed (migrations 051/052). */
export function ahrMapPoints(): MapPoint[] {
  return ahr.points.map((p) => ({ point_id: p.point_id, name: p.name, label: p.name, lat: p.lat, lon: p.lon }));
}

/** Ahr daily GloFAS discharge, from the same seed rows. */
export function ahrDischarge(): DischargeDailyRow[] {
  return ahr.discharge_daily.map((r) => ({ ...r })) as DischargeDailyRow[];
}

/** Popup / tooltip text for one point on one day. */
export function pointPopupText(point: MapPoint, m3s: number | null, day: string): string {
  const value = m3s === null ? "no discharge row" : `${m3s.toFixed(1)} m³/s`;
  return `${point.point_id} · ${point.name} · ${value} on ${day}`;
}

/** Ahr opens on the GloFAS peak day of the replay window. */
export const AHR_DEFAULT_DATE = "2021-07-14";

/** [[south, west], [north, east]] around the points, or null with none. */
export function boundsOf(points: readonly { lat: number; lon: number }[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}

/** The selected point and replay date of the active event, for the Ask `context`. */
export function activeEventSelection(
  eventId: EventId,
  valencia: { date: string; pointId: string; points: readonly { point_id: string; name: string }[] },
  ahrSel: { date: string; pointId: string },
): { event_id: EventId; replay_date: string; point_id: string; place?: string } {
  if (eventId === "EMSR517") {
    const point = ahrMapPoints().find((p) => p.point_id === ahrSel.pointId);
    return { event_id: eventId, replay_date: ahrSel.date, point_id: ahrSel.pointId, place: point?.name };
  }
  const point = valencia.points.find((p) => p.point_id === valencia.pointId);
  return { event_id: eventId, replay_date: valencia.date, point_id: valencia.pointId, place: point?.name };
}

/** Pure: the Ask `context` for the page under the global mode. Live sends no event at all; Past names the chosen event, its replay date and point. */
export function screenContextFor(
  route: DeskRoute,
  eventId: EventId,
  valencia: { date: string; pointId: string; points: readonly { point_id: string; name: string }[] },
  ahrSel: { date: string; pointId: string },
  mode: "live" | "past" = "live",
): AskContext {
  // Civil protection pages name no event or Valencia point: the place is the one picked on the board.
  if (route.role === "operator") return { role: route.role, page: route.page };
  if (mode === "past") return { role: route.role, page: route.page, ...activeEventSelection(eventId, valencia, ahrSel) };
  return { role: route.role, page: route.page };
}

/** The event the chat greeting fits: the chosen one in Past, else Valencia (only the live greeting ignores it). */
export function shownEventId(mode: "live" | "past", eventId: EventId): EventId {
  return mode === "past" ? eventId : "EMSR773";
}
