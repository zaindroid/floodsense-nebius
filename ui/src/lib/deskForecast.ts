import type { WatchSource } from "./euWatch";
import type { PointNow } from "./now";

/** The only forecast places are the Valencia points, so the place's local zone is Europe/Madrid (CET/CEST). */
const PLACE_ZONE = "Europe/Madrid";

const ymd = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: PLACE_ZONE }).format(d);

/** Day-part words in the place's local time (morning 5-12, afternoon 12-17, evening 17-22, night 22-5), no clock times. */
export function peakWhen(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: PLACE_ZONE, hour: "2-digit", hour12: false }).format(t)) % 24;
  const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
  const days = Math.round((Date.parse(ymd(t)) - Date.parse(ymd(now))) / 86_400_000);
  if (days <= 0) return part === "night" ? "tonight" : "this " + part;
  if (days === 1) return "tomorrow " + part;
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: PLACE_ZONE, weekday: "long" }).format(t);
  return "on " + weekday + " " + part;
}

/**
 * One plain forecast line for a citizen, from the Valencia hazard_now summary only (trend and 48 h forecast max, no numbers or clock times).
 * Null for any other source or when there is no forecast: nothing is invented.
 */
export function forecastLine(source: Pick<WatchSource, "id"> | null, valencia: readonly PointNow[], at: Date = new Date()): string | null {
  if (!source?.id.startsWith("valencia:")) return null;
  const p = valencia.find((x) => x.point_id === source.id.slice("valencia:".length));
  const now = p?.latest?.discharge_m3s ?? null;
  if (!p || !p.forecastMax || now === null) return null;
  const rise = p.forecastMax.discharge_m3s > now * 1.1 && p.forecastMax.discharge_m3s - now > 0.5;
  if (rise) return `Water is rising and may peak ${peakWhen(p.forecastMax.ts_utc, at)}.`;
  if (p.trend === "down") return "Water is falling, no rise expected in the next two days.";
  if (p.trend === "up") return "Water level is up slightly, no big rise expected in the next two days.";
  return "Water is steady, no rise expected in the next two days.";
}
