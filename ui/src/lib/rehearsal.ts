import { crossings, dayText, momentText, readingsAt, type ReplayPoint, type ReplayReading } from "./disasterReplay";

export interface RehearsalState {
  dayText: string;
  /** Points at or above the line at the end of the shown day. */
  over: string[];
  /** The earliest crossing at or before the shown day, or null when nothing has crossed yet. */
  crossed: { pointId: string; name: string; iso: string; index: number } | null;
}

/**
 * Pure: the rehearsal at the day starting at `startIndex`. A crossing counts once its frame is on or before the
 * end of that day, so daily discharge (one value per day) crosses on its day, never at a made-up hour.
 */
export function rehearsalAt(
  rows: readonly ReplayReading[],
  frames: readonly string[],
  threshold: number,
  startIndex: number,
  points: readonly ReplayPoint[],
): RehearsalState | null {
  if (frames.length === 0) return null;
  const start = Math.min(Math.max(0, startIndex), frames.length - 1);
  const day = frames[start].slice(0, 10);
  let end = start;
  while (end + 1 < frames.length && frames[end + 1].slice(0, 10) === day) end += 1;
  const at = readingsAt(rows, frames[end]);
  const over = [...at.values()].filter((r) => r.discharge_m3s !== null && r.discharge_m3s >= threshold).map((r) => r.point_id).sort();
  const first = [...crossings(rows, frames, threshold).entries()]
    .filter(([, c]) => c.index <= end)
    .sort((a, b) => a[1].index - b[1].index || a[0].localeCompare(b[0]))[0];
  return {
    dayText: dayText(frames[start]),
    over,
    crossed: first
      ? { pointId: first[0], name: points.find((p) => p.point_id === first[0])?.name ?? first[0], iso: first[1].iso, index: first[1].index }
      : null,
  };
}

/** The question a rehearsal run asks. It names insurer actions, so the router takes the full lane. */
export function rehearsalQuestion(place: string, iso: string, threshold: number, daily: boolean): string {
  const when = daily ? dayText(iso) : `${momentText(iso)} UTC`;
  return `Rehearsal of a past flood: ${place} crossed ${threshold} m³/s on ${when}. Which insured sites are exposed, and what should the insurer do?`;
}
