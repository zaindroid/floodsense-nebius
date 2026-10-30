import { SIMULATED_ALERT_M3S } from "../config/scenario";
import { parseUtc } from "./time";

/** One hourly (or daily) reading at a point. Same fields as hazard_timeline. */
export interface ReplayReading {
  point_id: string;
  ts_utc: string;
  rain_mm: number;
  discharge_m3s: number | null;
}

export interface ReplayPoint {
  point_id: string;
  name: string;
}

export interface DisasterEvent {
  eventId: "EMSR517" | "EMSR773";
  name: string;
  /** Inclusive UTC window, YYYY-MM-DD. */
  start: string;
  end: string;
  /** Discharge line that counts as "it turned", m³/s. Same as the Watchers anomaly line. */
  thresholdM3s: number;
}

export const REPLAY_EVENTS: readonly DisasterEvent[] = [
  { eventId: "EMSR517", name: "Ahr valley, 13–16 Jul 2021", start: "2021-07-13", end: "2021-07-16", thresholdM3s: SIMULATED_ALERT_M3S },
  { eventId: "EMSR773", name: "Valencia DANA, 28–31 Oct 2024", start: "2024-10-28", end: "2024-10-31", thresholdM3s: SIMULATED_ALERT_M3S },
];

export function replayLabel(event: DisasterEvent): string {
  return `Replay of ${event.name} · not live`;
}

/** Canonical ISO (…Z, no fraction) for a reading's stamp, or null. */
export function isoOf(ts: string): string | null {
  const d = parseUtc(ts);
  return d ? d.toISOString().replace(".000Z", "Z") : null;
}

/** Pure: the sorted distinct instants inside the event window. Hourly when the rows are hourly. */
export function buildFrames(rows: readonly ReplayReading[], event: DisasterEvent): string[] {
  const lo = `${event.start}T00:00:00Z`;
  const hi = `${event.end}T23:59:59Z`;
  const set = new Set<string>();
  for (const r of rows) {
    const iso = isoOf(r.ts_utc);
    if (iso && iso >= lo && iso <= hi) set.add(iso);
  }
  return [...set].sort();
}

/** Pure: step index kept inside the frames. */
export function clampStep(index: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.min(Math.max(0, Math.round(index)), frameCount - 1);
}

/** Pure: next play step; wraps to the start after the last frame. */
export function nextStep(index: number, frameCount: number): number {
  return frameCount <= 0 ? 0 : (index + 1) % frameCount;
}

/** Pure: index of the first frame of each day, for the day stepper. */
export function dayStarts(frames: readonly string[]): { day: string; index: number }[] {
  const out: { day: string; index: number }[] = [];
  frames.forEach((f, i) => {
    const day = f.slice(0, 10);
    if (!out.length || out[out.length - 1].day !== day) out.push({ day, index: i });
  });
  return out;
}

/** Pure: each point's reading at an instant. */
export function readingsAt(rows: readonly ReplayReading[], iso: string): Map<string, ReplayReading> {
  const out = new Map<string, ReplayReading>();
  for (const r of rows) if (isoOf(r.ts_utc) === iso) out.set(r.point_id, r);
  return out;
}

/** Pure: per point, the first frame where discharge reaches the line after being below it ("the moment it turned"). */
export function crossings(
  rows: readonly ReplayReading[],
  frames: readonly string[],
  threshold: number,
): Map<string, { iso: string; index: number; discharge: number }> {
  const byPoint = new Map<string, Map<string, number | null>>();
  for (const r of rows) {
    const iso = isoOf(r.ts_utc);
    if (!iso) continue;
    if (!byPoint.has(r.point_id)) byPoint.set(r.point_id, new Map());
    byPoint.get(r.point_id)!.set(iso, r.discharge_m3s);
  }
  const out = new Map<string, { iso: string; index: number; discharge: number }>();
  for (const [pid, series] of byPoint) {
    let below = false;
    for (let i = 0; i < frames.length; i++) {
      const v = series.get(frames[i]);
      if (v === null || v === undefined) continue;
      if (v < threshold) below = true;
      else if (below) {
        out.set(pid, { iso: frames[i], index: i, discharge: v });
        break;
      }
    }
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Jul 2021 at 18:00" (UTC). */
export function momentText(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${hh}:${mm}`;
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Pure: true when every point's discharge is one value per UTC day (GloFAS daily repeated on each hour). */
export function isDailyDischarge(rows: readonly ReplayReading[]): boolean {
  const seen = new Map<string, number | null>();
  for (const r of rows) {
    const iso = isoOf(r.ts_utc);
    if (!iso) continue;
    const key = `${r.point_id}|${dayOf(iso)}`;
    if (seen.has(key) && seen.get(key) !== r.discharge_m3s) return false;
    seen.set(key, r.discharge_m3s);
  }
  return true;
}

/** "14 Jul 2021". */
export function dayText(iso: string): string {
  return momentText(iso).replace(/ at .*/, "");
}

/** Pure: the crossing as a reader should see it. Daily discharge names the day only, never an hour. */
export function crossingText(iso: string, daily: boolean): string {
  return daily ? `Crossed the line on ${dayText(iso)} (daily value)` : `Crossed the line at ${momentText(iso)} UTC`;
}

/** Pure: whether the scrubbed frame is "the moment it turned" (same day for daily data, same hour otherwise). */
export function isTurnFrame(frameIso: string, crossingIso: string, daily: boolean): boolean {
  return daily ? dayOf(frameIso) === dayOf(crossingIso) : frameIso === crossingIso;
}

/** The question the "Ask" button pre-fills, at the data's resolution: a day for daily discharge. */
export function momentQuestionAt(placeName: string, iso: string, daily: boolean): string {
  return daily ? `Why was ${placeName} at risk on ${dayText(iso)}?` : momentQuestion(placeName, iso);
}

/** The question the "Ask the agents" button pre-fills, with the hour. */
export function momentQuestion(placeName: string, iso: string): string {
  return `Why was ${placeName} at risk on ${momentText(iso)} UTC?`;
}
