import type { WatchSource } from "./euWatch";
import type { GaugeStatus } from "./gauges";
import type { EventId } from "./events";

/**
 * Citizen places: every live-watch source (PEGELONLINE gauge, GloFAS point, Valencia model point) plus the
 * Valencia and Ahr replay places. Pure; the data comes from the views, nothing here is invented.
 */
/**
 * Colour of a status chip. Nothing is red: a gauge at or above its long-term mean high water and a model band that is
 * far above normal are amber ("elevated"); the lower model bands are amber ("watch") or neutral.
 */
export type Tone = "normal" | "watch" | "elevated" | "warning" | "neutral" | "unknown";

export interface StatusView {
  word: string;
  tone: Tone;
  /** Worst first: 0 is shown first. */
  rank: number;
}

const UNKNOWN: StatusView = { word: "No reading", tone: "unknown", rank: 9 };

/** The view band of one source as a plain word and tone, by what it is measured against. */
export function statusView(kind: WatchSource["kind"], status: GaugeStatus): StatusView {
  if (status === "unknown") return UNKNOWN;
  if (status === "ok") return { word: "Normal", tone: "normal", rank: 8 };
  if (kind === "gauge")
    return status === "over"
      ? { word: "Above mean high water", tone: "elevated", rank: 0 }
      : { word: "Close to mean high water", tone: "watch", rank: 2 };
  if (kind === "model")
    return status === "over" ? { word: "Elevated (model)", tone: "elevated", rank: 1 } : { word: "Watch (model)", tone: "watch", rank: 3 };
  return status === "over"
    ? { word: "Far above its recent normal (model)", tone: "elevated", rank: 4 }
    : { word: "Above its recent normal (model)", tone: "neutral", rank: 5 };
}

/** What the status is measured against, shown next to the word so a model is never read as official. */
export function basisLabel(kind: WatchSource["kind"]): string {
  if (kind === "gauge") return "measured · vs long-term mean high water (not a warning level)";
  if (kind === "valencia") return "model · compared with the point's own past three days, not official";
  return "model, not an official warning";
}

/** "Measured" for a gauge reading, "Modelled" for a model hour or day. */
export function timeWord(kind: WatchSource["kind"]): "Measured" | "Modelled" {
  return kind === "gauge" ? "Measured" : "Modelled";
}

/** One calm sentence a person can read. Place names keep their own casing. */
export function calmSentence(kind: WatchSource["kind"], status: GaugeStatus, river: string, name: string): string {
  if (status === "unknown") return `We have no current reading for ${name}.`;
  if (kind === "gauge") {
    const where = river ? `The ${river} at ${name}` : name;
    if (status === "ok") return `${where} is at a normal level, below its long-term mean high water.`;
    if (status === "near")
      return `${where} is close to its long-term mean high water (not a warning level). Keep an eye on official warnings.`;
    return `${where} is at or above its long-term mean high water (not a warning level). Check your official warning service.`;
  }
  if (kind === "model") {
    const where = river ? `the ${river} at ${name}` : name;
    if (status === "ok") return `Our model shows normal river flow for ${where} over the next 7 days.`;
    if (status === "near")
      return `Our model shows river flow for ${where} somewhat above its recent 30-day normal over the next 7 days. Model, not an official warning.`;
    return `Our model shows river flow for ${where} at least twice its recent 30-day normal over the next 7 days. Model, not an official warning.`;
  }
  if (status === "ok") return `Our model shows river flow at ${name} within its own recent normal (the past three days; not official).`;
  if (status === "near") return `Our model shows river flow at ${name} at least twice its own recent normal (the past three days; not official).`;
  return `Our model shows river flow at ${name} at least four times its own recent normal (the past three days; not official). Check your official warning service.`;
}

export interface Place {
  id: string;
  kind: WatchSource["kind"] | "replay";
  name: string;
  river: string;
  /** ISO 3166-1 alpha-2, upper case ("DE", "ES", "FR"). */
  country: string;
  /** Live source behind the place; null for a replay place. */
  source: WatchSource | null;
  /** Replay places only. */
  eventId: EventId | null;
  pointId: string | null;
  /** Extra search words (municipality, country name, point id). */
  keywords: string;
}

const COUNTRY_NAMES: Record<string, string> = {
  DE: "Germany Deutschland",
  ES: "Spain España",
  FR: "France",
  IT: "Italy Italia",
  PL: "Poland Polska",
  AT: "Austria Österreich",
  HU: "Hungary Magyarország",
  BE: "Belgium België Belgique",
  CZ: "Czechia Czech Republic Česko",
};

export function countryName(code: string): string {
  return (COUNTRY_NAMES[code.toUpperCase()] ?? code).split(" ")[0];
}

export function placeFromSource(s: WatchSource): Place {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    river: s.river,
    country: s.country.toUpperCase(),
    source: s,
    eventId: null,
    pointId: null,
    keywords: `${COUNTRY_NAMES[s.country.toUpperCase()] ?? s.country} ${s.id}`,
  };
}

export function replayPlace(
  eventId: EventId,
  point: { point_id: string; name: string; municipality?: string },
): Place {
  const es = eventId === "EMSR773";
  return {
    id: `replay:${point.point_id}`,
    kind: "replay",
    name: point.name,
    river: es ? "" : "Ahr",
    country: es ? "ES" : "DE",
    source: null,
    eventId,
    pointId: point.point_id,
    keywords: `${point.municipality ?? ""} ${point.point_id} ${es ? "Valencia 2024 DANA" : "Ahr 2021"} ${COUNTRY_NAMES[es ? "ES" : "DE"]}`,
  };
}

/** Live sources first, then the replay places. */
export function buildPlaces(
  sources: readonly WatchSource[],
  valencia: readonly { point_id: string; name: string; municipality?: string }[],
  ahr: readonly { point_id: string; name: string }[],
): Place[] {
  return [
    ...sources.map(placeFromSource),
    ...valencia.map((p) => replayPlace("EMSR773", p)),
    ...ahr.map((p) => replayPlace("EMSR517", p)),
  ];
}

/** Case- and accent-insensitive. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase();
}

/** Every word of the query must match the place's name, river, country or keywords. Empty query: all places. */
export function searchPlaces(places: readonly Place[], query: string): Place[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...places];
  return places.filter((p) => {
    const hay = fold(`${p.name} ${p.river} ${p.country} ${p.keywords}`);
    return words.every((w) => hay.includes(w));
  });
}

export function plainOf(s: WatchSource): StatusView {
  return statusView(s.kind, s.status);
}

/** Worst first (gauges above MHW, then elevated model points, ...), then by ratio, then name. */
export function worstFirst(list: readonly WatchSource[]): WatchSource[] {
  return [...list].sort(
    (a, b) => plainOf(a).rank - plainOf(b).rank || (b.ratio ?? -1) - (a.ratio ?? -1) || a.name.localeCompare(b.name),
  );
}

/** The replay event of a place id ("replay:VAL01" -> EMSR773, "replay:AHR01" -> EMSR517), else null. */
export function replayEventOfPlace(placeId: string | null): EventId | null {
  if (!placeId?.startsWith("replay:")) return null;
  const point = placeId.slice("replay:".length);
  if (/^VAL\d+$/i.test(point)) return "EMSR773";
  if (/^AHR\d+$/i.test(point)) return "EMSR517";
  return null;
}

/** The Ask question for a chosen place. */
export function questionForPlace(place: Place): string {
  if (place.source) return place.source.question;
  return place.eventId === "EMSR517"
    ? `What happened at ${place.name} in the Ahr flood of July 2021?`
    : `What happened at ${place.name} in the Valencia flood of October 2024?`;
}

/**
 * Pure: the picker's short list with an empty search. The chosen place always comes first (so the current choice
 * is visible), then the worst three live places, then one Valencia and one Ahr replay place; no duplicates.
 */
export function quickPlaces(places: readonly Place[], sources: readonly WatchSource[], chosenId: string | null): Place[] {
  const ids = [
    ...(chosenId ? [chosenId] : []),
    ...worstFirst(sources)
      .slice(0, 3)
      .map((s) => s.id),
    "replay:VAL01",
    "replay:AHR01",
  ];
  const out: Place[] = [];
  for (const id of ids) {
    const p = places.find((x) => x.id === id);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Pure: the oldest of the loaded views' fetch times, so "Updated" never overstates freshness. Null if none loaded. */
export function oldestFetch(times: readonly (number | null | undefined)[]): number | null {
  const loaded = times.filter((t): t is number => typeof t === "number");
  return loaded.length ? Math.min(...loaded) : null;
}

export interface HeadlineCounts {
  gaugesAbove: number;
  gaugesNear: number;
  modelElevated: number;
  /** Model points in their lower band (GloFAS "near", Valencia above the 20 m³/s demo line). */
  modelWatch: number;
  normal: number;
  unknown: number;
  total: number;
}

/** Headline counts that keep gauges above mean high water apart from model points that are elevated. */
export function headlineCounts(list: readonly WatchSource[]): HeadlineCounts {
  const out: HeadlineCounts = { gaugesAbove: 0, gaugesNear: 0, modelElevated: 0, modelWatch: 0, normal: 0, unknown: 0, total: list.length };
  for (const s of list) {
    if (s.status === "unknown") out.unknown += 1;
    else if (s.status === "ok") out.normal += 1;
    else if (s.kind === "gauge") {
      if (s.status === "over") out.gaugesAbove += 1;
      else out.gaugesNear += 1;
    } else if (s.status === "over") out.modelElevated += 1;
    else out.modelWatch += 1;
  }
  return out;
}

/** "1 gauge above mean high water · 5 model points elevated · 30 normal". Zero parts are left out, normal stays. */
export function headlineText(c: HeadlineCounts): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (c.gaugesAbove) parts.push(n(c.gaugesAbove, "gauge above mean high water", "gauges above mean high water"));
  if (c.gaugesNear) parts.push(n(c.gaugesNear, "gauge close to mean high water", "gauges close to mean high water"));
  if (c.modelElevated) parts.push(n(c.modelElevated, "model point elevated", "model points elevated"));
  if (c.modelWatch) parts.push(n(c.modelWatch, "model point slightly up", "model points slightly up"));
  parts.push(`${c.normal} normal`);
  if (c.unknown) parts.push(`${c.unknown} no reading`);
  return parts.join(" · ");
}


/**
 * A replay day's status against the event's own replay line (REPLAY_EVENTS thresholdM3s, FloodSense's Watchers
 * line, never an official threshold and never another event's demo line). Amber above the line, never red.
 */
export function replayStatus(m3s: number | null, threshold: number): StatusView {
  if (m3s === null) return { word: "No reading", tone: "unknown", rank: 9 };
  return m3s >= threshold
    ? { word: `Above the ${threshold} m³/s FloodSense alert line (daily value)`, tone: "elevated", rank: 4 }
    : { word: `Below the ${threshold} m³/s FloodSense alert line (daily value)`, tone: "normal", rank: 8 };
}
