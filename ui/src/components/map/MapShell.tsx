import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import "../../styles/map3d.css";
import { boundsOf } from "../../lib/events";
import { DIAL_ZOOM, gaugePinEl } from "./gaugePin";
import {
  focusBounds,
  type Bounds,
  failMapMode,
  readMapMode,
  writeMapMode,
  type ExtraPoint,
  type MapMode,
  type ShellPoint,
} from "./shellLogic";

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
/** Free Terrarium elevation tiles (AWS Open Data, no key) for the 3D relief. */
const DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** Free vector tiles (OpenFreeMap, OpenMapTiles schema, no key) for the animated rivers and lakes. */
const WATER_URL = "https://tiles.openfreemap.org/planet";
/** Dash patterns that, played in order, make a line look like it flows. */
const FLOW_FRAMES = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export type { Bounds };

// One shared mode for every map on the page; persisted, 2D by default.
let mode: MapMode = readMapMode();
const listeners = new Set<() => void>();
function resetToTwoD(keep?: boolean) {
  mode = keep ? "2d" : failMapMode();
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
  /** Ids of the points to fly to (e.g. the gauges of the selected river). Empty or unknown ids: full view. A "Show full view" button resets it. */
  focusIds?: readonly string[];
  onSelect?: (id: string) => void;
  /** Column half side in degrees (about 0.0015 for a river reach, 0.08 for Europe). */
  columnDeg: number;
  /** Embed only: how long 3D may take to load (default 15000 ms), and whether a failure is kept out of storage so the next load retries 3D. */
  loadTimeoutMs?: number;
  retry3dOnFail?: boolean;
  /** Overlay inside the map frame, e.g. an empty-state message. */
  children?: ReactNode;
}

/** Shared map frame: OSM tiles, attribution, resize handling and a 2D / 3D toggle. 2D is Leaflet; 3D is MapLibre GL, loaded on demand. */
export function MapShell(props: MapShellProps) {
  const [current, setMode] = useMapMode();
  const [failed, setFailed] = useState(false);
  const use3d = current === "3d";
  const focusKey = (props.focusIds ?? []).join("|");
  const [dismissed, setDismissed] = useState("");
  const focus = focusKey && dismissed !== focusKey ? focusBounds(props.points3d, props.focusIds) : null;
  const shown = { ...props, focus };
  useEffect(() => {
    if (!focusKey) setDismissed(""); // picking the same river again flies in again
  }, [focusKey]);
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
        {focus && (
          <button type="button" className="eu-sort" onClick={() => setDismissed(focusKey)}>
            Show full view
          </button>
        )}
        {failed && current === "2d" && (
          <span className="muted small" role="status">
            3D did not start (WebGL, style or tiles failed); showing 2D.
          </span>
        )}
        {use3d && (
          <span className="muted small">
            Pin colour shows the band; the dial fill shows relative band order, not a measured value; relief is exaggerated. Zoom in to open
            the dial. Tab to a pin for its status{props.onSelect ? " and press Enter to select it." : "."}
          </span>
        )}
      </div>
      {use3d ? <Map3D
          {...shown}
          onFail={() => {
            resetToTwoD(props.retry3dOnFail);
            setFailed(true);
            listeners.forEach((cb) => cb());
          }}
        /> : <Map2D {...shown} />}
      {props.children}
    </div>
  );
}

type Shown = MapShellProps & { focus: Bounds | null };

function Map2D({ ariaLabel, attribution, zoomSnap = 1, fit, onMap2d, focus }: Shown) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const focusKey = JSON.stringify(focus);
  const wasFocused = useRef(false);
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
      if (f && !wasFocused.current) map.fitBounds(f.bounds, { padding: [f.padding, f.padding] });
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
    mapRef.current = map;
    return () => {
      resize.disconnect();
      cb.current?.(null);
      mapRef.current = null;
      map.remove();
    };
  }, [zoomSnap, attribution]);

  // Fly to the focused gauges; when the focus goes away, fly back to the full view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (focus) {
      wasFocused.current = true;
      map.flyToBounds(focus, { padding: [40, 40], maxZoom: 14, duration: 1.2 });
    } else if (wasFocused.current) {
      wasFocused.current = false;
      if (fitRef.current) map.flyToBounds(fitRef.current.bounds, { padding: [fitRef.current.padding, fitRef.current.padding], duration: 1.2 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  return <div ref={ref} className="leaflet-map" role="region" aria-label={ariaLabel} />;
}

const FALLBACK_VIEW: Bounds = [
  [35, -10],
  [60, 25],
];

function Map3D(props: Shown & { onFail: () => void }) {
  const { ariaLabel, attribution, fit, fit3d, points3d, extra3d, selectedId, onSelect, onFail, focus } = props;
  const wasFocused = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const markers = useRef<{ remove(): void }[]>([]);
  const pinEls = useRef(new Map<string, HTMLElement>());
  const mlRef = useRef<typeof import("maplibre-gl") | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const onSelectSet = useRef(!!onSelect);
  onSelectSet.current = !!onSelect;
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const view = fit3d ?? fit?.bounds ?? boundsOf(points3d) ?? FALLBACK_VIEW;
  const viewKey = JSON.stringify(view);
  const focusKey = JSON.stringify(focus);

  useEffect(() => {
    let dead = false;
    let map: MlMap | null = null;
    let loaded = false;
    let cleanup = () => {};
    (async () => {
      try {
        const [ml, worker] = await Promise.all([
          import("maplibre-gl"),
          import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
          import("maplibre-gl/dist/maplibre-gl.css"),
        ]);
        // Dev pre-bundling serves the worker with no MIME type; point at the asset URL instead.
        ml.setWorkerUrl(worker.default);
        mlRef.current = ml;
        const container = ref.current;
        if (dead || !container) return;
        map = new ml.Map({
          container,
          attributionControl: false,
          cooperativeGestures: true,
          pitch: 60,
          maxPitch: 78,
          bearing: -12,
          style: {
            version: 8,
            sources: {
              osm: { type: "raster", tiles: [TILE_URL], tileSize: 256, maxzoom: 18 },
              dem: { type: "raster-dem", tiles: [DEM_URL], tileSize: 256, maxzoom: 14, encoding: "terrarium" },
              // Same tiles twice on purpose: MapLibre advises separate sources for terrain and hillshade.
              shade: { type: "raster-dem", tiles: [DEM_URL], tileSize: 256, maxzoom: 14, encoding: "terrarium" },
              ofm: { type: "vector", url: WATER_URL },
            },
            layers: [
              { id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.25, "raster-brightness-max": 0.9 } },
              {
                id: "hills",
                type: "hillshade",
                source: "shade",
                paint: { "hillshade-exaggeration": 0.7, "hillshade-shadow-color": "#1b2b3a", "hillshade-highlight-color": "#ffffff" },
              },
            ],
            terrain: { source: "dem", exaggeration: 1.8 },
            sky: {
              "sky-color": "#6fb4ff",
              "horizon-color": "#d9ecff",
              "fog-color": "#e8f2fb",
              "sky-horizon-blend": 0.6,
              "horizon-fog-blend": 0.7,
              "fog-ground-blend": 0.35,
            },
          },
        });
        map.addControl(new ml.AttributionControl({ customAttribution: `${TILE_ATTRIBUTION} · Terrain: Mapzen / AWS Open Data · ${attribution}` }));
        map.addControl(new ml.NavigationControl({ visualizePitch: true }), "top-left");
        const loadTimer = window.setTimeout(() => !loaded && !dead && failRef.current(), props.loadTimeoutMs ?? 15000);
        // Water and relief are extras: a failed water, elevation or hillshade tile must not drop the viewer to 2D.
        map.on("error", (e) => !["ofm", "dem", "shade"].includes((e as { sourceId?: string }).sourceId ?? "") && !loaded && !dead && failRef.current());
        const popup = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
        map.on("load", () => {
          if (dead || !map) return;
          const empty = { type: "FeatureCollection" as const, features: [] };
          map.addSource("extra", { type: "geojson", data: empty });
          map.addLayer({ id: "extra", type: "circle", source: "extra", paint: { "circle-radius": 3, "circle-color": "#3a5a8c", "circle-opacity": 0.8 } });
          const widths = ["interpolate", ["exponential", 1.4], ["zoom"], 5, 0.8, 9, 2.4, 13, 7, 16, 16] as never;
          map.addLayer({ id: "lakes", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": "#3f86d6", "fill-opacity": 0.7 } });
          map.addLayer({
            id: "rivers",
            type: "line",
            source: "ofm",
            "source-layer": "waterway",
            filter: ["in", ["get", "class"], ["literal", ["river", "canal"]]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#2f7fd0", "line-width": widths, "line-opacity": 0.9 },
          });
          map.addLayer({
            id: "streams",
            type: "line",
            source: "ofm",
            "source-layer": "waterway",
            minzoom: 11,
            filter: ["in", ["get", "class"], ["literal", ["stream", "ditch", "drain"]]],
            paint: { "line-color": "#4d96e0", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 16, 4] as never, "line-opacity": 0.8 },
          });
          map.addLayer({
            id: "flow",
            type: "line",
            source: "ofm",
            "source-layer": "waterway",
            minzoom: 8,
            filter: ["in", ["get", "class"], ["literal", ["river", "canal", "stream"]]],
            paint: {
              "line-color": "#d4ecff",
              "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 0.7, 13, 3, 16, 6] as never,
              "line-opacity": 0.85,
              "line-dasharray": FLOW_FRAMES[0],
            },
          });
          map.on("mousemove", "extra", (e: MapLayerMouseEvent) => {
            const label = e.features?.[0]?.properties?.label;
            if (typeof label === "string") popup.setLngLat(e.lngLat).setText(label).addTo(map!);
          });
          map.on("mouseleave", "extra", () => popup.remove());
          const near = () => map!.getContainer().classList.toggle("map3d--near", map!.getZoom() >= DIAL_ZOOM);
          map.on("zoom", near);
          near();
          const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          let step = -1;
          let raf = 0;
          const tick = (now: number) => {
            if (dead || !map) return;
            const next = Math.floor(now / 140) % FLOW_FRAMES.length;
            if (next !== step && map.getZoom() >= 8) {
              step = next;
              map.setPaintProperty("flow", "line-dasharray", FLOW_FRAMES[next]);
            }
            raf = requestAnimationFrame(tick);
          };
          if (!still) raf = requestAnimationFrame(tick);
          cleanup = () => cancelAnimationFrame(raf);
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
      cleanup();
      setReady(false);
      mapRef.current = null;
      map?.remove();
    };
  }, [attribution]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const m of markers.current) m.remove();
    pinEls.current.clear();
    const maxRank = Math.max(2, ...points3d.map((p) => p.rank));
    markers.current = points3d
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => {
        const el = gaugePinEl(p, (p.rank + 1) / (maxRank + 1), false);
        const act = () => selectRef.current?.(p.id);
        el.addEventListener("click", act);
        el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), act()));
        el.title = p.rank >= 0 ? p.label : `${p.label} · no reading`;
        pinEls.current.set(p.id, el);
        return new mlRef.current!.Marker({ element: el, anchor: "center" }).setLngLat([p.lon, p.lat]).addTo(map);
      });
    return () => {
      for (const m of markers.current) m.remove();
      markers.current = [];
      pinEls.current.clear();
    };
  }, [ready, points3d]);

  // Selection only toggles a class, so keyboard focus and the running animations survive a select.
  useEffect(() => {
    for (const [id, el] of pinEls.current) {
      el.classList.toggle("gpin--sel", id === selectedId);
      el.setAttribute("aria-pressed", String(id === selectedId));
    }
  }, [ready, points3d, selectedId]);

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
    if (!ready || !map || focus) return; // an active focus stays
    map.fitBounds(
      [
        [view[0][1], view[0][0]],
        [view[1][1], view[1][0]],
      ],
      { padding: 40, maxZoom: 13, pitch: 55, bearing: -12, duration: 0 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewKey]);

  // Focus: fly to the gauges of the selected river at pitch 60; clearing it flies back to the full view.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const box = focus ?? (wasFocused.current ? view : null);
    wasFocused.current = !!focus;
    if (!box) return;
    map.fitBounds(
      [
        [box[0][1], box[0][0]],
        [box[1][1], box[1][0]],
      ],
      focus
        ? { padding: 60, maxZoom: 14, pitch: 60, bearing: -12, duration: 1800, essential: true }
        : { padding: 40, maxZoom: 13, pitch: 55, bearing: -12, duration: 1800, essential: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focusKey]);

  return <div ref={ref} className="leaflet-map" role="region" aria-label={`${ariaLabel} (3D view)`} />;
}
