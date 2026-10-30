// Every watched place, read live and put in one shape: where it is, its state
// against its own usual level, the number behind it and where that came from.
import { get } from "./api.js";
import { num } from "./ui.js";

// The eight Valencia points (ui/src/fixtures/valencia_points.json on main), with town-centre coordinates.
const VALENCIA = {
  VAL01: ["Paiporta", 39.428, -0.418], VAL02: ["Catarroja", 39.403, -0.403], VAL03: ["Sedaví", 39.426, -0.385],
  VAL04: ["Alfafar", 39.422, -0.390], VAL05: ["Benetússer", 39.423, -0.397], VAL06: ["Algemesí", 39.190, -0.436],
  VAL07: ["Chiva", 39.468, -0.718], VAL08: ["Utiel", 39.567, -1.205],
};
// main's own labelled line for the Valencia model points; not an official threshold.
export const VALENCIA_LINE = 20;

export const STATE = {
  normal: { word: "Normal", tone: "ok", rank: 0, plain: "At its usual level." },
  watch: { word: "Watch", tone: "watch", rank: 1, plain: "Higher than usual. Keep an eye on local news." },
  high: { word: "High", tone: "high", rank: 2, plain: "Well above its usual level. Follow official warnings." },
  unknown: { word: "No threshold", tone: "", rank: -1, plain: "No usual level to compare with." },
};
const BAND = { below: "normal", near: "watch", above: "high" };
const countries = new Intl.DisplayNames(["en"], { type: "region" });
const country = (code) => { try { return countries.of(code); } catch { return code; } };
export const titled = (s) => String(s || "").toLowerCase().replace(/(^|[\s(\-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
export const bySeverity = (a, b) => STATE[b.state].rank - STATE[a.state].rank || (b.ratio ?? 0) - (a.ratio ?? 0) || a.place.localeCompare(b.place);

export async function loadPlaces() {
  const [gauges, eu, hazard] = await Promise.all([get("/views/gauge_levels"), get("/views/eu_watch"), get("/views/hazard_now")]);
  return places(gauges, eu, hazard);
}

export function places(gauges, eu, hazard) {
  const out = [];
  for (const g of gauges || []) {
    out.push({
      group: "germany", place: titled(g.station), where: `${titled(g.water)}, Germany`, lat: g.lat, lon: g.lon,
      value: `${num(g.level_cm)} cm`, detail: g.mhw_cm ? `usual high ${num(g.mhw_cm)} cm` : "",
      trend: typeof g.trend_cm_h === "number" ? g.trend_cm_h : null, state: BAND[g.band] || "unknown",
      source: "Gauge, measured", at: g.ts_utc, ratio: g.mhw_cm ? g.level_cm / g.mhw_cm : null, usual: "its usual high water",
    });
  }
  for (const e of eu || []) {
    out.push({
      group: "europe", place: e.name, where: `${e.river}, ${country(e.country)}`, lat: e.lat, lon: e.lon,
      value: `${num(e.forecast_max_m3s)} m³/s`, detail: e.past30_median_m3s ? `${num(e.forecast_max_m3s / e.past30_median_m3s, 1)}× its usual flow` : "",
      trend: null, state: BAND[e.band] || "unknown", source: "River model, 7-day forecast", at: e.as_of_date,
      ratio: e.past30_median_m3s ? e.forecast_max_m3s / e.past30_median_m3s : null, usual: "its usual flow",
    });
  }
  const byPoint = {};
  for (const r of hazard || []) (byPoint[r.point_id] ||= []).push(r);
  for (const [id, rows] of Object.entries(byPoint)) {
    const [name, lat, lon] = VALENCIA[id] || [id, null, null];
    const past = rows.filter((r) => r.horizon === "past").sort((a, b) => String(a.ts_utc).localeCompare(String(b.ts_utc)));
    const now = past[past.length - 1];
    const peak = Math.max(...rows.filter((r) => r.horizon === "forecast").map((r) => r.discharge_m3s ?? 0), now?.discharge_m3s ?? 0);
    out.push({
      group: "valencia", place: name, where: "Valencia, Spain", lat, lon,
      value: `${num(now?.discharge_m3s, 1)} m³/s`, detail: `next 48 h up to ${num(peak, 1)} m³/s`,
      trend: null, state: peak > VALENCIA_LINE ? "watch" : "normal", source: "River model, 48-hour forecast", at: now?.ts_utc,
      ratio: peak / VALENCIA_LINE, usual: `the ${VALENCIA_LINE} m³/s line`,
    });
  }
  return out;
}
