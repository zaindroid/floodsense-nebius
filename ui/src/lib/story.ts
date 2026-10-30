import { crossings, isoOf, type DisasterEvent, type ReplayPoint, type ReplayReading } from "./disasterReplay";

/** One key moment of a replayed flood, as a sentence derived from the replay rows. */
export interface StoryMoment {
  /** The reading's own stamp. For daily values this is the day, not an hour. */
  iso: string;
  /** Sort key: a daily value counts at the end of its day, so it never claims to precede an hourly moment that day. */
  sortKey: string;
  /** True when the moment is a daily value (dated "by end of <day>", never with a time). */
  daily: boolean;
  pointId: string;
  topic: "rain" | "discharge";
  text: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Jul, 18:00" (UTC), or "14 Jul" for daily data. */
export function shortWhen(iso: string, daily: boolean): string {
  const d = new Date(iso);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (daily) return day;
  return `${day}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "By end of 14 Jul" for a daily value, "14 Jul, 18:00" for an hourly one. */
function whenText(iso: string, daily: boolean): string {
  return daily ? `By end of ${shortWhen(iso, true)}` : shortWhen(iso, false);
}

function sortKeyOf(iso: string, daily: boolean): string {
  return daily ? `${iso.slice(0, 10)}T23:59:59Z` : iso;
}

const MAX_CROSSINGS = 3;

/**
 * Pure: 3-5 key moments in time order. The heaviest rain hour (rain is hourly), the first crossings of the
 * event's line, and always the peak flow; a crossing on the peak's point and day is merged into one sentence.
 * Daily discharge is dated "by end of <day>" and sorted after any hourly moment of that day.
 */
export function storyMoments(
  rows: readonly ReplayReading[],
  points: readonly ReplayPoint[],
  frames: readonly string[],
  event: DisasterEvent,
  daily: boolean,
): StoryMoment[] {
  if (frames.length === 0) return [];
  const inWindow = new Set(frames);
  const name = (pid: string) => points.find((p) => p.point_id === pid)?.name ?? pid;
  const out: StoryMoment[] = [];
  const line = `${event.thresholdM3s} m³/s alert line`;
  const tail = daily ? " (daily value)" : "";

  let rain: { r: ReplayReading; iso: string } | null = null;
  let peak: { r: ReplayReading; iso: string } | null = null;
  for (const r of rows) {
    const iso = isoOf(r.ts_utc);
    if (!iso || !inWindow.has(iso)) continue;
    if (r.rain_mm > 0 && (!rain || r.rain_mm > rain.r.rain_mm)) rain = { r, iso };
    if (r.discharge_m3s !== null && (!peak || r.discharge_m3s > (peak.r.discharge_m3s ?? -1))) peak = { r, iso };
  }
  if (rain) {
    out.push({
      iso: rain.iso,
      sortKey: rain.iso,
      daily: false,
      pointId: rain.r.point_id,
      topic: "rain",
      text: `${shortWhen(rain.iso, false)} — the heaviest rain fell at ${name(rain.r.point_id)}: ${rain.r.rain_mm.toFixed(1)} mm in one hour.`,
    });
  }
  const peakM3s = peak?.r.discharge_m3s ?? null;
  const samePeriod = (a: string, b: string) => (daily ? a.slice(0, 10) === b.slice(0, 10) : a === b);
  let peakMerged = false;
  const turned = [...crossings(rows, frames, event.thresholdM3s).entries()].sort((a, b) => a[1].index - b[1].index);
  for (const [pid, c] of turned.slice(0, MAX_CROSSINGS)) {
    const iso = daily ? c.iso.slice(0, 10) : c.iso;
    const merge = peak !== null && peakM3s !== null && peak.r.point_id === pid && samePeriod(peak.iso, c.iso);
    if (merge) peakMerged = true;
    out.push({
      iso,
      sortKey: sortKeyOf(c.iso, daily),
      daily,
      pointId: pid,
      topic: "discharge",
      text: merge
        ? `${whenText(c.iso, daily)} — river flow at ${name(pid)} crossed the ${line} and peaked at about ${Math.round(peakM3s!)} m³/s${tail}.`
        : `${whenText(c.iso, daily)} — river flow at ${name(pid)} crossed the ${line}${tail}.`,
    });
  }
  if (peak && peakM3s !== null && !peakMerged) {
    out.push({
      iso: daily ? peak.iso.slice(0, 10) : peak.iso,
      sortKey: sortKeyOf(peak.iso, daily),
      daily,
      pointId: peak.r.point_id,
      topic: "discharge",
      text: `${whenText(peak.iso, daily)} — river flow peaked at ${name(peak.r.point_id)}, about ${Math.round(peakM3s)} m³/s${tail}.`,
    });
  }
  return out.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || (a.topic === "rain" ? -1 : 0));
}
