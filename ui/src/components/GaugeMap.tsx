import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import { escapeHtml, GAUGE_BOUNDS, gaugesLabel, isLiveGauge, type GaugeStatus, type GaugeSummary } from "../lib/gauges";
import type { GaugeState } from "../hooks/useGaugeLevels";
import { formatHour } from "../lib/format";
import { statusLabel } from "../lib/origin";

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const LEGEND: { status: GaugeStatus; label: string }[] = [
  { status: "ok", label: "Below MHW" },
  { status: "near", label: "Near MHW" },
  { status: "over", label: "Above MHW" },
  { status: "unknown", label: "No threshold" },
];

export function MapLegend({ showNotLive }: { showNotLive: boolean }) {
  return (
    <ul className="map-legend" aria-label="Map legend">
      {LEGEND.map((item) => (
        <li key={item.status}>
          <span className={`map-legend__dot map-legend__dot--${item.status}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
      {showNotLive && (
        <li>
          <span className="map-legend__dot map-legend__dot--sample" aria-hidden="true" />
          Dashed = seed or stale reading
        </li>
      )}
    </ul>
  );
}

/** One badge per gauge: Live only for a live, fresh row. */
function gaugeBadge(g: GaugeSummary): { cls: string; text: string } {
  if (isLiveGauge(g)) return { cls: "chip--live", text: "Live" };
  if (g.origin !== "live") return { cls: "chip--sample", text: statusLabel(g.origin) };
  return { cls: "chip--stale", text: "Stale" };
}

const LOAD_CHIP: Record<string, string> = {
  Live: "chip--live",
  Stale: "chip--stale",
  Seed: "chip--sample",
  Fixture: "chip--sample",
};

/** River-gauge map. Markers come only from the gauge_levels view. */
export function GaugeMap({ load, gauges }: { load: GaugeState; gauges: GaugeSummary[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const placed = useMemo(() => gauges.filter((g) => g.lat !== null && g.lon !== null), [gauges]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, { zoomSnap: 1, attributionControl: false, scrollWheelZoom: false });
    L.control
      .attribution({ prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' })
      .addAttribution(`${TILE_ATTRIBUTION} · Gauges: PEGELONLINE (WSV, DL-DE-Zero-2.0) via Zetaris`)
      .addTo(map);
    L.tileLayer(TILE_URL, { maxZoom: 18 }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    let touched = false;
    const fit = () =>
      map.fitBounds(
        [
          [GAUGE_BOUNDS.south, GAUGE_BOUNDS.west],
          [GAUGE_BOUNDS.north, GAUGE_BOUNDS.east],
        ],
        { padding: [12, 12] },
      );
    fit();
    // Once the user zooms or drags, a resize keeps their view.
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
    for (const g of placed) {
      const live = isLiveGauge(g);
      const circle = L.circleMarker([g.lat as number, g.lon as number], {
        radius: 7,
        className: `map-marker map-marker--${g.status}${live ? "" : " map-marker--sample"}`,
        bubblingMouseEvents: false,
      });
      const tip = `${g.station} (${g.water}): ${Math.round(g.levelCm)} cm · ${formatHour(g.measuredAt)} · ${gaugeBadge(g).text}`;
      circle.bindTooltip(escapeHtml(tip), { direction: "top", offset: [0, -6] });
      layer.addLayer(circle);
    }
  }, [placed]);

  const unplaced = gauges.length - placed.length;
  const label = gaugesLabel(gauges);
  const chip =
    load.state === "loading"
      ? { cls: "", text: "Loading…" }
      : !label
        ? { cls: "", text: "No live readings" }
        : { cls: LOAD_CHIP[label], text: `${label} · via Zetaris` };
  return (
    <div className="gauge-map">
      <div className="gauge-map__toolbar">
        <MapLegend showNotLive={gauges.some((g) => !isLiveGauge(g))} />
        <span className={`chip ${chip.cls}`}>{chip.text}</span>
      </div>
      <div className="gauge-map__frame">
        <div ref={containerRef} className="leaflet-map" role="region" aria-label="River gauges" />
        {load.state !== "rows" && load.state !== "loading" && <p className="gauge-map__empty">No live gauge readings yet.</p>}
      </div>
      {unplaced > 0 && (
        <p className="note">
          {unplaced} {unplaced === 1 ? "gauge has" : "gauges have"} no known position and {unplaced === 1 ? "is" : "are"} listed
          only.
        </p>
      )}
      <p className="note">Colour compares the level with the station's MHW (mean high water). Not an official warning.</p>
    </div>
  );
}

const TREND_SYMBOL = { rising: "▲", steady: "▶", falling: "▼" } as const;

export function GaugeList({ load, gauges }: { load: GaugeState; gauges: GaugeSummary[] }) {
  if (load.state === "loading") return <p className="note">Reading gauges…</p>;
  if (gauges.length === 0) {
    return (
      <p className="note">
        No live gauge readings yet.
        {load.state === "unavailable" ? " The gauge view could not be reached." : ""}
      </p>
    );
  }
  return (
    <ul className="gauge-list gauge-list--scroll">
      {gauges.map((g) => {
        const badge = gaugeBadge(g);
        return (
          <li key={`${g.station}-${g.water}`} className={`gauge gauge--${g.status}`}>
            <div className="gauge__head">
              <div>
                <strong>{g.station}</strong>
                <span className="muted small">{g.water}</span>
              </div>
              {g.trend && (
                <span className={`trend trend--${g.trend}`}>
                  {TREND_SYMBOL[g.trend]} {g.trend}
                </span>
              )}
            </div>
            <div className="gauge__value">
              {Math.round(g.levelCm)}
              <small> cm</small>
            </div>
            {g.warningLevelCm !== null && g.warningLevelCm > 0 && (
              <div className="gauge__bar" aria-label={`${Math.round((g.levelCm / g.warningLevelCm) * 100)}% of MHW`}>
                <span style={{ width: `${Math.min(100, (g.levelCm / g.warningLevelCm) * 100)}%` }} />
              </div>
            )}
            <div className="gauge__foot muted small">
              <span>
                {g.meanLevelCm !== null && `MW ${Math.round(g.meanLevelCm)} cm · `}
                MHW {g.warningLevelCm === null ? "not loaded" : `${Math.round(g.warningLevelCm)} cm`} · measured{" "}
                {formatHour(g.measuredAt)}
              </span>
              <span className={`chip ${badge.cls}`}>{badge.text}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
