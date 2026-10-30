import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { escapeHtml, GAUGE_BOUNDS, gaugesLabel, isLiveGauge, type GaugeStatus, type GaugeSummary } from "../lib/gauges";
import type { GaugeState } from "../hooks/useGaugeLevels";
import { formatHour } from "../lib/format";
import { statusLabel } from "../lib/origin";

import { MapShell, type Bounds } from "./map/MapShell";
import { statusPoint } from "./map/shellLogic";

const GAUGE_VIEW: Bounds = [
  [GAUGE_BOUNDS.south, GAUGE_BOUNDS.west],
  [GAUGE_BOUNDS.north, GAUGE_BOUNDS.east],
];

const LEGEND: { status: GaugeStatus; label: string }[] = [
  { status: "ok", label: "Below MHW" },
  { status: "near", label: "Near MHW" },
  { status: "over", label: "Above MHW (red, live only)" },
  { status: "unknown", label: "No threshold" },
];

export function MapLegend({ showNotLive }: { showNotLive: boolean }) {
  return (
    <ul className="map-legend" aria-label="Map legend">
      {LEGEND.map((item) => (
        <li key={item.status}>
          <span className={`map-legend__dot ${item.status === "over" ? "map-legend__dot--alert" : `map-legend__dot--${item.status}`}`} aria-hidden="true" />
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
  const [map, setMap] = useState<L.Map | null>(null);
  const placed = useMemo(() => gauges.filter((g) => g.lat !== null && g.lon !== null), [gauges]);
  const points3d = useMemo(
    () =>
      placed.map((g) =>
        statusPoint({ id: `${g.station}-${g.water}`, lat: g.lat as number, lon: g.lon as number, label: `${g.station} (${g.water}): ${Math.round(g.levelCm)} cm · ${gaugeBadge(g).text}${g.status === "unknown" ? " · no MHW threshold" : g.status === "over" ? " · above MHW" : ""}` }, g.status, isLiveGauge(g)),
      ),
    [placed],
  );

  useEffect(() => {
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    for (const g of placed) {
      const live = isLiveGauge(g);
      const circle = L.circleMarker([g.lat as number, g.lon as number], {
        radius: 7,
        className: `map-marker map-marker--${g.status}${live ? "" : " map-marker--sample"}${live && g.status === "over" ? " map-marker--alert" : ""}`,
        bubblingMouseEvents: false,
      });
      const tip = `${g.station} (${g.water}): ${Math.round(g.levelCm)} cm · ${formatHour(g.measuredAt)} · ${gaugeBadge(g).text}`;
      circle.bindTooltip(escapeHtml(tip), { direction: "top", offset: [0, -6] });
      layer.addLayer(circle);
    }
    return () => void layer.remove();
  }, [map, placed]);

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
      <MapShell
        ariaLabel="River gauges"
        attribution="Gauges: PEGELONLINE (WSV, DL-DE-Zero-2.0) via Zetaris"
        fit={{ bounds: GAUGE_VIEW, padding: 12 }}
        onMap2d={setMap}
        points3d={points3d}
        columnDeg={0.06}
      >
        {load.state !== "rows" && load.state !== "loading" && <p className="gauge-map__empty">No live gauge readings yet.</p>}
      </MapShell>
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
