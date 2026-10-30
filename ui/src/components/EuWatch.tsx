import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EuWatchLoad } from "../api/euWatch";
import { useConsole } from "../context/ConsoleContext";
import { EU_WATCH_BOUNDS, sortSources, type SortKey, type WatchSource } from "../lib/euWatch";
import { escapeHtml, type GaugeStatus } from "../lib/gauges";
import { TILE_ATTRIBUTION, TILE_URL } from "./GaugeMap";
import { basisLabel, statusView } from "../lib/places";

const STATUS_TEXT: Record<GaugeStatus, string> = { ok: "below", near: "near", over: "above", unknown: "unknown" };
const SORTS: { key: SortKey; label: string }[] = [
  { key: "status", label: "Risk" },
  { key: "river", label: "River" },
  { key: "name", label: "Place" },
  { key: "country", label: "Country" },
];

function ask(openAsk: ReturnType<typeof useConsole>["openAsk"], s: WatchSource) {
  openAsk(s.question, { page: "now", place: s.name });
}

/** One legend row: a shape in each tone the group uses, with its word. */
function LegendRow({ kind, statuses }: { kind: WatchSource["kind"]; statuses: GaugeStatus[] }) {
  return (
    <ul className="map-legend">
      {statuses.map((st) => {
        const v = statusView(kind, st);
        return (
          <li key={st}>
            <span className={`eu-shape eu-shape--${kind} eu-tone--${v.tone}`} aria-hidden="true" />
            {v.word}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Legend in three groups, so a gauge band is never read as a model band. Red is used only for a gauge at or
 * above its long-term mean high water; model bands are amber, the Valencia points amber or neutral.
 */
export function EuWatchLegend() {
  return (
    <div className="eu-legend" aria-label="Map legend">
      <div className="eu-legend__group">
        <span className="eu-legend__title">Circles · river gauges (PEGELONLINE, measured)</span>
        <span className="muted small">
          Level vs the station's MHW, the long-term mean high water (not a warning level). Watch: within 25 % of the
          MW..MHW span below MHW.
        </span>
        <LegendRow kind="gauge" statuses={["ok", "near", "over", "unknown"]} />
      </div>
      <div className="eu-legend__group">
        <span className="eu-legend__title">Diamonds · GloFAS model points</span>
        <span className="muted small">7-day forecast max vs the past-30-day median (Elevated: at least 2×). Model, not an official warning</span>
        <LegendRow kind="model" statuses={["ok", "near", "over"]} />
      </div>
      <div className="eu-legend__group">
        <span className="eu-legend__title">Squares · Valencia model points (GloFAS)</span>
        <span className="muted small">Now and next 48 h vs the point's own past three days (2x and 4x its median). Not official</span>
        <LegendRow kind="valencia" statuses={["ok", "near", "over"]} />
      </div>
      <p className="muted small">Dashed or faded marker: not a fresh live reading (stale or seed).</p>
    </div>
  );
}

/** All live-watch sources on one Leaflet map. Clicking a marker pre-fills Ask FloodSense. */
export function EuWatchMap({ sources }: { sources: WatchSource[] }) {
  const { openAsk } = useConsole();
  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const askRef = useRef(openAsk);
  askRef.current = openAsk;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, { zoomSnap: 0.5, attributionControl: false, scrollWheelZoom: false });
    L.control
      .attribution({ prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' })
      .addAttribution(
        `${TILE_ATTRIBUTION} · Gauges: PEGELONLINE (WSV, DL-DE-Zero-2.0) · Model: Open-Meteo.com (GloFAS, CC BY 4.0) via Zetaris`,
      )
      .addTo(map);
    L.tileLayer(TILE_URL, { maxZoom: 18 }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
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
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const s of sources) {
      const cls = `map-marker map-marker--${s.status}${s.live ? "" : " map-marker--sample"}`;
      const marker =
        s.kind === "gauge"
          ? L.circleMarker([s.lat, s.lon], { radius: 6, className: cls, bubblingMouseEvents: false })
          : L.marker([s.lat, s.lon], {
              icon: L.divIcon({
                className: `eu-model-icon eu-model-icon--${s.kind} eu-tone--${statusView(s.kind, s.status).tone}${s.live ? "" : " eu-model-icon--sample"}`,
                iconSize: [14, 14],
              }),
              keyboard: true,
              title: s.river ? `${s.river} at ${s.name}` : s.name,
            });
      const kind = s.kind === "gauge" ? "PEGELONLINE gauge" : "GloFAS model";
      const where = s.river ? `${s.river} · ${s.name}` : s.name;
      const tip = `${where} (${s.country}) · ${statusView(s.kind, s.status).word} · ${kind}, ${basisLabel(s.kind)}${s.live ? "" : " · not live"} · click to ask`;
      marker.bindTooltip(escapeHtml(tip), { direction: "top", offset: [0, -6] });
      marker.on("click", () => ask(askRef.current, s));
      layer.addLayer(marker);
    }
  }, [sources]);

  return (
    <div className="gauge-map__frame">
      <div ref={containerRef} className="leaflet-map" role="region" aria-label={`Europe live watch map, ${sources.length} sources. The same places are listed below.`} />
    </div>
  );
}

/** Compact sortable list. Every row is a button that pre-fills Ask FloodSense. */
export function EuWatchList({ sources }: { sources: WatchSource[] }) {
  const { openAsk } = useConsole();
  const [sort, setSort] = useState<SortKey>("status");
  const sorted = useMemo(() => sortSources(sources, sort), [sources, sort]);
  return (
    <div className="eu-list">
      <div className="eu-list__sort" role="group" aria-label="Sort sources">
        <span className="muted small">Sort:</span>
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`eu-sort${sort === s.key ? " eu-sort--on" : ""}`}
            aria-pressed={sort === s.key}
            onClick={() => setSort(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="eu-list__rows">
        {sorted.map((s) => (
          <li key={s.id}>
            <button type="button" className={`eu-row eu-row--${s.status}`} onClick={() => ask(openAsk, s)} title={s.question}>
              <span className={`eu-shape eu-shape--${s.kind} eu-tone--${statusView(s.kind, s.status).tone}`} aria-hidden="true" />
              <span className="eu-row__place">
                {s.river ? (
                  <>
                    <strong>{s.river}</strong> · {s.name}
                  </>
                ) : (
                  <strong>{s.name}</strong>
                )}{" "}
                <span className="muted small">{s.country}</span>
              </span>
              <span className="eu-row__value muted small">{s.value}</span>
              <span className="eu-row__band small">
                {s.kind === "gauge" ? "gauge vs MHW" : "model"}: {STATUS_TEXT[s.status]}
                {s.live ? "" : " · not live"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EuWatchSection({ sources, model }: { sources: WatchSource[]; model: EuWatchLoad }) {
  const gauges = sources.filter((s) => s.kind === "gauge").length;
  const points = sources.length - gauges;
  return (
    <section className="now-region" aria-labelledby="now-eu">
      <div className="now-region-head">
        <h3 className="now-subtitle" id="now-eu">
          Europe · live watch
        </h3>
        <span className="muted small">
          {gauges} PEGELONLINE gauges · {points} GloFAS points
          {model.queryId ? ` · Zetaris query ${model.queryId.slice(0, 8)}` : ""}
        </span>
      </div>
      <p className="now-note">
        Circles are measured water levels against each station's long-term mean high water (MHW, not a warning level). Diamonds are GloFAS model
        discharge banded against each point's own recent series: a model, not an official warning. Click any source to ask
        about it.
      </p>
      {model.state === "unavailable" && <p className="note">GloFAS points unavailable: {model.detail}</p>}
      <EuWatchLegend />
      <EuWatchMap sources={sources} />
      <EuWatchList sources={sources} />
      <p className="now-source">Quelle: WSV, PEGELONLINE · Weather data by Open-Meteo.com (GloFAS, CC BY 4.0)</p>
    </section>
  );
}
