import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { boundsOf } from "../../lib/events";
import {
  columnsGeoJson,
  failMapMode,
  flatGeoJson,
  readMapMode,
  writeMapMode,
  type ExtraPoint,
  type MapMode,
  type ShellPoint,
} from "./shellLogic";

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export type Bounds = [[number, number], [number, number]];

// One shared mode for every map on the page; persisted, 2D by default.
let mode: MapMode = readMapMode();
const listeners = new Set<() => void>();
function resetToTwoD() {
  mode = failMapMode();
}
function useMapMode(): [MapMode, (next: MapMode) => void] {
  const current = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => mode,
    (): MapMode => "2d",
  );
  return [
    current,
    (next) => {
      mode = next;
      writeMapMode(next);
      listeners.forEach((cb) => cb());
    },
  ];
}

export interface MapShellProps {
  ariaLabel: string;
  /** Data credit only; the OpenStreetMap credit is added here. */
  attribution: string;
  zoomSnap?: number;
  /** Initial view for 2D; a resize keeps refitting until the viewer touches the map. */
  fit?: { bounds: Bounds; padding: number };
  /** Initial 3D view when it differs from `fit` (default: `fit`, else the bounds of the points). */
  fit3d?: Bounds | null;
  /** 2D: the Leaflet map (null while 3D is shown or on unmount). Draw your own layers on it. */
  onMap2d?: (map: L.Map | null) => void;
  /** 3D: the same points as extruded columns, coloured by band. */
  points3d: readonly ShellPoint[];
  extra3d?: readonly ExtraPoint[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Column half side in degrees (about 0.0015 for a river reach, 0.08 for Europe). */
  columnDeg: number;
  /** Overlay inside the map frame, e.g. an empty-state message. */
  children?: ReactNode;
}

/** Shared map frame: OSM tiles, attribution, resize handling and a 2D / 3D toggle. 2D is Leaflet; 3D is MapLibre GL, loaded on demand. */
export function MapShell(props: MapShellProps) {
  const [current, setMode] = useMapMode();
  const [failed, setFailed] = useState(false);
  const use3d = current === "3d";
  return (
    <div className="gauge-map__frame">
      <div className="map-mode" role="group" aria-label="Map view">
        {(["2d", "3d"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`eu-sort${current === m ? " eu-sort--on" : ""}`}
            aria-pressed={current === m}
            onClick={() => {
              setFailed(false);
              setMode(m);
            }}
          >
            {m.toUpperCase()}
          </button>
        ))}
        {failed && current === "2d" && (
          <span className="muted small" role="status">
            3D did not start (WebGL, style or tiles failed); showing 2D.
          </span>
        )}
        {use3d && (
          <span className="muted small">
            Column height shows band order, not a measured value. Hover for status
            {props.onSelect ? "; for keyboard access use the point selector or list." : "."}
          </span>
        )}
      </div>
      {use3d ? <Map3D
          {...props}
          onFail={() => {
            resetToTwoD();
            setFailed(true);
            listeners.forEach((cb) => cb());
          }}
        /> : <Map2D {...props} />}
      {props.children}
    </div>
  );
}

function Map2D({ ariaLabel, attribution, zoomSnap = 1, fit, onMap2d }: MapShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onMap2d);
  cb.current = onMap2d;
  const fitRef = useRef(fit);
  fitRef.current = fit;

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const map = L.map(container, { zoomSnap, attributionControl: false, scrollWheelZoom: false });
    L.control
      .attribution({ prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' })
      .addAttribution(`${TILE_ATTRIBUTION} · ${attribution}`)
      .addTo(map);
    L.tileLayer(TILE_URL, { maxZoom: 18 }).addTo(map);
    let touched = false;
    const doFit = () => {
      const f = fitRef.current;
      if (f) map.fitBounds(f.bounds, { padding: [f.padding, f.padding] });
    };
    doFit();
    // Once the user zooms or drags, a resize keeps their view.
    const touch = () => (touched = true);
    for (const type of ["pointerdown", "wheel", "keydown"]) container.addEventListener(type, touch, { once: true });
    const resize = new ResizeObserver(() => {
      map.invalidateSize();
      if (!touched) doFit();
    });
    resize.observe(container);
    cb.current?.(map);
    return () => {
      resize.disconnect();
      cb.current?.(null);
      map.remove();
    };
  }, [zoomSnap, attribution]);

  return <div ref={ref} className="leaflet-map" role="region" aria-label={ariaLabel} />;
}

const FALLBACK_VIEW: Bounds = [
  [35, -10],
  [60, 25],
];

function Map3D(props: MapShellProps & { onFail: () => void }) {
  const { ariaLabel, attribution, fit, fit3d, points3d, extra3d, selectedId, onSelect, columnDeg, onFail } = props;
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const onSelectSet = useRef(!!onSelect);
  onSelectSet.current = !!onSelect;
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const view = fit3d ?? fit?.bounds ?? boundsOf(points3d) ?? FALLBACK_VIEW;
  const viewKey = JSON.stringify(view);

  useEffect(() => {
    let dead = false;
    let map: MlMap | null = null;
    let loaded = false;
    (async () => {
      try {
        const [ml] = await Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]);
        const container = ref.current;
        if (dead || !container) return;
        map = new ml.Map({
          container,
          attributionControl: false,
          cooperativeGestures: true,
          pitch: 55,
          bearing: -12,
          style: {
            version: 8,
            sources: { osm: { type: "raster", tiles: [TILE_URL], tileSize: 256, maxzoom: 18 } },
            layers: [{ id: "osm", type: "raster", source: "osm" }],
          },
        });
        map.addControl(new ml.AttributionControl({ customAttribution: `${TILE_ATTRIBUTION} · ${attribution}` }));
        map.addControl(new ml.NavigationControl({ visualizePitch: true }), "top-left");
        const loadTimer = window.setTimeout(() => !loaded && !dead && failRef.current(), 15000);
        map.on("error", () => !loaded && !dead && failRef.current());
        const popup = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
        map.on("load", () => {
          if (dead || !map) return;
          const empty = { type: "FeatureCollection" as const, features: [] };
          map.addSource("columns", { type: "geojson", data: empty });
          map.addSource("extra", { type: "geojson", data: empty });
          map.addLayer({ id: "extra", type: "circle", source: "extra", paint: { "circle-radius": 3, "circle-color": "#3a5a8c", "circle-opacity": 0.8 } });
          map.addLayer({
            id: "columns",
            type: "fill-extrusion",
            source: "columns",
            paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-opacity": 0.88 },
          });
          map.on("click", "columns", (e: MapLayerMouseEvent) => {
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === "string") selectRef.current?.(id);
          });
          map.on("mousemove", "columns", () => (map!.getCanvas().style.cursor = onSelectSet.current ? "pointer" : ""));
          map.on("mouseleave", "columns", () => (map!.getCanvas().style.cursor = ""));
          map.addSource("flat", { type: "geojson", data: empty });
          map.addLayer({ id: "flat", type: "circle", source: "flat", paint: { "circle-radius": 4, "circle-color": ["get", "color"], "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" } });
          for (const layerId of ["columns", "flat", "extra"]) {
            map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
              const label = e.features?.[0]?.properties?.label;
              if (typeof label === "string") popup.setLngLat(e.lngLat).setText(label).addTo(map!);
            });
            map.on("mouseleave", layerId, () => popup.remove());
          }
          loaded = true;
          window.clearTimeout(loadTimer);
          mapRef.current = map;
          setReady(true);
        });
      } catch {
        if (!dead) failRef.current();
      }
    })();
    return () => {
      dead = true;
      setReady(false);
      mapRef.current = null;
      map?.remove();
    };
  }, [attribution]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("columns") as { setData(d: unknown): void } | undefined)?.setData(columnsGeoJson(points3d, selectedId, columnDeg));
    (map.getSource("flat") as { setData(d: unknown): void } | undefined)?.setData(flatGeoJson(points3d));
  }, [ready, points3d, selectedId, columnDeg]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features = (extra3d ?? []).map((p) => ({
      type: "Feature" as const,
      properties: { id: p.id, label: p.label ?? p.id },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    }));
    (map.getSource("extra") as { setData(d: unknown): void } | undefined)?.setData({ type: "FeatureCollection", features });
  }, [ready, extra3d]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.fitBounds(
      [
        [view[0][1], view[0][0]],
        [view[1][1], view[1][0]],
      ],
      { padding: 40, maxZoom: 13, pitch: 55, bearing: -12, duration: 0 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewKey]);

  return <div ref={ref} className="leaflet-map" role="region" aria-label={`${ariaLabel} (3D view)`} />;
}
