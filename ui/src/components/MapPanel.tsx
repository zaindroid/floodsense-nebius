import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConsole } from "../context/ConsoleContext";
import { BAND_ELEVATED_M3S, BAND_TYPICAL_M3S, SIMULATED_ALERT_M3S } from "../config/scenario";
import { formatDay } from "../lib/format";
import { escapeHtml } from "../lib/gauges";
import { statusLabel } from "../lib/origin";
import { datesOf, dischargeBand, rowsOnDate } from "../lib/series";
import {
  ahrDischarge,
  ahrMapPoints,
  boundsOf,
  EVENT_META,
  pointPopupText,
  valenciaMapPoints,
  type EventId,
  type MapPoint,
} from "../lib/events";
import type { ExposureJoinRow } from "../types/views";
import { LiveSitesPanel } from "./LiveSitesMap";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const AHR_ROWS = ahrDischarge();
const AHR_DATES = datesOf(AHR_ROWS);
const AHR_POINTS = ahrMapPoints();
const NO_EXPOSURE: ExposureJoinRow[] = [];

/**
 * Insurer Sites / map follows the global mode: Live is the Europe view (every live watch source plus the insured sites
 * layer); Past flood is the chosen event's replay map. `fixedEvent` pins the map to one event (the citizen My area page reads the
 * Valencia views only) and never shows the live view.
 */
export function MapPanel({ exposureDefault, fixedEvent }: { exposureDefault: boolean; fixedEvent?: EventId }) {
  const desk = useConsole();
  if (!fixedEvent && desk.mode === "live") return <LiveSitesPanel />;
  return <EventMapPanel exposureDefault={exposureDefault} fixedEvent={fixedEvent} />;
}

/** Leaflet + OpenStreetMap map of the selected event's points, with the replay date slider. */
function EventMapPanel({ exposureDefault, fixedEvent }: { exposureDefault: boolean; fixedEvent?: EventId }) {
  const desk = useConsole();
  const eventId = fixedEvent ?? desk.eventId;
  const ahr = eventId === "EMSR517";
  const [showExposure, setShowExposure] = useState(exposureDefault);
  const { ahrDate, setAhrDate, ahrPointId, setAhrPointId } = desk;
  const exposureNote = useId();

  const points = useMemo(() => (ahr ? AHR_POINTS : valenciaMapPoints(desk.points)), [ahr, desk.points]);
  const rows = ahr ? AHR_ROWS : desk.discharge.rows;
  const dates = ahr ? AHR_DATES : desk.dates;
  const date = ahr ? ahrDate : desk.date;
  const pointId = ahr ? ahrPointId : desk.pointId;
  const selectPoint = ahr ? setAhrPointId : desk.setPointId;
  const exposure = useMemo(
    () => (ahr || !showExposure ? NO_EXPOSURE : desk.exposure.rows.filter((row) => row.in_footprint)),
    [ahr, showExposure, desk.exposure.rows],
  );
  const origin = ahr
    ? "seed rows (floodsense_seed, Open-Meteo GloFAS)"
    : desk.discharge.origin === "live"
      ? "Zetaris discharge_daily, replay rows"
      : statusLabel(desk.discharge.origin);

  const rowsToday = useMemo(() => rowsOnDate(rows, date), [rows, date]);
  const byPoint = useMemo(() => new Map(rowsToday.map((row) => [row.point_id, row.discharge_m3s])), [rowsToday]);
  const peakCount = rowsToday.filter((row) => row.discharge_m3s >= SIMULATED_ALERT_M3S).length;
  const dateIndex = Math.max(0, dates.indexOf(date));
  const selected = points.find((p) => p.point_id === pointId);
  const selectedValue = selected ? (byPoint.get(selected.point_id) ?? null) : null;

  const setDate = (next: string) => {
    if (ahr) {
      setAhrDate(next);
      return;
    }
    desk.stopSimulation();
    desk.setDate(next);
  };

  return (
    <section className="card map-card" aria-label={`${EVENT_META[eventId].region} points`}>
      <div className="card-head">
        <div>
          <p className="section-label">
            Map · {EVENT_META[eventId].short}
          </p>
          <h2>Points on {formatDay(date)}</h2>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={showExposure && !ahr}
            disabled={ahr}
            aria-describedby={ahr ? exposureNote : undefined}
            onChange={(event) => setShowExposure(event.target.checked)}
          />
          Exposed sites
        </label>
      </div>
      {ahr && (
        <p className="note" id={exposureNote}>
          Exposed sites are off: no insured book is loaded for Ahr 2021.
        </p>
      )}
      <div className="toolbar">
        <label className="field">
          Point
          <select value={pointId} onChange={(event) => selectPoint(event.target.value)}>
            {points.map((point) => (
              <option key={point.point_id} value={point.point_id}>
                {point.point_id} · {point.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <EventMap
        eventId={eventId}
        points={points}
        values={byPoint}
        date={date}
        selectedId={pointId}
        onSelect={selectPoint}
        exposure={exposure}
      />
      <div className="slider-block">
        <div className="slider-labels">
          <span>Replay date</span>
          <strong>{formatDay(date)}</strong>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(dates.length - 1, 0)}
          step={1}
          value={dates.length === 0 ? 0 : dateIndex}
          aria-label="Replay date"
          aria-valuetext={formatDay(date)}
          disabled={dates.length === 0}
          onChange={(event) => {
            const next = dates[Number(event.target.value)];
            if (next) setDate(next);
          }}
        />
        <div className="slider-scale">
          <span>{dates[0] ? formatDay(dates[0]) : ""}</span>
          <span>{dates.at(-1) ? formatDay(dates.at(-1) ?? "") : ""}</span>
        </div>
      </div>
      <ul className="legend">
        <li><i data-band="low" /> under {BAND_TYPICAL_M3S} m³/s</li>
        <li><i data-band="typical" /> {BAND_TYPICAL_M3S}–{BAND_ELEVATED_M3S}</li>
        <li><i data-band="elevated" /> {BAND_ELEVATED_M3S}–{SIMULATED_ALERT_M3S}</li>
        <li><i data-band="peak" /> ≥ {SIMULATED_ALERT_M3S}</li>
        {!ahr && <li><i className="dot-sample" /> in_footprint</li>}
      </ul>
      {ahr && selected && (
        <p className="note" aria-live="polite">
          {pointPopupText(selected, selectedValue, formatDay(date))}.
        </p>
      )}
      <p className="note">
        Marker colour is modelled discharge_m3s (GloFAS daily) from {origin}. Labels are the point's place; open a marker for its
        code and value.
        {peakCount > 0 ? ` ${peakCount} point${peakCount === 1 ? "" : "s"} in the peak band this day.` : ""}
      </p>
    </section>
  );
}

function EventMap({
  eventId,
  points,
  values,
  date,
  selectedId,
  onSelect,
  exposure,
}: {
  eventId: EventId;
  points: MapPoint[];
  values: Map<string, number>;
  date: string;
  selectedId: string;
  onSelect: (pointId: string) => void;
  exposure: ExposureJoinRow[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pointsLayer = useRef<L.LayerGroup | null>(null);
  const exposureLayer = useRef<L.LayerGroup | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, { zoomSnap: 1, attributionControl: false, scrollWheelZoom: false });
    L.control
      .attribution({ prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' })
      .addAttribution(`${TILE_ATTRIBUTION} · Discharge: GloFAS via Open-Meteo (CC BY 4.0)`)
      .addTo(map);
    L.tileLayer(TILE_URL, { maxZoom: 18 }).addTo(map);
    exposureLayer.current = L.layerGroup().addTo(map);
    pointsLayer.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(container);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
      pointsLayer.current = null;
      exposureLayer.current = null;
    };
  }, []);

  // Fit to the event's points whenever the event (or its point list) changes.
  useEffect(() => {
    const bounds = boundsOf(points);
    if (mapRef.current && bounds) mapRef.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }, [eventId, points]);

  // Markers are built once per point list, so a click (which changes the selection) keeps its popup open.
  const markers = useRef(new Map<string, L.Marker>());
  useEffect(() => {
    const layer = pointsLayer.current;
    if (!layer) return;
    layer.clearLayers();
    markers.current.clear();
    for (const point of points) {
      const marker = L.marker([point.lat, point.lon], {
        keyboard: true,
        riseOnHover: true,
        icon: L.divIcon({
          className: "site-pin",
          html: '<span class="site-pin__dot" data-band="low" data-selected="false"></span>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
      });
      marker.bindTooltip(escapeHtml(point.label), { permanent: true, direction: "right", offset: [10, 0], className: "site-label" });
      marker.bindPopup("");
      marker.on("click", () => selectRef.current(point.point_id));
      layer.addLayer(marker);
      markers.current.set(point.point_id, marker);
    }
  }, [points]);

  // Values and selection only restyle the existing markers.
  useEffect(() => {
    for (const point of points) {
      const marker = markers.current.get(point.point_id);
      if (!marker) continue;
      const m3s = values.get(point.point_id) ?? null;
      const band = m3s === null ? "low" : dischargeBand(m3s);
      const selected = point.point_id === selectedId;
      const text = pointPopupText(point, m3s, formatDay(date));
      const el = marker.getElement();
      const dot = el?.querySelector(".site-pin__dot");
      if (!el || !dot) {
        marker.setIcon(
          L.divIcon({
            className: "site-pin",
            html: `<span class="site-pin__dot" data-band="${band}" data-selected="${selected}"></span>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        );
      } else {
        dot.setAttribute("data-band", band);
        dot.setAttribute("data-selected", String(selected));
      }
      const icon = marker.getElement();
      if (icon) {
        icon.setAttribute("aria-label", text);
        icon.setAttribute("title", text);
        icon.setAttribute("role", "button");
        icon.setAttribute("aria-pressed", String(selected));
      }
      marker.setZIndexOffset(selected ? 1000 : 0);
      marker.getTooltip()?.getElement()?.classList.toggle("is-selected", selected);
      marker.setPopupContent(escapeHtml(text));
    }
  }, [points, values, date, selectedId]);

  useEffect(() => {
    const layer = exposureLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const row of exposure) {
      const dot = L.circleMarker([row.lat, row.lon], { radius: 3, className: "exposure-site", bubblingMouseEvents: false });
      dot.bindTooltip(escapeHtml(`${row.policy_id} · ${row.segment}`), { direction: "top" });
      layer.addLayer(dot);
    }
  }, [exposure]);

  return (
    <div className="gauge-map__frame">
      <div ref={containerRef} className="leaflet-map" role="region" aria-label={`Map of ${EVENT_META[eventId].region} points`} />
    </div>
  );
}
