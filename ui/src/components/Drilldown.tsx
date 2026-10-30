import { DRILLDOWN_RADIUS_KM } from "../config/scenario";
import { statusLabel } from "../lib/origin";
import { useConsole } from "../context/ConsoleContext";
import { formatDay, formatEur, formatHour, formatM3s, formatMm } from "../lib/format";
import {
  hazardOnDate,
  isModelledGlofasSource,
  nearbyExposure,
  peakRow,
  pointById,
  prefersGlofasGridNote,
  rainSummary,
  rowAt,
  sameDischargePoints,
  seriesFor,
} from "../lib/series";
import { Sparkline } from "./Sparkline";

export function Drilldown() {
  const desk = useConsole();
  const point = pointById(desk.points, desk.pointId);
  const series = seriesFor(desk.discharge.rows, desk.pointId);
  const row = rowAt(desk.discharge.rows, desk.pointId, desk.date);
  const activeIndex = series.findIndex((item) => item.date === desk.date);
  const peak = peakRow(series);
  const hours = hazardOnDate(desk.hazard.rows, desk.pointId, desk.date);
  const rain = rainSummary(hours);
  const twins = row ? sameDischargePoints(desk.discharge.rows, desk.pointId, desk.date) : [];
  const nearby = point ? nearbyExposure(desk.exposure.rows, point, DRILLDOWN_RADIUS_KM) : [];
  const nearbySum = nearby.reduce((total, item) => total + item.sum_insured_eur, 0);
  const warning =
    hours.length === 0
      ? "—"
      : hours.every((item) => item.warning_level === null)
        ? "null"
        : hours.map((item) => item.warning_level ?? "null").join(", ");

  return (
    <section className="card" aria-label="Point drill-down">
      <p className="section-label">Drill-down</p>
      <h2>{point ? `${point.point_id} · ${point.name}` : desk.pointId}</h2>
      {point && (
        <p className="lede">
          {point.municipality}. {point.why}
        </p>
      )}
      <p>
        {row
          ? `${formatM3s(row.discharge_m3s)} m³/s ${isModelledGlofasSource(row.source) ? "modelled " : ""}discharge on ${formatDay(desk.date)}.`
          : `No discharge row for this point on ${formatDay(desk.date)}.`}
        {rain.peak ? ` Rain sums to ${formatMm(rain.sum)} mm that day, peaking at ${formatMm(rain.peak.rain_mm)} mm at ${formatHour(rain.peak.ts_utc)}.` : ""}
        {point ? ` ${nearby.length} synthetic in-footprint ${nearby.length === 1 ? "policy" : "policies"} within ${DRILLDOWN_RADIUS_KM} km, ${formatEur(nearbySum)} insured.` : ""}
      </p>
      <div className="button-row">
        <button type="button" className="button primary" onClick={() => desk.openEvidence("discharge")}>
          Why this source
        </button>
        <button type="button" className="button" onClick={() => desk.openEvidence("rain")}>
          Rain provenance
        </button>
      </div>
      <Sparkline
        values={series.map((item) => item.discharge_m3s)}
        activeIndex={activeIndex}
        label={`Discharge series for ${desk.pointId}`}
      />
      {peak && row && peak.date === row.date && (
        <p className="note">Highest day in the loaded series for this point.</p>
      )}
      {twins.length > 0 && row && (
        <p className="note">
          Same river flow as {twins.join(", ")} on this date.
          {prefersGlofasGridNote(row.source)
            ? " Open-Meteo snaps neighbouring points onto one 0.05° cell, so the match is the grid, not two gauges."
            : ""}
        </p>
      )}
      <details className="disclosure">
        <summary>Technical detail</summary>
        {row ? (
          <dl className="kv">
            <div>
              <dt>point_id</dt>
              <dd>{row.point_id}</dd>
            </div>
            <div>
              <dt>date</dt>
              <dd>{row.date}</dd>
            </div>
            <div>
              <dt>discharge_m3s</dt>
              <dd>{formatM3s(row.discharge_m3s)}</dd>
            </div>
            <div>
              <dt>source</dt>
              <dd>{row.source}</dd>
            </div>
          </dl>
        ) : (
          <p className="note">No discharge_daily row for this point on {formatDay(desk.date)}.</p>
        )}
        <h3>hazard_timeline</h3>
        {hours.length === 0 ? (
          <p className="note">
            {desk.hazard.origin === "fixture"
              ? "No hazard rows for this point on this date. The fixture extract covers 28–30 Oct 2024. warning_level is null in that extract."
              : "No hazard rows for this point on this date."}
          </p>
        ) : (
          <dl className="kv">
            <div>
              <dt>hours</dt>
              <dd>{rain.hours}</dd>
            </div>
            <div>
              <dt>rain_mm sum</dt>
              <dd>{formatMm(rain.sum)}</dd>
            </div>
            <div>
              <dt>peak rain_mm</dt>
              <dd>
                {rain.peak ? `${formatMm(rain.peak.rain_mm)} at ${formatHour(rain.peak.ts_utc)}` : "—"}
              </dd>
            </div>
            <div>
              <dt>warning_level</dt>
              <dd>{warning}</dd>
            </div>
          </dl>
        )}
        {point && (
          <>
            <h3>Point list and book</h3>
            <dl className="kv">
              <div>
                <dt>in_flood</dt>
                <dd>{point.in_flood}</dd>
              </div>
              <div>
                <dt>dist_m_to_flood</dt>
                <dd>{point.dist_m_to_flood}</dd>
              </div>
              <div>
                <dt>in_footprint within {DRILLDOWN_RADIUS_KM} km</dt>
                <dd>{nearby.length}</dd>
              </div>
              <div>
                <dt>sum insured within {DRILLDOWN_RADIUS_KM} km</dt>
                <dd>{formatEur(nearbySum)}</dd>
              </div>
            </dl>
            <p className="note">Nearby sums use exposure_join.in_footprint. The portfolio is synthetic.</p>
          </>
        )}
        <div className="table-wrap">
          <table>
            <caption>
              {statusLabel(desk.discharge.origin)} discharge rows for{" "}
              {desk.pointId}
            </caption>
            <thead>
              <tr>
                <th>point_id</th>
                <th>date</th>
                <th>discharge_m3s</th>
                <th>source</th>
              </tr>
            </thead>
            <tbody>
              {series.map((item) => (
                <tr key={`${item.point_id}-${item.date}`} className={item.date === desk.date ? "is-selected" : undefined}>
                  <td>{item.point_id}</td>
                  <td>{item.date}</td>
                  <td>{formatM3s(item.discharge_m3s)}</td>
                  <td>{item.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
