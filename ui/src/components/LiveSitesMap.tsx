import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConsole } from "../context/ConsoleContext";
import { LiveHealthNote } from "./ModeSwitch";
import { useInsurerWatch } from "../hooks/useInsurerWatch";
import { EU_WATCH_BOUNDS, type WatchSource } from "../lib/euWatch";
import { escapeHtml } from "../lib/gauges";
import { statusView } from "../lib/places";
import { countsText, hhmm, monitorView } from "../lib/alertMonitor";
import { statusLabel } from "../lib/origin";
import { DEMO_BOOK_LINE } from "../lib/nearest";
import type { ExposureJoinRow } from "../types/views";
import "../styles/insurer.css";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

/** The Europe live view of Sites / map: every live watch source and the insured sites layer. */
export function LiveSitesPanel() {
  const desk = useConsole();
  const watch = useInsurerWatch();
  const [showSites, setShowSites] = useState(true);
  const note = useId();
  const sites = showSites ? desk.exposure.rows : NO_SITES;
  const view = monitorView({ ...watch, valencia: watch.valencia, state: watch.state, checkedAt: watch.checkedAt });
  const gauges = watch.sources.filter((s) => s.kind === "gauge").length;

  return (
    <section className="card map-card" aria-labelledby="live-sites-title">
      <div className="card-head">
        <div>
          <p className="section-label">Map · Europe live watch</p>
          <h2 id="live-sites-title">Watched rivers and insured sites</h2>
        </div>
        <label className="check">
          <input type="checkbox" checked={showSites} aria-describedby={note} onChange={(e) => setShowSites(e.target.checked)} />
          Insured sites
        </label>
      </div>
      <LiveHealthNote live={watch.live} />
      <p className="demo-book" id={note}>
        {DEMO_BOOK_LINE}
      </p>
      <p className={`monitor__headline monitor__headline--${view.kind}`} role="status">
        {view.text}
      </p>
      <LiveMap sources={watch.sources} sites={sites} />
      <ul className="map-legend live-legend" aria-label="Map legend">
        <li>
          <span className="map-legend__dot map-legend__dot--ok" aria-hidden="true" /> Normal
        </li>
        <li>
          <span className="map-legend__dot map-legend__dot--near" aria-hidden="true" /> Close to mean high water / Watch (model)
        </li>
        <li>
          <span className="map-legend__dot map-legend__dot--over" aria-hidden="true" /> Above mean high water (gauge) · Elevated (model): both amber, never red
        </li>
        <li>
          <span className="map-legend__dot map-legend__dot--unknown" aria-hidden="true" /> No reading
        </li>
        <li>
          <span className="live-legend__site" aria-hidden="true" /> insured site ({statusLabel(desk.exposure.origin)}, synthetic)
        </li>
      </ul>
      <p className="note">
        Circles: {gauges} PEGELONLINE gauges, level against the long-term MHW. Diamonds: {watch.sources.filter((s) => s.kind === "model").length} GloFAS model points, a model
        band and not an official warning. Squares: {watch.valencia.length} Valencia demo points against their own recent flow (not official). That is {countsText(gauges + watch.sources.filter((s) => s.kind === "model").length, watch.valencia.length)}. Dashed: not live (stale or seed).
        {watch.checkedAt !== null ? ` Checked ${hhmm(watch.checkedAt)}.` : ""} Switch to Past flood in the header to replay one.
      </p>
    </section>
  );
}

const NO_SITES: ExposureJoinRow[] = [];

function LiveMap({ sources, sites }: { sources: WatchSource[]; sites: readonly ExposureJoinRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceLayer = useRef<L.LayerGroup | null>(null);
  const siteLayer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, { zoomSnap: 0.5, attributionControl: false, scrollWheelZoom: false });
    L.control
      .attribution({ prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' })
      .addAttribution(`${TILE_ATTRIBUTION} · Gauges: PEGELONLINE (WSV, DL-DE-Zero-2.0) · Model: Open-Meteo.com (GloFAS, CC BY 4.0) via Zetaris`)
      .addTo(map);
    L.tileLayer(TILE_URL, { maxZoom: 18 }).addTo(map);
    siteLayer.current = L.layerGroup().addTo(map);
    sourceLayer.current = L.layerGroup().addTo(map);
    let touched = false;
    const fit = () =>
      map.fitBounds(
        [
          [EU_WATCH_BOUNDS.south, EU_WATCH_BOUNDS.west],
          [EU_WATCH_BOUNDS.north, EU_WATCH_BOUNDS.east],
        ],
        { padding: [8, 8] },
      );
    fit();
    const touch = () => (touched = true);
    for (const type of ["pointerdown", "wheel", "keydown"]) container.addEventListener(type, touch, { once: true });
    const resize = new ResizeObserver(() => {
      map.invalidateSize();
      if (!touched) fit();
    });
    resize.observe(container);
    return () => {
      resize.disconnect();
      map.remove();
      sourceLayer.current = null;
      siteLayer.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = sourceLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const s of sources) {
      const cls = `map-marker map-marker--${s.status}${s.live ? "" : " map-marker--sample"}`;
      const marker =
        s.kind === "gauge"
          ? L.circleMarker([s.lat, s.lon], { radius: 6, className: cls, bubblingMouseEvents: false })
          : L.marker([s.lat, s.lon], {
              icon: L.divIcon({ className: `eu-model-icon eu-model-icon--${s.kind} eu-tone--${statusView(s.kind, s.status).tone}${s.live ? "" : " eu-model-icon--sample"}`, iconSize: [14, 14] }),
              keyboard: true,
              title: `${s.river} at ${s.name}`,
            });
      const kind = s.kind === "gauge" ? "PEGELONLINE gauge" : "GloFAS model";
      marker.bindTooltip(escapeHtml(`${s.river} · ${s.name} (${s.country}) · ${kind}: ${s.value} · ${statusView(s.kind, s.status).word}${s.live ? "" : " · not live"}`), {
        direction: "top",
        offset: [0, -6],
      });
      layer.addLayer(marker);
    }
  }, [sources]);

  // Sites are many (hundreds): one small canvas-free circle each, no tooltip text beyond id and segment.
  const siteRows = useMemo(() => sites.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), [sites]);
  useEffect(() => {
    const layer = siteLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const row of siteRows) {
      const dot = L.circleMarker([row.lat, row.lon], { radius: 3, className: "exposure-site", bubblingMouseEvents: false });
      dot.bindTooltip(escapeHtml(`${row.policy_id} · ${row.segment} (synthetic)`), { direction: "top" });
      layer.addLayer(dot);
    }
  }, [siteRows]);

  return (
    <div className="gauge-map__frame">
      <div ref={containerRef} className="leaflet-map" role="region" aria-label="Europe live watch and insured sites map" />
    </div>
  );
}
